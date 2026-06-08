import { Router } from 'express';
import { getDb } from '../database';
import { success, error, paginate } from '../utils/response';
import { authMiddleware, AuthRequest, optionalAuthMiddleware } from '../middleware/auth';
import { config } from '../config';
import { CONTENT_STATUS, ANNOUNCEMENT_STATUS } from '../constants';

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
  const status = req.query.status ? parseInt(req.query.status as string) : null;

  const db = getDb();
  if (!isAdmin(req.userId!)) return error(res, '无权限访问', 403, 403);

  let whereClause = '';
  const params: any[] = [];
  if (status !== null) {
    whereClause = 'WHERE r.status = ?';
    params.push(status);
  }

  const reports = db.prepare(`
    SELECT r.*, u.nickname as reporter_name
    FROM reports r
    JOIN users u ON r.reporter_id = u.id
    ${whereClause}
    ORDER BY r.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  const total = db.prepare(`SELECT COUNT(*) as count FROM reports r ${whereClause}`)
    .get(...params) as any;

  success(res, paginate(reports, total.count, page, pageSize));
});

router.post('/report/handle/:id', authMiddleware, (req: AuthRequest, res) => {
  const reportId = parseInt(req.params.id);
  const { status, handle_note } = req.body;

  if (isNaN(reportId)) return error(res, '无效的举报ID');

  const db = getDb();
  if (!isAdmin(req.userId!)) return error(res, '无权限操作', 403, 403);

  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId) as any;
  if (!report) return error(res, '举报不存在');

  db.prepare(`
    UPDATE reports SET status = ?, handle_note = ?, handler_id = ?, handled_at = datetime('now')
    WHERE id = ?
  `).run(status !== undefined ? status : 1, handle_note || null, req.userId, reportId);

  success(res, null, '处理成功');
});

router.get('/posts', authMiddleware, (req: AuthRequest, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;
  const status = req.query.status !== undefined ? parseInt(req.query.status as string) : null;
  const keyword = req.query.keyword as string;

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
        3,
        '动态审核未通过',
        `您的动态因「${review_reason || '违反社区规范'}」未通过审核`,
        postId,
        'post'
      );
    } else if (statusVal === CONTENT_STATUS.APPROVED) {
      db.prepare(`
        INSERT INTO notifications (user_id, type, title, content, related_id, related_type)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(post.user_id, 3, '动态审核通过', '您的动态已通过审核', postId, 'post');
    }
  });
  tx();

  success(res, null, '审核完成');
});

router.get('/comments', authMiddleware, (req: AuthRequest, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;
  const status = req.query.status !== undefined ? parseInt(req.query.status as string) : null;
  const keyword = req.query.keyword as string;

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
        3,
        '评论审核未通过',
        `您的评论因「${review_reason || '违反社区规范'}」未通过审核`,
        commentId,
        'comment'
      );
    }
  });
  tx();

  success(res, null, '审核完成');
});

router.post('/ban/user/:userId', authMiddleware, (req: AuthRequest, res) => {
  const userId = parseInt(req.params.userId);
  const { reason, end_time } = req.body;

  if (isNaN(userId)) return error(res, '无效的用户ID');

  const db = getDb();
  if (!isAdmin(req.userId!)) return error(res, '无权限操作', 403, 403);

  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) return error(res, '用户不存在');

  db.prepare('UPDATE users SET status = 1 WHERE id = ?').run(userId);
  db.prepare(`
    INSERT INTO bans (user_id, reason, end_time, handler_id, status)
    VALUES (?, ?, ?, ?, 1)
  `).run(userId, reason || null, end_time || null, req.userId);

  success(res, null, '封禁成功');
});

router.post('/unban/user/:userId', authMiddleware, (req: AuthRequest, res) => {
  const userId = parseInt(req.params.userId);

  if (isNaN(userId)) return error(res, '无效的用户ID');

  const db = getDb();
  if (!isAdmin(req.userId!)) return error(res, '无权限操作', 403, 403);

  db.prepare('UPDATE users SET status = 0 WHERE id = ?').run(userId);
  db.prepare('UPDATE bans SET status = 0 WHERE user_id = ? AND status = 1').run(userId);

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

  db.prepare(`
    UPDATE announcements SET title = ?, content = ?, type = ?, status = ?
    WHERE id = ?
  `).run(
    title !== undefined ? title.trim() : undefined,
    content !== undefined ? content : undefined,
    type !== undefined ? type : undefined,
    status !== undefined ? parseInt(status) : undefined,
    id
  );

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

  const announcement = db.prepare('SELECT id FROM announcements WHERE id = ?').get(id);
  if (!announcement) return error(res, '公告不存在');

  db.prepare('UPDATE announcements SET status = ? WHERE id = ?').run(parseInt(status), id);

  success(res, null, '状态更新成功');
});

router.get('/announcements', optionalAuthMiddleware, (req: AuthRequest, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;
  const adminView = req.query.admin === '1';

  const db = getDb();
  let statusFilter = 'a.status = ?';
  let statusVal = ANNOUNCEMENT_STATUS.PUBLISHED;

  if (adminView && req.userId && isAdmin(req.userId)) {
    statusFilter = '1 = 1';
  }

  const announcements = db.prepare(`
    SELECT a.*, u.nickname as publisher_name
    FROM announcements a
    LEFT JOIN users u ON a.publisher_id = u.id
    WHERE ${statusFilter}
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...(adminView && req.userId && isAdmin(req.userId) ? [] : [statusVal]), pageSize, offset);

  const total = db.prepare(`SELECT COUNT(*) as count FROM announcements a WHERE ${statusFilter}`)
    .get(...(adminView && req.userId && isAdmin(req.userId) ? [] : [statusVal])) as any;

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

export default router;
