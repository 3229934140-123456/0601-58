import { Router } from 'express';
import { getDb } from '../database';
import { success, error, paginate } from '../utils/response';
import { authMiddleware, AuthRequest, optionalAuthMiddleware } from '../middleware/auth';
import { config } from '../config';

const router = Router();

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
    if (!post) {
      return error(res, '动态不存在');
    }
  } else if (targetType === 2) {
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
    if (!user) {
      return error(res, '用户不存在');
    }
  } else if (targetType === 3) {
    const comment = db.prepare('SELECT id FROM comments WHERE id = ?').get(targetId);
    if (!comment) {
      return error(res, '评论不存在');
    }
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

  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId) as any;
  if (!user || user.role < 2) {
    return error(res, '无权限访问', 403, 403);
  }

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

  if (isNaN(reportId)) {
    return error(res, '无效的举报ID');
  }

  const db = getDb();

  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId) as any;
  if (!user || user.role < 2) {
    return error(res, '无权限操作', 403, 403);
  }

  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId) as any;
  if (!report) {
    return error(res, '举报不存在');
  }

  db.prepare(`
    UPDATE reports SET status = ?, handler_id = ?
    WHERE id = ?
  `).run(status || 1, req.userId, reportId);

  success(res, null, '处理成功');
});

router.post('/ban/user/:userId', authMiddleware, (req: AuthRequest, res) => {
  const userId = parseInt(req.params.userId);
  const { reason, end_time } = req.body;

  if (isNaN(userId)) {
    return error(res, '无效的用户ID');
  }

  const db = getDb();

  const admin = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId) as any;
  if (!admin || admin.role < 2) {
    return error(res, '无权限操作', 403, 403);
  }

  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) {
    return error(res, '用户不存在');
  }

  db.prepare('UPDATE users SET status = 1 WHERE id = ?').run(userId);

  db.prepare(`
    INSERT INTO bans (user_id, reason, end_time, handler_id, status)
    VALUES (?, ?, ?, ?, 1)
  `).run(userId, reason || null, end_time || null, req.userId);

  success(res, null, '封禁成功');
});

router.post('/unban/user/:userId', authMiddleware, (req: AuthRequest, res) => {
  const userId = parseInt(req.params.userId);

  if (isNaN(userId)) {
    return error(res, '无效的用户ID');
  }

  const db = getDb();

  const admin = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId) as any;
  if (!admin || admin.role < 2) {
    return error(res, '无权限操作', 403, 403);
  }

  db.prepare('UPDATE users SET status = 0 WHERE id = ?').run(userId);
  db.prepare('UPDATE bans SET status = 0 WHERE user_id = ? AND status = 1').run(userId);

  success(res, null, '解封成功');
});

router.post('/review/post/:postId', authMiddleware, (req: AuthRequest, res) => {
  const postId = parseInt(req.params.postId);
  const { status } = req.body;

  if (isNaN(postId)) {
    return error(res, '无效的动态ID');
  }

  const db = getDb();

  const admin = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId) as any;
  if (!admin || admin.role < 2) {
    return error(res, '无权限操作', 403, 403);
  }

  const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(postId);
  if (!post) {
    return error(res, '动态不存在');
  }

  db.prepare('UPDATE posts SET status = ? WHERE id = ?').run(status || 0, postId);

  success(res, null, '审核完成');
});

router.post('/review/comment/:commentId', authMiddleware, (req: AuthRequest, res) => {
  const commentId = parseInt(req.params.commentId);
  const { status } = req.body;

  if (isNaN(commentId)) {
    return error(res, '无效的评论ID');
  }

  const db = getDb();

  const admin = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId) as any;
  if (!admin || admin.role < 2) {
    return error(res, '无权限操作', 403, 403);
  }

  const comment = db.prepare('SELECT id FROM comments WHERE id = ?').get(commentId);
  if (!comment) {
    return error(res, '评论不存在');
  }

  db.prepare('UPDATE comments SET status = ? WHERE id = ?').run(status || 0, commentId);

  success(res, null, '审核完成');
});

router.post('/announcement', authMiddleware, (req: AuthRequest, res) => {
  const { title, content, type } = req.body;

  if (!title || !title.trim()) {
    return error(res, '公告标题不能为空');
  }

  const db = getDb();

  const admin = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId) as any;
  if (!admin || admin.role < 2) {
    return error(res, '无权限操作', 403, 403);
  }

  const result = db.prepare(`
    INSERT INTO announcements (title, content, type, publisher_id)
    VALUES (?, ?, ?, ?)
  `).run(title.trim(), content || null, type || 0, req.userId);

  success(res, { id: result.lastInsertRowid }, '公告发布成功');
});

router.get('/announcements', optionalAuthMiddleware, (_req, res) => {
  const page = parseInt(_req.query.page as string) || 1;
  const pageSize = parseInt(_req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;

  const db = getDb();

  const announcements = db.prepare(`
    SELECT a.*, u.nickname as publisher_name
    FROM announcements a
    LEFT JOIN users u ON a.publisher_id = u.id
    WHERE a.status = 1
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(pageSize, offset);

  const total = db.prepare('SELECT COUNT(*) as count FROM announcements WHERE status = 1')
    .get() as any;

  success(res, paginate(announcements, total.count, page, pageSize));
});

router.get('/announcement/:id', optionalAuthMiddleware, (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    return error(res, '无效的公告ID');
  }

  const db = getDb();
  const announcement = db.prepare(`
    SELECT a.*, u.nickname as publisher_name
    FROM announcements a
    LEFT JOIN users u ON a.publisher_id = u.id
    WHERE a.id = ?
  `).get(id);

  if (!announcement) {
    return error(res, '公告不存在', 404, 404);
  }

  success(res, announcement);
});

export default router;
