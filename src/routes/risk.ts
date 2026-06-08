import { Router } from 'express';
import { getDb } from '../database';
import { success, error, paginate } from '../utils/response';
import { authMiddleware, AuthRequest, optionalAuthMiddleware } from '../middleware/auth';
import { config } from '../config';
import {
  CONTENT_STATUS,
  ANNOUNCEMENT_STATUS,
  REPORT_STATUS,
  REPORT_TARGET_TYPE,
  APPEAL_STATUS,
  APPEAL_TARGET_TYPE,
  MOD_LOG_TYPE,
} from '../constants';
import { addModLog, actionTypeNames, targetTypeNames } from '../utils/modLog';

const router = Router();

function isAdmin(userId: number): boolean {
  const db = getDb();
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as any;
  return user && user.role >= 2;
}

router.post('/report', authMiddleware, (req: AuthRequest, res) => {
  const { target_type, target_id, reason, description } = req.body;

  if (!target_type || isNaN(parseInt(target_type))) {
    return error(res, '请选择举报类型');
  }
  if (!target_id || isNaN(parseInt(target_id))) {
    return error(res, '无效的目标ID');
  }
  if (!reason) {
    return error(res, '请选择举报原因');
  }

  const db = getDb();
  const targetType = parseInt(target_type);
  const targetId = parseInt(target_id);

  if (targetType === 1) {
    const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(targetId);
    if (!post) return error(res, '动态不存在');
  } else if (targetType === 2) {
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
    if (!user) return error(res, '用户不存在');
  } else if (targetType === 3) {
    const comment = db.prepare('SELECT id FROM comments WHERE id = ?').get(targetId);
    if (!comment) return error(res, '评论不存在');
  }

  db.prepare(`
    INSERT INTO reports (reporter_id, target_type, target_id, reason, description)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.userId, targetType, targetId, reason, description || null);

  success(res, null, '举报提交成功，我们会尽快处理');
});

router.get('/report/list', authMiddleware, (req: AuthRequest, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;
  const status = req.query.status !== undefined ? parseInt(req.query.status as string) : null;
  const reporter_id = req.query.reporter_id ? parseInt(req.query.reporter_id as string) : null;
  const target_type = req.query.target_type ? parseInt(req.query.target_type as string) : null;
  const target_id = req.query.target_id ? parseInt(req.query.target_id as string) : null;
  const start_date = req.query.start_date as string;
  const end_date = req.query.end_date as string;
  const keyword = req.query.keyword as string;

  const db = getDb();
  if (!isAdmin(req.userId!)) return error(res, '无权限访问', 403, 403);

  const whereClauses: string[] = [];
  const params: any[] = [];

  if (status !== null) {
    whereClauses.push('r.status = ?');
    params.push(status);
  }
  if (reporter_id) {
    whereClauses.push('r.reporter_id = ?');
    params.push(reporter_id);
  }
  if (target_type) {
    whereClauses.push('r.target_type = ?');
    params.push(target_type);
  }
  if (target_id) {
    whereClauses.push('r.target_id = ?');
    params.push(target_id);
  }
  if (start_date) {
    whereClauses.push('r.created_at >= ?');
    params.push(start_date);
  }
  if (end_date) {
    whereClauses.push('r.created_at <= ?');
    params.push(end_date + ' 23:59:59');
  }
  if (keyword && keyword.trim()) {
    whereClauses.push('(r.reason LIKE ? OR r.description LIKE ? OR u.nickname LIKE ?)');
    params.push(`%${keyword.trim()}%`, `%${keyword.trim()}%`, `%${keyword.trim()}%`);
  }

  const whereClause = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

  const reports = db.prepare(`
    SELECT r.*, u.nickname as reporter_name, u.avatar as reporter_avatar
    FROM reports r
    JOIN users u ON r.reporter_id = u.id
    ${whereClause}
    ORDER BY r.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  const total = db.prepare(`SELECT COUNT(*) as count FROM reports r JOIN users u ON r.reporter_id = u.id ${whereClause}`)
    .get(...params) as any;

  success(res, paginate(reports, total.count, page, pageSize));
});

router.post('/report/handle/:id', authMiddleware, (req: AuthRequest, res) => {
  const reportId = parseInt(req.params.id);
  const { status, handle_note, action, ban_reason, ban_end_time } = req.body;

  if (isNaN(reportId)) return error(res, '无效的举报ID');
  if (status === undefined || isNaN(parseInt(status))) return error(res, '请选择处理结果');

  const db = getDb();
  if (!isAdmin(req.userId!)) return error(res, '无权限操作', 403, 403);

  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId) as any;
  if (!report) return error(res, '举报不存在');

  const statusVal = parseInt(status);
  let targetUserId: number | null = null;
  let targetSummary = '';

  if (report.target_type === REPORT_TARGET_TYPE.POST) {
    const post = db.prepare('SELECT id, user_id, content FROM posts WHERE id = ?').get(report.target_id) as any;
    if (post) {
      targetUserId = post.user_id;
      targetSummary = (post.content || '').substring(0, 50);
    }
  } else if (report.target_type === REPORT_TARGET_TYPE.COMMENT) {
    const comment = db.prepare('SELECT id, user_id, content FROM comments WHERE id = ?').get(report.target_id) as any;
    if (comment) {
      targetUserId = comment.user_id;
      targetSummary = (comment.content || '').substring(0, 50);
    }
  } else if (report.target_type === REPORT_TARGET_TYPE.USER) {
    const user = db.prepare('SELECT id, nickname FROM users WHERE id = ?').get(report.target_id) as any;
    if (user) {
      targetUserId = user.id;
      targetSummary = user.nickname || `用户#${user.id}`;
    }
  }

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE reports SET status = ?, handle_note = ?, handler_id = ?, handled_at = datetime('now')
      WHERE id = ?
    `).run(statusVal, handle_note || null, req.userId, reportId);

    if (statusVal === REPORT_STATUS.APPROVED && action) {
      if (action === 'remove' && targetUserId) {
        if (report.target_type === REPORT_TARGET_TYPE.POST) {
          db.prepare('UPDATE posts SET status = ?, review_reason = ? WHERE id = ?')
            .run(CONTENT_STATUS.REJECTED, handle_note || '举报核实后下架', report.target_id);
        } else if (report.target_type === REPORT_TARGET_TYPE.COMMENT) {
          db.prepare('UPDATE comments SET status = ?, review_reason = ? WHERE id = ?')
            .run(CONTENT_STATUS.REJECTED, handle_note || '举报核实后下架', report.target_id);
        }
        if (targetUserId) {
          db.prepare(`
            INSERT INTO notifications (user_id, type, title, content, related_id, related_type)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(targetUserId, 5, '内容被下架',
            `您的${targetTypeNames[report.target_type] || '内容'}因「${handle_note || '违反社区规范'}」被下架`,
            report.target_id, report.target_type === 1 ? 'post' : 'comment');
        }
      } else if (action === 'ban' && targetUserId) {
        db.prepare('UPDATE users SET status = 1 WHERE id = ?').run(targetUserId);
        db.prepare(`
          INSERT INTO bans (user_id, reason, end_time, handler_id, status)
          VALUES (?, ?, ?, ?, 1)
        `).run(targetUserId, ban_reason || handle_note || '举报核实后封禁', ban_end_time || null, req.userId);

        db.prepare(`
          INSERT INTO notifications (user_id, type, title, content, related_id, related_type)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(targetUserId, 5, '账号被封禁',
          `您的账号因「${ban_reason || handle_note || '违反社区规范'}」被封禁`,
          reportId, 'ban');
      }
    }

    db.prepare(`
      INSERT INTO notifications (user_id, type, title, content, related_id, related_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(report.reporter_id, 5,
      statusVal === REPORT_STATUS.APPROVED ? '举报已受理' : '举报不予受理',
      statusVal === REPORT_STATUS.APPROVED
        ? `您提交的举报已受理。${handle_note ? '处理说明：' + handle_note : ''}`
        : `您提交的举报未予受理。${handle_note ? '说明：' + handle_note : '感谢您的监督'}`,
      reportId, 'report');

    addModLog(req.userId!, MOD_LOG_TYPE.REPORT_HANDLE, report.target_type, report.target_id,
      targetSummary || `举报#${reportId}`, report.status, statusVal,
      handle_note ? handle_note + (action ? ` (动作: ${action})` : '') : (action ? `动作: ${action}` : null));
  });
  tx();

  success(res, null, '处理成功');
});

router.post('/report/batch', authMiddleware, (req: AuthRequest, res) => {
  const { ids, status, handle_note } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return error(res, '请选择要处理的举报');
  }
  if (status === undefined || isNaN(parseInt(status))) {
    return error(res, '请选择处理结果');
  }
  if (ids.length > 100) {
    return error(res, '批量处理最多100条');
  }

  const db = getDb();
  if (!isAdmin(req.userId!)) return error(res, '无权限操作', 403, 403);

  const statusVal = parseInt(status);
  const placeholders = ids.map(() => '?').join(',');

  const reports = db.prepare(`
    SELECT id FROM reports WHERE id IN (${placeholders})
  `).all(...ids) as any[];

  if (reports.length === 0) {
    return error(res, '没有找到要处理的举报');
  }

  const tx = db.transaction(() => {
    const stmt = db.prepare(`
      UPDATE reports SET status = ?, handle_note = ?, handler_id = ?, handled_at = datetime('now')
      WHERE id = ?
    `);
    for (const report of reports) {
      stmt.run(statusVal, handle_note || null, req.userId, report.id);
    }
  });
  tx();

  success(res, { count: reports.length }, `批量处理完成，共处理 ${reports.length} 条举报`);
});

router.get('/stats', authMiddleware, (req: AuthRequest, res) => {
  const db = getDb();
  if (!isAdmin(req.userId!)) return error(res, '无权限访问', 403, 403);

  const pendingPosts = db.prepare('SELECT COUNT(*) as count FROM posts WHERE status = ?')
    .get(CONTENT_STATUS.PENDING) as any;
  const pendingComments = db.prepare('SELECT COUNT(*) as count FROM comments WHERE status = ?')
    .get(CONTENT_STATUS.PENDING) as any;
  const pendingReports = db.prepare('SELECT COUNT(*) as count FROM reports WHERE status = 0')
    .get() as any;
  const pendingAppeals = db.prepare('SELECT COUNT(*) as count FROM appeals WHERE status = ?')
    .get(APPEAL_STATUS.PENDING) as any;
  const rejectedPosts = db.prepare('SELECT COUNT(*) as count FROM posts WHERE status = ?')
    .get(CONTENT_STATUS.REJECTED) as any;
  const rejectedComments = db.prepare('SELECT COUNT(*) as count FROM comments WHERE status = ?')
    .get(CONTENT_STATUS.REJECTED) as any;
  const approvedToday = db.prepare(`SELECT COUNT(*) as count FROM posts WHERE status = ? AND updated_at >= datetime('now', '-1 day')`)
    .get(CONTENT_STATUS.APPROVED) as any;

  success(res, {
    pending_posts: pendingPosts.count,
    pending_comments: pendingComments.count,
    pending_reports: pendingReports.count,
    pending_appeals: pendingAppeals.count,
    rejected_posts: rejectedPosts.count,
    rejected_comments: rejectedComments.count,
    approved_today: approvedToday.count,
  });
});

router.get('/todo', authMiddleware, (req: AuthRequest, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const itemType = req.query.type as string || 'all';
  const status = req.query.status !== undefined ? parseInt(req.query.status as string) : null;
  const user_id = req.query.user_id ? parseInt(req.query.user_id as string) : null;
  const target_type = req.query.target_type ? parseInt(req.query.target_type as string) : null;
  const target_id = req.query.target_id ? parseInt(req.query.target_id as string) : null;
  const start_date = req.query.start_date as string;
  const end_date = req.query.end_date as string;
  const keyword = req.query.keyword as string;

  const db = getDb();
  if (!isAdmin(req.userId!)) return error(res, '无权限访问', 403, 403);

  const allItems: any[] = [];

  if (itemType === 'all' || itemType === 'post') {
    const postWhere: string[] = [];
    const postParams: any[] = [];
    if (status !== null) { postWhere.push('p.status = ?'); postParams.push(status); }
    if (user_id) { postWhere.push('p.user_id = ?'); postParams.push(user_id); }
    if (start_date) { postWhere.push('p.created_at >= ?'); postParams.push(start_date); }
    if (end_date) { postWhere.push('p.created_at <= ?'); postParams.push(end_date + ' 23:59:59'); }
    if (keyword && keyword.trim()) { postWhere.push('p.content LIKE ?'); postParams.push(`%${keyword.trim()}%`); }
    const postWhereSql = postWhere.length > 0 ? 'WHERE ' + postWhere.join(' AND ') : '';

    const posts = db.prepare(`
      SELECT p.id, p.user_id, p.content, p.status, p.created_at, p.images,
             u.username, u.nickname, u.avatar
      FROM posts p
      JOIN users u ON p.user_id = u.id
      ${postWhereSql}
      ORDER BY p.created_at DESC
    `).all(...postParams) as any[];

    for (const post of posts) {
      let contentPreview = post.content || '';
      if (post.images && typeof post.images === 'string') {
        try {
          const imgs = JSON.parse(post.images);
          if (imgs && imgs.length > 0) {
            contentPreview = contentPreview || `[${imgs.length}张图片]`;
          }
        } catch (e) {}
      }
      allItems.push({
        id: post.id,
        item_type: 'post',
        type_name: '动态',
        content: contentPreview.substring(0, 100),
        status: post.status,
        status_text: post.status === 0 ? '已通过' : post.status === 1 ? '待审核' : '已拒绝',
        user_id: post.user_id,
        username: post.username,
        nickname: post.nickname,
        avatar: post.avatar,
        created_at: post.created_at,
        extra: { target_type: 1, target_id: post.id },
      });
    }
  }

  if (itemType === 'all' || itemType === 'comment') {
    const commentWhere: string[] = [];
    const commentParams: any[] = [];
    if (status !== null) { commentWhere.push('c.status = ?'); commentParams.push(status); }
    if (user_id) { commentWhere.push('c.user_id = ?'); commentParams.push(user_id); }
    if (target_type && target_type === 1 && target_id) {
      commentWhere.push('c.post_id = ?'); commentParams.push(target_id);
    }
    if (start_date) { commentWhere.push('c.created_at >= ?'); commentParams.push(start_date); }
    if (end_date) { commentWhere.push('c.created_at <= ?'); commentParams.push(end_date + ' 23:59:59'); }
    if (keyword && keyword.trim()) { commentWhere.push('c.content LIKE ?'); commentParams.push(`%${keyword.trim()}%`); }
    const commentWhereSql = commentWhere.length > 0 ? 'WHERE ' + commentWhere.join(' AND ') : '';

    const comments = db.prepare(`
      SELECT c.id, c.user_id, c.content, c.status, c.created_at, c.post_id,
             u.username, u.nickname, u.avatar,
             p.content as post_content_preview
      FROM comments c
      JOIN users u ON c.user_id = u.id
      LEFT JOIN posts p ON c.post_id = p.id
      ${commentWhereSql}
      ORDER BY c.created_at DESC
    `).all(...commentParams) as any[];

    for (const comment of comments) {
      allItems.push({
        id: comment.id,
        item_type: 'comment',
        type_name: '评论',
        content: (comment.content || '').substring(0, 100),
        status: comment.status,
        status_text: comment.status === 0 ? '已通过' : comment.status === 1 ? '待审核' : '已拒绝',
        user_id: comment.user_id,
        username: comment.username,
        nickname: comment.nickname,
        avatar: comment.avatar,
        created_at: comment.created_at,
        extra: {
          target_type: 3,
          target_id: comment.id,
          post_id: comment.post_id,
          post_content_preview: (comment.post_content_preview || '').substring(0, 50),
        },
      });
    }
  }

  if (itemType === 'all' || itemType === 'report') {
    const reportWhere: string[] = [];
    const reportParams: any[] = [];
    if (status !== null) { reportWhere.push('r.status = ?'); reportParams.push(status); }
    if (user_id) { reportWhere.push('r.reporter_id = ?'); reportParams.push(user_id); }
    if (target_type) { reportWhere.push('r.target_type = ?'); reportParams.push(target_type); }
    if (target_id) { reportWhere.push('r.target_id = ?'); reportParams.push(target_id); }
    if (start_date) { reportWhere.push('r.created_at >= ?'); reportParams.push(start_date); }
    if (end_date) { reportWhere.push('r.created_at <= ?'); reportParams.push(end_date + ' 23:59:59'); }
    if (keyword && keyword.trim()) {
      reportWhere.push('(r.reason LIKE ? OR r.description LIKE ? OR u.nickname LIKE ?)');
      reportParams.push(`%${keyword.trim()}%`, `%${keyword.trim()}%`, `%${keyword.trim()}%`);
    }
    const reportWhereSql = reportWhere.length > 0 ? 'WHERE ' + reportWhere.join(' AND ') : '';

    const reports = db.prepare(`
      SELECT r.id, r.reporter_id, r.reason, r.description, r.status, r.created_at,
             r.target_type, r.target_id,
             u.nickname as reporter_name, u.avatar as reporter_avatar
      FROM reports r
      JOIN users u ON r.reporter_id = u.id
      ${reportWhereSql}
      ORDER BY r.created_at DESC
    `).all(...reportParams) as any[];

    for (const report of reports) {
      allItems.push({
        id: report.id,
        item_type: 'report',
        type_name: '举报',
        content: report.reason + (report.description ? '：' + report.description : ''),
        status: report.status,
        status_text: report.status === 0 ? '待处理' : report.status === 1 ? '已通过' : '已拒绝',
        user_id: report.reporter_id,
        username: report.reporter_name,
        nickname: report.reporter_name,
        avatar: report.reporter_avatar,
        created_at: report.created_at,
        extra: {
          target_type: report.target_type,
          target_type_name: targetTypeNames[report.target_type] || '未知',
          target_id: report.target_id,
        },
      });
    }
  }

  if (itemType === 'all' || itemType === 'appeal') {
    const appealWhere: string[] = [];
    const appealParams: any[] = [];
    if (status !== null) { appealWhere.push('a.status = ?'); appealParams.push(status); }
    if (user_id) { appealWhere.push('a.user_id = ?'); appealParams.push(user_id); }
    if (target_type) { appealWhere.push('a.target_type = ?'); appealParams.push(target_type); }
    if (target_id) { appealWhere.push('a.target_id = ?'); appealParams.push(target_id); }
    if (start_date) { appealWhere.push('a.created_at >= ?'); appealParams.push(start_date); }
    if (end_date) { appealWhere.push('a.created_at <= ?'); appealParams.push(end_date + ' 23:59:59'); }
    if (keyword && keyword.trim()) {
      appealWhere.push('(a.reason LIKE ? OR a.description LIKE ? OR u.nickname LIKE ?)');
      appealParams.push(`%${keyword.trim()}%`, `%${keyword.trim()}%`, `%${keyword.trim()}%`);
    }
    const appealWhereSql = appealWhere.length > 0 ? 'WHERE ' + appealWhere.join(' AND ') : '';

    const appeals = db.prepare(`
      SELECT a.id, a.user_id, a.reason, a.description, a.status, a.created_at,
             a.target_type, a.target_id,
             u.nickname as user_nickname, u.avatar as user_avatar
      FROM appeals a
      JOIN users u ON a.user_id = u.id
      ${appealWhereSql}
      ORDER BY a.created_at DESC
    `).all(...appealParams) as any[];

    for (const appeal of appeals) {
      allItems.push({
        id: appeal.id,
        item_type: 'appeal',
        type_name: '申诉',
        content: appeal.reason + (appeal.description ? '：' + appeal.description : ''),
        status: appeal.status,
        status_text: appeal.status === 0 ? '待处理' : appeal.status === 1 ? '申诉通过' : '申诉驳回',
        user_id: appeal.user_id,
        username: appeal.user_nickname,
        nickname: appeal.user_nickname,
        avatar: appeal.user_avatar,
        created_at: appeal.created_at,
        extra: {
          target_type: appeal.target_type,
          target_type_name: appeal.target_type === 1 ? '动态' : '评论',
          target_id: appeal.target_id,
        },
      });
    }
  }

  allItems.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const total = allItems.length;
  const offset = (page - 1) * pageSize;
  const list = allItems.slice(offset, offset + pageSize);

  success(res, paginate(list, total, page, pageSize));
});

router.get('/posts', authMiddleware, (req: AuthRequest, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;
  const status = req.query.status !== undefined ? parseInt(req.query.status as string) : null;
  const keyword = req.query.keyword as string;
  const user_id = req.query.user_id ? parseInt(req.query.user_id as string) : null;
  const start_date = req.query.start_date as string;
  const end_date = req.query.end_date as string;

  const db = getDb();
  if (!isAdmin(req.userId!)) return error(res, '无权限访问', 403, 403);

  const whereClauses: string[] = [];
  const params: any[] = [];

  if (status !== null) {
    whereClauses.push('p.status = ?');
    params.push(status);
  }
  if (keyword && keyword.trim()) {
    whereClauses.push('p.content LIKE ?');
    params.push(`%${keyword.trim()}%`);
  }
  if (user_id) {
    whereClauses.push('p.user_id = ?');
    params.push(user_id);
  }
  if (start_date) {
    whereClauses.push('p.created_at >= ?');
    params.push(start_date);
  }
  if (end_date) {
    whereClauses.push('p.created_at <= ?');
    params.push(end_date + ' 23:59:59');
  }

  const whereClause = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

  const posts = db.prepare(`
    SELECT p.*, u.username, u.nickname, u.avatar
    FROM posts p
    JOIN users u ON p.user_id = u.id
    ${whereClause}
    ORDER BY p.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset) as any[];

  posts.forEach(post => {
    if (post.images && typeof post.images === 'string') {
      post.images = JSON.parse(post.images);
    }
  });

  const total = db.prepare(`SELECT COUNT(*) as count FROM posts p ${whereClause}`).get(...params) as any;

  success(res, paginate(posts, total.count, page, pageSize));
});

router.post('/review/post/:postId', authMiddleware, (req: AuthRequest, res) => {
  const postId = parseInt(req.params.postId);
  const { status, review_reason } = req.body;

  if (isNaN(postId)) return error(res, '无效的动态ID');
  if (status === undefined || isNaN(parseInt(status))) return error(res, '请选择审核结果');

  const db = getDb();
  if (!isAdmin(req.userId!)) return error(res, '无权限操作', 403, 403);

  const post = db.prepare('SELECT id, user_id FROM posts WHERE id = ?').get(postId) as any;
  if (!post) return error(res, '动态不存在');

  const statusVal = parseInt(status);

  const tx = db.transaction(() => {
    db.prepare('UPDATE posts SET status = ?, review_reason = ? WHERE id = ?')
      .run(statusVal, review_reason || null, postId);

    if (statusVal === CONTENT_STATUS.REJECTED) {
      db.prepare(`
        INSERT INTO notifications (user_id, type, title, content, related_id, related_type)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        post.user_id,
        5,
        '动态审核未通过',
        `您的动态因「${review_reason || '违反社区规范'}」未通过审核`,
        postId,
        'post'
      );
    } else if (statusVal === CONTENT_STATUS.APPROVED) {
      db.prepare(`
        INSERT INTO notifications (user_id, type, title, content, related_id, related_type)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(post.user_id, 5, '动态审核通过', '您的动态已通过审核', postId, 'post');
    }
  });
  tx();

  success(res, null, '审核完成');
});

router.post('/review/posts/batch', authMiddleware, (req: AuthRequest, res) => {
  const { ids, status, review_reason } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return error(res, '请选择要审核的动态');
  }
  if (status === undefined || isNaN(parseInt(status))) {
    return error(res, '请选择审核结果');
  }
  if (ids.length > 100) {
    return error(res, '批量审核最多100条');
  }

  const db = getDb();
  if (!isAdmin(req.userId!)) return error(res, '无权限操作', 403, 403);

  const statusVal = parseInt(status);
  const placeholders = ids.map(() => '?').join(',');

  const posts = db.prepare(`
    SELECT id, user_id FROM posts WHERE id IN (${placeholders})
  `).all(...ids) as any[];

  if (posts.length === 0) {
    return error(res, '没有找到要审核的动态');
  }

  const tx = db.transaction(() => {
    const updateStmt = db.prepare('UPDATE posts SET status = ?, review_reason = ? WHERE id = ?');
    const notifStmt = db.prepare(`
      INSERT INTO notifications (user_id, type, title, content, related_id, related_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const post of posts) {
      updateStmt.run(statusVal, review_reason || null, post.id);

      if (statusVal === CONTENT_STATUS.REJECTED) {
        notifStmt.run(
          post.user_id,
          5,
          '动态审核未通过',
          `您的动态因「${review_reason || '违反社区规范'}」未通过审核`,
          post.id,
          'post'
        );
      } else if (statusVal === CONTENT_STATUS.APPROVED) {
        notifStmt.run(post.user_id, 5, '动态审核通过', '您的动态已通过审核', post.id, 'post');
      }
    }
  });
  tx();

  success(res, { count: posts.length }, `批量审核完成，共处理 ${posts.length} 条动态`);
});

router.get('/comments', authMiddleware, (req: AuthRequest, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;
  const status = req.query.status !== undefined ? parseInt(req.query.status as string) : null;
  const keyword = req.query.keyword as string;
  const user_id = req.query.user_id ? parseInt(req.query.user_id as string) : null;
  const post_id = req.query.post_id ? parseInt(req.query.post_id as string) : null;
  const start_date = req.query.start_date as string;
  const end_date = req.query.end_date as string;

  const db = getDb();
  if (!isAdmin(req.userId!)) return error(res, '无权限访问', 403, 403);

  const whereClauses: string[] = [];
  const params: any[] = [];

  if (status !== null) {
    whereClauses.push('c.status = ?');
    params.push(status);
  }
  if (keyword && keyword.trim()) {
    whereClauses.push('c.content LIKE ?');
    params.push(`%${keyword.trim()}%`);
  }
  if (user_id) {
    whereClauses.push('c.user_id = ?');
    params.push(user_id);
  }
  if (post_id) {
    whereClauses.push('c.post_id = ?');
    params.push(post_id);
  }
  if (start_date) {
    whereClauses.push('c.created_at >= ?');
    params.push(start_date);
  }
  if (end_date) {
    whereClauses.push('c.created_at <= ?');
    params.push(end_date + ' 23:59:59');
  }

  const whereClause = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

  const comments = db.prepare(`
    SELECT c.*, u.username, u.nickname, u.avatar, p.content as post_content_preview
    FROM comments c
    JOIN users u ON c.user_id = u.id
    LEFT JOIN posts p ON c.post_id = p.id
    ${whereClause}
    ORDER BY c.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  const total = db.prepare(`SELECT COUNT(*) as count FROM comments c ${whereClause}`).get(...params) as any;

  success(res, paginate(comments, total.count, page, pageSize));
});

router.post('/review/comment/:commentId', authMiddleware, (req: AuthRequest, res) => {
  const commentId = parseInt(req.params.commentId);
  const { status, review_reason } = req.body;

  if (isNaN(commentId)) return error(res, '无效的评论ID');
  if (status === undefined || isNaN(parseInt(status))) return error(res, '请选择审核结果');

  const db = getDb();
  if (!isAdmin(req.userId!)) return error(res, '无权限操作', 403, 403);

  const comment = db.prepare('SELECT id, user_id FROM comments WHERE id = ?').get(commentId) as any;
  if (!comment) return error(res, '评论不存在');

  const statusVal = parseInt(status);

  const tx = db.transaction(() => {
    db.prepare('UPDATE comments SET status = ?, review_reason = ? WHERE id = ?')
      .run(statusVal, review_reason || null, commentId);

    if (statusVal === CONTENT_STATUS.REJECTED) {
      db.prepare(`
        INSERT INTO notifications (user_id, type, title, content, related_id, related_type)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        comment.user_id,
        5,
        '评论审核未通过',
        `您的评论因「${review_reason || '违反社区规范'}」未通过审核`,
        commentId,
        'comment'
      );
    } else if (statusVal === CONTENT_STATUS.APPROVED) {
      db.prepare(`
        INSERT INTO notifications (user_id, type, title, content, related_id, related_type)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(comment.user_id, 5, '评论审核通过', '您的评论已通过审核', commentId, 'comment');
    }
  });
  tx();

  success(res, null, '审核完成');
});

router.post('/review/comments/batch', authMiddleware, (req: AuthRequest, res) => {
  const { ids, status, review_reason } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return error(res, '请选择要审核的评论');
  }
  if (status === undefined || isNaN(parseInt(status))) {
    return error(res, '请选择审核结果');
  }
  if (ids.length > 100) {
    return error(res, '批量审核最多100条');
  }

  const db = getDb();
  if (!isAdmin(req.userId!)) return error(res, '无权限操作', 403, 403);

  const statusVal = parseInt(status);
  const placeholders = ids.map(() => '?').join(',');

  const comments = db.prepare(`
    SELECT id, user_id FROM comments WHERE id IN (${placeholders})
  `).all(...ids) as any[];

  if (comments.length === 0) {
    return error(res, '没有找到要审核的评论');
  }

  const tx = db.transaction(() => {
    const updateStmt = db.prepare('UPDATE comments SET status = ?, review_reason = ? WHERE id = ?');
    const notifStmt = db.prepare(`
      INSERT INTO notifications (user_id, type, title, content, related_id, related_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const comment of comments) {
      updateStmt.run(statusVal, review_reason || null, comment.id);

      if (statusVal === CONTENT_STATUS.REJECTED) {
        notifStmt.run(
          comment.user_id,
          5,
          '评论审核未通过',
          `您的评论因「${review_reason || '违反社区规范'}」未通过审核`,
          comment.id,
          'comment'
        );
      } else if (statusVal === CONTENT_STATUS.APPROVED) {
        notifStmt.run(comment.user_id, 5, '评论审核通过', '您的评论已通过审核', comment.id, 'comment');
      }
    }
  });
  tx();

  success(res, { count: comments.length }, `批量审核完成，共处理 ${comments.length} 条评论`);
});

router.post('/review/batch', authMiddleware, (req: AuthRequest, res) => {
  const { items, status, review_reason } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return error(res, '请选择要处理的内容');
  }
  if (status === undefined || isNaN(parseInt(status))) {
    return error(res, '请选择处理结果');
  }
  if (items.length > 200) {
    return error(res, '批量处理最多200条');
  }

  const db = getDb();
  if (!isAdmin(req.userId!)) return error(res, '无权限操作', 403, 403);

  const statusVal = parseInt(status);
  const results = {
    post: { success: 0, failed: [] as any[] },
    comment: { success: 0, failed: [] as any[] },
    report: { success: 0, failed: [] as any[] },
  };

  const tx = db.transaction(() => {
    const postUpdate = db.prepare('UPDATE posts SET status = ?, review_reason = ? WHERE id = ?');
    const commentUpdate = db.prepare('UPDATE comments SET status = ?, review_reason = ? WHERE id = ?');
    const reportUpdate = db.prepare(`UPDATE reports SET status = ?, handle_note = ?, handler_id = ?, handled_at = datetime('now') WHERE id = ?`);
    const notifStmt = db.prepare(`
      INSERT INTO notifications (user_id, type, title, content, related_id, related_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const item of items) {
      const itemType = item.type || item.item_type;
      const itemId = item.id;

      if (!itemType || !itemId) {
        if (results.post && itemType === 'post') results.post.failed.push({ id: itemId, reason: '参数不完整' });
        else if (results.comment && itemType === 'comment') results.comment.failed.push({ id: itemId, reason: '参数不完整' });
        else if (results.report && itemType === 'report') results.report.failed.push({ id: itemId, reason: '参数不完整' });
        continue;
      }

      try {
        if (itemType === 'post') {
          const post = db.prepare('SELECT id, user_id, status, content FROM posts WHERE id = ?').get(itemId) as any;
          if (!post) {
            results.post.failed.push({ id: itemId, reason: '动态不存在' });
            continue;
          }
          const oldStatus = post.status;
          postUpdate.run(statusVal, review_reason || null, itemId);
          results.post.success++;

          const summary = (post.content || '').substring(0, 50);
          addModLog(req.userId!, MOD_LOG_TYPE.POST_REVIEW, 1, itemId, summary, oldStatus, statusVal, review_reason || null);

          if (statusVal === CONTENT_STATUS.REJECTED) {
            notifStmt.run(post.user_id, 5, '动态审核未通过', `您的动态因「${review_reason || '违反社区规范'}」未通过审核`, itemId, 'post');
          } else if (statusVal === CONTENT_STATUS.APPROVED) {
            notifStmt.run(post.user_id, 5, '动态审核通过', '您的动态已通过审核', itemId, 'post');
          }
        } else if (itemType === 'comment') {
          const comment = db.prepare('SELECT id, user_id, status, content FROM comments WHERE id = ?').get(itemId) as any;
          if (!comment) {
            results.comment.failed.push({ id: itemId, reason: '评论不存在' });
            continue;
          }
          const oldStatus = comment.status;
          commentUpdate.run(statusVal, review_reason || null, itemId);
          results.comment.success++;

          const summary = (comment.content || '').substring(0, 50);
          addModLog(req.userId!, MOD_LOG_TYPE.COMMENT_REVIEW, 3, itemId, summary, oldStatus, statusVal, review_reason || null);

          if (statusVal === CONTENT_STATUS.REJECTED) {
            notifStmt.run(comment.user_id, 5, '评论审核未通过', `您的评论因「${review_reason || '违反社区规范'}」未通过审核`, itemId, 'comment');
          } else if (statusVal === CONTENT_STATUS.APPROVED) {
            notifStmt.run(comment.user_id, 5, '评论审核通过', '您的评论已通过审核', itemId, 'comment');
          }
        } else if (itemType === 'report') {
          const report = db.prepare('SELECT id, status, target_type, target_id FROM reports WHERE id = ?').get(itemId) as any;
          if (!report) {
            results.report.failed.push({ id: itemId, reason: '举报不存在' });
            continue;
          }
          const oldStatus = report.status;
          const reportStatus = statusVal === CONTENT_STATUS.APPROVED ? REPORT_STATUS.APPROVED :
                              statusVal === CONTENT_STATUS.REJECTED ? REPORT_STATUS.REJECTED : statusVal;
          reportUpdate.run(reportStatus, review_reason || null, req.userId, itemId);
          results.report.success++;

          addModLog(req.userId!, MOD_LOG_TYPE.REPORT_HANDLE, report.target_type, itemId, `举报#${itemId}`, oldStatus, reportStatus, review_reason || null);
        } else {
          results.post.failed.push({ id: itemId, reason: '未知类型' });
        }
      } catch (e: any) {
        const typeKey = itemType as keyof typeof results;
        if (results[typeKey]) {
          results[typeKey].failed.push({ id: itemId, reason: e.message || '处理失败' });
        }
      }
    }
  });
  tx();

  const totalSuccess = results.post.success + results.comment.success + results.report.success;
  const totalFailed = results.post.failed.length + results.comment.failed.length + results.report.failed.length;

  success(res, {
    total: items.length,
    success: totalSuccess,
    failed: totalFailed,
    detail: {
      post: results.post,
      comment: results.comment,
      report: results.report,
    },
  }, `批量处理完成，成功${totalSuccess}条，失败${totalFailed}条`);
});

router.post('/ban/user/:userId', authMiddleware, (req: AuthRequest, res) => {
  const userId = parseInt(req.params.userId);
  const { reason, end_time } = req.body;

  if (isNaN(userId)) return error(res, '无效的用户ID');

  const db = getDb();
  if (!isAdmin(req.userId!)) return error(res, '无权限操作', 403, 403);

  const user = db.prepare('SELECT id, nickname, status FROM users WHERE id = ?').get(userId) as any;
  if (!user) return error(res, '用户不存在');

  const oldStatus = user.status;
  db.prepare('UPDATE users SET status = 1 WHERE id = ?').run(userId);
  db.prepare(`
    INSERT INTO bans (user_id, reason, end_time, handler_id, status)
    VALUES (?, ?, ?, ?, 1)
  `).run(userId, reason || null, end_time || null, req.userId);

  addModLog(req.userId!, MOD_LOG_TYPE.USER_BAN, 2, userId, user.nickname || `用户#${userId}`, oldStatus, 1, reason || null);

  success(res, null, '封禁成功');
});

router.post('/unban/user/:userId', authMiddleware, (req: AuthRequest, res) => {
  const userId = parseInt(req.params.userId);

  if (isNaN(userId)) return error(res, '无效的用户ID');

  const db = getDb();
  if (!isAdmin(req.userId!)) return error(res, '无权限操作', 403, 403);

  const user = db.prepare('SELECT id, nickname, status FROM users WHERE id = ?').get(userId) as any;
  if (!user) return error(res, '用户不存在');

  const oldStatus = user.status;
  db.prepare('UPDATE users SET status = 0 WHERE id = ?').run(userId);
  db.prepare('UPDATE bans SET status = 0 WHERE user_id = ? AND status = 1').run(userId);

  addModLog(req.userId!, MOD_LOG_TYPE.USER_UNBAN, 2, userId, user.nickname || `用户#${userId}`, oldStatus, 0, null);

  success(res, null, '解封成功');
});

router.get('/bans', authMiddleware, (req: AuthRequest, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;

  const db = getDb();
  if (!isAdmin(req.userId!)) return error(res, '无权限访问', 403, 403);

  const bans = db.prepare(`
    SELECT b.*, u.username, u.nickname, u.avatar
    FROM bans b
    JOIN users u ON b.user_id = u.id
    ORDER BY b.created_at DESC
    LIMIT ? OFFSET ?
  `).all(pageSize, offset);

  const total = db.prepare('SELECT COUNT(*) as count FROM bans').get() as any;

  success(res, paginate(bans, total.count, page, pageSize));
});

router.post('/announcement', authMiddleware, (req: AuthRequest, res) => {
  const { title, content, type, status } = req.body;

  if (!title || !title.trim()) return error(res, '公告标题不能为空');

  const db = getDb();
  if (!isAdmin(req.userId!)) return error(res, '无权限操作', 403, 403);

  const statusVal = status !== undefined ? parseInt(status) : ANNOUNCEMENT_STATUS.PUBLISHED;

  const result = db.prepare(`
    INSERT INTO announcements (title, content, type, status, publisher_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(title.trim(), content || null, type || 0, statusVal, req.userId);

  success(res, { id: result.lastInsertRowid }, '公告创建成功');
});

router.put('/announcement/:id', authMiddleware, (req: AuthRequest, res) => {
  const id = parseInt(req.params.id);
  const { title, content, type, status } = req.body;

  if (isNaN(id)) return error(res, '无效的公告ID');

  const db = getDb();
  if (!isAdmin(req.userId!)) return error(res, '无权限操作', 403, 403);

  const announcement = db.prepare('SELECT id FROM announcements WHERE id = ?').get(id);
  if (!announcement) return error(res, '公告不存在');

  const fields: string[] = [];
  const params: any[] = [];

  if (title !== undefined) {
    fields.push('title = ?');
    params.push(title.trim());
  }
  if (content !== undefined) {
    fields.push('content = ?');
    params.push(content);
  }
  if (type !== undefined) {
    fields.push('type = ?');
    params.push(type);
  }
  if (status !== undefined) {
    fields.push('status = ?');
    params.push(parseInt(status));
  }

  if (fields.length === 0) {
    return error(res, '没有需要更新的字段');
  }

  params.push(id);
  db.prepare(`UPDATE announcements SET ${fields.join(', ')} WHERE id = ?`).run(...params);

  success(res, null, '公告更新成功');
});

router.delete('/announcement/:id', authMiddleware, (req: AuthRequest, res) => {
  const id = parseInt(req.params.id);

  if (isNaN(id)) return error(res, '无效的公告ID');

  const db = getDb();
  if (!isAdmin(req.userId!)) return error(res, '无权限操作', 403, 403);

  const result = db.prepare('DELETE FROM announcements WHERE id = ?').run(id);
  if (result.changes === 0) return error(res, '公告不存在');

  success(res, null, '公告删除成功');
});

router.post('/announcement/:id/status', authMiddleware, (req: AuthRequest, res) => {
  const id = parseInt(req.params.id);
  const { status } = req.body;

  if (isNaN(id)) return error(res, '无效的公告ID');
  if (status === undefined || isNaN(parseInt(status))) return error(res, '请选择状态');

  const db = getDb();
  if (!isAdmin(req.userId!)) return error(res, '无权限操作', 403, 403);

  const announcement = db.prepare('SELECT id, title, status FROM announcements WHERE id = ?').get(id) as any;
  if (!announcement) return error(res, '公告不存在');

  const oldStatus = announcement.status;
  const newStatus = parseInt(status);
  db.prepare('UPDATE announcements SET status = ? WHERE id = ?').run(newStatus, id);

  let actionType: number = MOD_LOG_TYPE.ANNOUNCEMENT_PUBLISH;
  if (newStatus === ANNOUNCEMENT_STATUS.OFFLINE || newStatus === ANNOUNCEMENT_STATUS.DRAFT) {
    actionType = MOD_LOG_TYPE.ANNOUNCEMENT_OFFLINE;
  }
  addModLog(req.userId!, actionType, 0, id, announcement.title || `公告#${id}`, oldStatus, newStatus, null);

  success(res, null, '状态更新成功');
});

router.get('/announcements', optionalAuthMiddleware, (req: AuthRequest, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;
  const status = req.query.status !== undefined ? parseInt(req.query.status as string) : null;

  const db = getDb();
  const isAdminUser = req.userId && isAdmin(req.userId);

  const whereClauses: string[] = [];
  const params: any[] = [];

  if (!isAdminUser) {
    whereClauses.push('a.status = ?');
    params.push(ANNOUNCEMENT_STATUS.PUBLISHED);
  } else if (status !== null) {
    whereClauses.push('a.status = ?');
    params.push(status);
  }

  const whereClause = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

  const announcements = db.prepare(`
    SELECT a.*, u.nickname as publisher_name
    FROM announcements a
    LEFT JOIN users u ON a.publisher_id = u.id
    ${whereClause}
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  const total = db.prepare(`SELECT COUNT(*) as count FROM announcements a ${whereClause}`)
    .get(...params) as any;

  success(res, paginate(announcements, total.count, page, pageSize));
});

router.get('/announcement/:id', optionalAuthMiddleware, (req: AuthRequest, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return error(res, '无效的公告ID');

  const db = getDb();
  const announcement = db.prepare(`
    SELECT a.*, u.nickname as publisher_name
    FROM announcements a
    LEFT JOIN users u ON a.publisher_id = u.id
    WHERE a.id = ?
  `).get(id) as any;

  if (!announcement) return error(res, '公告不存在', 404, 404);

  const isAdminUser = req.userId && isAdmin(req.userId);
  if (!isAdminUser && announcement.status !== ANNOUNCEMENT_STATUS.PUBLISHED) {
    return error(res, '公告不存在', 404, 404);
  }

  success(res, announcement);
});

router.post('/recount/follows', authMiddleware, (req: AuthRequest, res) => {
  const db = getDb();
  if (!isAdmin(req.userId!)) return error(res, '无权限操作', 403, 403);

  const tx = db.transaction(() => {
    const userIds = db.prepare('SELECT id FROM users').all() as any[];

    for (const user of userIds) {
      const followerCount = db.prepare('SELECT COUNT(*) as count FROM follows WHERE following_id = ?')
        .get(user.id) as any;
      const followingCount = db.prepare('SELECT COUNT(*) as count FROM follows WHERE follower_id = ?')
        .get(user.id) as any;

      db.prepare('UPDATE users SET follower_count = ?, following_count = ? WHERE id = ?')
        .run(followerCount.count, followingCount.count, user.id);
    }

    const postCounts = db.prepare(`
      SELECT user_id, COUNT(*) as count FROM posts WHERE status = ? GROUP BY user_id
    `).all(CONTENT_STATUS.APPROVED) as any[];

    db.prepare('UPDATE users SET post_count = 0').run();
    for (const row of postCounts) {
      db.prepare('UPDATE users SET post_count = ? WHERE id = ?').run(row.count, row.user_id);
    }
  });
  tx();

  const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get() as any;
  success(res, { user_count: totalUsers.count }, '关注计数和动态计数已重新校准');
});

router.get('/logs', authMiddleware, (req: AuthRequest, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;
  const operator_id = req.query.operator_id ? parseInt(req.query.operator_id as string) : null;
  const action_type = req.query.action_type ? parseInt(req.query.action_type as string) : null;
  const target_type = req.query.target_type ? parseInt(req.query.target_type as string) : null;
  const target_id = req.query.target_id ? parseInt(req.query.target_id as string) : null;
  const start_date = req.query.start_date as string;
  const end_date = req.query.end_date as string;

  const db = getDb();
  if (!isAdmin(req.userId!)) return error(res, '无权限访问', 403, 403);

  const whereClauses: string[] = [];
  const params: any[] = [];

  if (operator_id) {
    whereClauses.push('m.operator_id = ?');
    params.push(operator_id);
  }
  if (action_type) {
    whereClauses.push('m.action_type = ?');
    params.push(action_type);
  }
  if (target_type !== null && target_type !== undefined) {
    whereClauses.push('m.target_type = ?');
    params.push(target_type);
  }
  if (target_id) {
    whereClauses.push('m.target_id = ?');
    params.push(target_id);
  }
  if (start_date) {
    whereClauses.push('m.created_at >= ?');
    params.push(start_date);
  }
  if (end_date) {
    whereClauses.push('m.created_at <= ?');
    params.push(end_date + ' 23:59:59');
  }

  const whereClause = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

  const logs = db.prepare(`
    SELECT m.*, u.nickname as operator_name, u.avatar as operator_avatar
    FROM moderation_logs m
    JOIN users u ON m.operator_id = u.id
    ${whereClause}
    ORDER BY m.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset) as any[];

  for (const log of logs) {
    log.action_type_name = actionTypeNames[log.action_type] || `未知(${log.action_type})`;
    log.target_type_name = targetTypeNames[log.target_type] !== undefined ? targetTypeNames[log.target_type] : (log.target_type === 0 ? '公告' : `未知(${log.target_type})`);
  }

  const total = db.prepare(`SELECT COUNT(*) as count FROM moderation_logs m ${whereClause}`).get(...params) as any;

  success(res, paginate(logs, total.count, page, pageSize));
});

router.post('/appeal', authMiddleware, (req: AuthRequest, res) => {
  const { target_type, target_id, reason, description } = req.body;

  if (!target_type || isNaN(parseInt(target_type))) {
    return error(res, '请选择申诉类型');
  }
  if (!target_id || isNaN(parseInt(target_id))) {
    return error(res, '无效的目标ID');
  }
  if (!reason || !reason.trim()) {
    return error(res, '请填写申诉理由');
  }

  const db = getDb();
  const targetType = parseInt(target_type);
  const targetId = parseInt(target_id);
  let targetUserId = 0;

  if (targetType === APPEAL_TARGET_TYPE.POST) {
    const post = db.prepare('SELECT id, user_id, status FROM posts WHERE id = ?').get(targetId) as any;
    if (!post) return error(res, '动态不存在');
    if (post.status !== CONTENT_STATUS.REJECTED) return error(res, '只有被拒绝的内容才能申诉');
    targetUserId = post.user_id;
  } else if (targetType === APPEAL_TARGET_TYPE.COMMENT) {
    const comment = db.prepare('SELECT id, user_id, status FROM comments WHERE id = ?').get(targetId) as any;
    if (!comment) return error(res, '评论不存在');
    if (comment.status !== CONTENT_STATUS.REJECTED) return error(res, '只有被拒绝的内容才能申诉');
    targetUserId = comment.user_id;
  } else {
    return error(res, '不支持的申诉类型');
  }

  if (targetUserId !== req.userId) {
    return error(res, '只能申诉自己的内容');
  }

  const existing = db.prepare('SELECT id FROM appeals WHERE target_type = ? AND target_id = ? AND status = ?')
    .get(targetType, targetId, APPEAL_STATUS.PENDING);
  if (existing) {
    return error(res, '已有申诉正在处理中，请耐心等待');
  }

  db.prepare(`
    INSERT INTO appeals (user_id, target_type, target_id, reason, description)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.userId, targetType, targetId, reason.trim(), description || null);

  success(res, null, '申诉提交成功，我们会尽快处理');
});

router.get('/appeals', authMiddleware, (req: AuthRequest, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;
  const status = req.query.status !== undefined ? parseInt(req.query.status as string) : null;
  const target_type = req.query.target_type ? parseInt(req.query.target_type as string) : null;
  const user_id = req.query.user_id ? parseInt(req.query.user_id as string) : null;
  const keyword = req.query.keyword as string;
  const start_date = req.query.start_date as string;
  const end_date = req.query.end_date as string;

  const db = getDb();
  if (!isAdmin(req.userId!)) return error(res, '无权限访问', 403, 403);

  const whereClauses: string[] = [];
  const params: any[] = [];

  if (status !== null) {
    whereClauses.push('a.status = ?');
    params.push(status);
  }
  if (target_type) {
    whereClauses.push('a.target_type = ?');
    params.push(target_type);
  }
  if (user_id) {
    whereClauses.push('a.user_id = ?');
    params.push(user_id);
  }
  if (start_date) {
    whereClauses.push('a.created_at >= ?');
    params.push(start_date);
  }
  if (end_date) {
    whereClauses.push('a.created_at <= ?');
    params.push(end_date + ' 23:59:59');
  }
  if (keyword && keyword.trim()) {
    whereClauses.push('(a.reason LIKE ? OR a.description LIKE ? OR u.nickname LIKE ?)');
    params.push(`%${keyword.trim()}%`, `%${keyword.trim()}%`, `%${keyword.trim()}%`);
  }

  const whereClause = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

  const appeals = db.prepare(`
    SELECT a.*, u.nickname as user_nickname, u.avatar as user_avatar
    FROM appeals a
    JOIN users u ON a.user_id = u.id
    ${whereClause}
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset) as any[];

  const total = db.prepare(`SELECT COUNT(*) as count FROM appeals a JOIN users u ON a.user_id = u.id ${whereClause}`)
    .get(...params) as any;

  success(res, paginate(appeals, total.count, page, pageSize));
});

router.post('/appeal/handle/:id', authMiddleware, (req: AuthRequest, res) => {
  const appealId = parseInt(req.params.id);
  const { status, handle_note } = req.body;

  if (isNaN(appealId)) return error(res, '无效的申诉ID');
  if (status === undefined || isNaN(parseInt(status))) return error(res, '请选择处理结果');

  const db = getDb();
  if (!isAdmin(req.userId!)) return error(res, '无权限操作', 403, 403);

  const appeal = db.prepare('SELECT * FROM appeals WHERE id = ?').get(appealId) as any;
  if (!appeal) return error(res, '申诉不存在');
  if (appeal.status !== APPEAL_STATUS.PENDING) return error(res, '该申诉已处理');

  const statusVal = parseInt(status);

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE appeals SET status = ?, handle_note = ?, handler_id = ?, handled_at = datetime('now')
      WHERE id = ?
    `).run(statusVal, handle_note || null, req.userId, appealId);

    if (statusVal === APPEAL_STATUS.APPROVED) {
      if (appeal.target_type === APPEAL_TARGET_TYPE.POST) {
        db.prepare('UPDATE posts SET status = ?, review_reason = ? WHERE id = ?')
          .run(CONTENT_STATUS.APPROVED, null, appeal.target_id);
      } else if (appeal.target_type === APPEAL_TARGET_TYPE.COMMENT) {
        db.prepare('UPDATE comments SET status = ?, review_reason = ? WHERE id = ?')
          .run(CONTENT_STATUS.APPROVED, null, appeal.target_id);
      }
    }

    db.prepare(`
      INSERT INTO notifications (user_id, type, title, content, related_id, related_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      appeal.user_id,
      5,
      statusVal === APPEAL_STATUS.APPROVED ? '申诉已通过' : '申诉已驳回',
      statusVal === APPEAL_STATUS.APPROVED
        ? `您的申诉已通过，内容已恢复。${handle_note ? '处理说明：' + handle_note : ''}`
        : `您的申诉未通过。${handle_note ? '处理说明：' + handle_note : '感谢您的理解'}`,
      appealId,
      'appeal'
    );

    const targetTypeNum = appeal.target_type === APPEAL_TARGET_TYPE.POST ? 1 : 3;
    const summary = (appeal.reason || '').substring(0, 50);
    addModLog(req.userId!, MOD_LOG_TYPE.APPEAL_HANDLE, targetTypeNum, appeal.target_id, summary,
      appeal.status, statusVal, handle_note || null);
  });
  tx();

  success(res, null, '处理完成');
});

router.get('/appeal/mine', authMiddleware, (req: AuthRequest, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;
  const status = req.query.status !== undefined ? parseInt(req.query.status as string) : null;
  const target_type = req.query.target_type ? parseInt(req.query.target_type as string) : null;

  const db = getDb();

  const whereClauses: string[] = ['a.user_id = ?'];
  const params: any[] = [req.userId];

  if (status !== null) {
    whereClauses.push('a.status = ?');
    params.push(status);
  }
  if (target_type) {
    whereClauses.push('a.target_type = ?');
    params.push(target_type);
  }

  const whereClause = 'WHERE ' + whereClauses.join(' AND ');

  const appeals = db.prepare(`
    SELECT a.*
    FROM appeals a
    ${whereClause}
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset) as any[];

  const total = db.prepare(`SELECT COUNT(*) as count FROM appeals a ${whereClause}`).get(...params) as any;

  success(res, paginate(appeals, total.count, page, pageSize));
});

export default router;
