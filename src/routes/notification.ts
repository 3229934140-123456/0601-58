import { Router } from 'express';
import { getDb } from '../database';
import { success, error, paginate } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { config } from '../config';

const router = Router();

router.get('/list', authMiddleware, (req: AuthRequest, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;
  const type = req.query.type ? parseInt(req.query.type as string) : null;
  const isRead = req.query.is_read ? parseInt(req.query.is_read as string) : null;

  const db = getDb();

  let whereClause = 'WHERE n.user_id = ?';
  const params: any[] = [req.userId];

  if (type !== null) {
    whereClause += ' AND n.type = ?';
    params.push(type);
  }
  if (isRead !== null) {
    whereClause += ' AND n.is_read = ?';
    params.push(isRead);
  }

  const notifications = db.prepare(`
    SELECT n.*, u.nickname as from_nickname, u.avatar as from_avatar
    FROM notifications n
    LEFT JOIN users u ON n.from_user_id = u.id
    ${whereClause}
    ORDER BY n.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  const total = db.prepare(`SELECT COUNT(*) as count FROM notifications n ${whereClause}`)
    .get(...params) as any;

  success(res, paginate(notifications, total.count, page, pageSize));
});

router.get('/unread/count', authMiddleware, (req: AuthRequest, res) => {
  const db = getDb();

  const result = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN type = 1 THEN 1 ELSE 0 END) as follow_count,
      SUM(CASE WHEN type = 2 THEN 1 ELSE 0 END) as like_count,
      SUM(CASE WHEN type = 3 THEN 1 ELSE 0 END) as comment_count,
      SUM(CASE WHEN type = 4 THEN 1 ELSE 0 END) as share_count,
      SUM(CASE WHEN type = 5 THEN 1 ELSE 0 END) as system_count
    FROM notifications
    WHERE user_id = ? AND is_read = 0
  `).get(req.userId) as any;

  success(res, {
    total: result.total || 0,
    follow: result.follow_count || 0,
    like: result.like_count || 0,
    comment: result.comment_count || 0,
    share: result.share_count || 0,
    system: result.system_count || 0,
  });
});

router.post('/read/:id', authMiddleware, (req: AuthRequest, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    return error(res, '无效的通知ID');
  }

  const db = getDb();
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?')
    .run(id, req.userId);

  success(res, null, '已标记为已读');
});

router.post('/read/all', authMiddleware, (req: AuthRequest, res) => {
  const db = getDb();
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?')
    .run(req.userId);

  success(res, null, '全部已读');
});

router.post('/clear', authMiddleware, (req: AuthRequest, res) => {
  const db = getDb();
  db.prepare('DELETE FROM notifications WHERE user_id = ?')
    .run(req.userId);

  success(res, null, '已清空通知');
});

router.get('/messages', authMiddleware, (req: AuthRequest, res) => {
  const otherUserId = parseInt(req.query.user_id as string);
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;

  if (isNaN(otherUserId)) {
    return error(res, '无效的用户ID');
  }

  const db = getDb();

  const messages = db.prepare(`
    SELECT m.*, u.nickname as from_nickname, u.avatar as from_avatar
    FROM messages m
    JOIN users u ON m.from_user_id = u.id
    WHERE (m.from_user_id = ? AND m.to_user_id = ?)
       OR (m.from_user_id = ? AND m.to_user_id = ?)
    ORDER BY m.created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.userId, otherUserId, otherUserId, req.userId, pageSize, offset).reverse();

  const total = db.prepare(`
    SELECT COUNT(*) as count FROM messages
    WHERE (from_user_id = ? AND to_user_id = ?)
       OR (from_user_id = ? AND to_user_id = ?)
  `).get(req.userId, otherUserId, otherUserId, req.userId) as any;

  db.prepare(`
    UPDATE messages SET is_read = 1
    WHERE from_user_id = ? AND to_user_id = ? AND is_read = 0
  `).run(otherUserId, req.userId);

  success(res, paginate(messages, total.count, page, pageSize));
});

router.post('/messages/send', authMiddleware, (req: AuthRequest, res) => {
  const { to_user_id, content } = req.body;

  if (!to_user_id || isNaN(parseInt(to_user_id))) {
    return error(res, '无效的接收用户ID');
  }
  if (!content || !content.trim()) {
    return error(res, '消息内容不能为空');
  }
  if (content.length > 1000) {
    return error(res, '消息内容不能超过1000字');
  }

  const toUserId = parseInt(to_user_id);
  if (toUserId === req.userId) {
    return error(res, '不能给自己发消息');
  }

  const db = getDb();

  const toUser = db.prepare('SELECT id, status FROM users WHERE id = ?').get(toUserId) as any;
  if (!toUser) {
    return error(res, '接收用户不存在');
  }

  const blocked = db.prepare('SELECT id FROM blocks WHERE user_id = ? AND blocked_user_id = ?')
    .get(toUserId, req.userId);
  if (blocked) {
    return error(res, '无法发送消息');
  }

  const result = db.prepare(`
    INSERT INTO messages (from_user_id, to_user_id, content)
    VALUES (?, ?, ?)
  `).run(req.userId, toUserId, content.trim());

  success(res, { id: result.lastInsertRowid }, '发送成功');
});

router.get('/conversations', authMiddleware, (req: AuthRequest, res) => {
  const db = getDb();

  const conversations = db.prepare(`
    SELECT
      CASE WHEN m.from_user_id = ? THEN m.to_user_id ELSE m.from_user_id END as other_user_id,
      u.nickname,
      u.avatar,
      m.content as last_message,
      m.created_at as last_time,
      SUM(CASE WHEN m.to_user_id = ? AND m.is_read = 0 THEN 1 ELSE 0 END) as unread_count
    FROM messages m
    JOIN users u ON u.id = CASE WHEN m.from_user_id = ? THEN m.to_user_id ELSE m.from_user_id END
    WHERE m.from_user_id = ? OR m.to_user_id = ?
    GROUP BY other_user_id
    ORDER BY m.created_at DESC
  `).all(req.userId, req.userId, req.userId, req.userId, req.userId) as any[];

  success(res, conversations);
});

export default router;
