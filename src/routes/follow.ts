import { Router } from 'express';
import { getDb } from '../database';
import { success, error, paginate } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { config } from '../config';

const router = Router();

function createNotification(userId: number, type: number, title: string, content: string, fromUserId?: number, relatedId?: number, relatedType?: string) {
  const db = getDb();
  db.prepare(`
    INSERT INTO notifications (user_id, type, title, content, from_user_id, related_id, related_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, type, title, content, fromUserId || null, relatedId || null, relatedType || null);
}

router.post('/follow/:userId', authMiddleware, (req: AuthRequest, res) => {
  const followingId = parseInt(req.params.userId);
  if (isNaN(followingId)) {
    return error(res, '无效的用户ID');
  }
  if (followingId === req.userId) {
    return error(res, '不能关注自己');
  }

  const db = getDb();

  const targetUser = db.prepare('SELECT id, status FROM users WHERE id = ?').get(followingId) as any;
  if (!targetUser) {
    return error(res, '用户不存在', 404, 404);
  }
  if (targetUser.status !== 0) {
    return error(res, '用户账号异常');
  }

  const blocked = db.prepare('SELECT id FROM blocks WHERE user_id = ? AND blocked_user_id = ?')
    .get(followingId, req.userId);
  if (blocked) {
    return error(res, '无法关注该用户');
  }

  try {
    const result = db.prepare('INSERT INTO follows (follower_id, following_id) VALUES (?, ?)')
      .run(req.userId, followingId);

    db.prepare('UPDATE users SET following_count = following_count + 1 WHERE id = ?').run(req.userId);
    db.prepare('UPDATE users SET follower_count = follower_count + 1 WHERE id = ?').run(followingId);

    const follower = db.prepare('SELECT nickname FROM users WHERE id = ?').get(req.userId) as any;
    createNotification(followingId, 1, '新的关注', `${follower.nickname} 关注了你`, req.userId!, result.lastInsertRowid as number, 'follow');

    success(res, { is_following: true }, '关注成功');
  } catch (e) {
    success(res, { is_following: true }, '已关注');
  }
});

router.post('/unfollow/:userId', authMiddleware, (req: AuthRequest, res) => {
  const followingId = parseInt(req.params.userId);
  if (isNaN(followingId)) {
    return error(res, '无效的用户ID');
  }

  const db = getDb();
  const result = db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?')
    .run(req.userId, followingId);

  if (result.changes > 0) {
    db.prepare('UPDATE users SET following_count = following_count - 1 WHERE id = ?').run(req.userId!);
    db.prepare('UPDATE users SET follower_count = follower_count - 1 WHERE id = ?').run(followingId);
  }

  success(res, { is_following: false }, '取消关注成功');
});

router.get('/followers/:userId', (req, res) => {
  const userId = parseInt(req.params.userId);
  if (isNaN(userId)) {
    return error(res, '无效的用户ID');
  }

  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;

  const db = getDb();

  const followers = db.prepare(`
    SELECT u.id, u.username, u.nickname, u.avatar, u.bio, u.follower_count, f.created_at
    FROM follows f
    JOIN users u ON f.follower_id = u.id
    WHERE f.following_id = ? AND u.status = 0
    ORDER BY f.created_at DESC
    LIMIT ? OFFSET ?
  `).all(userId, pageSize, offset) as any[];

  const total = db.prepare('SELECT COUNT(*) as count FROM follows WHERE following_id = ?').get(userId) as any;

  success(res, paginate(followers, total.count, page, pageSize));
});

router.get('/following/:userId', (req, res) => {
  const userId = parseInt(req.params.userId);
  if (isNaN(userId)) {
    return error(res, '无效的用户ID');
  }

  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;

  const db = getDb();

  const following = db.prepare(`
    SELECT u.id, u.username, u.nickname, u.avatar, u.bio, u.follower_count, f.created_at
    FROM follows f
    JOIN users u ON f.following_id = u.id
    WHERE f.follower_id = ? AND u.status = 0
    ORDER BY f.created_at DESC
    LIMIT ? OFFSET ?
  `).all(userId, pageSize, offset) as any[];

  const total = db.prepare('SELECT COUNT(*) as count FROM follows WHERE follower_id = ?').get(userId) as any;

  success(res, paginate(following, total.count, page, pageSize));
});

router.get('/friends', authMiddleware, (req: AuthRequest, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;

  const db = getDb();

  const friends = db.prepare(`
    SELECT u.id, u.username, u.nickname, u.avatar, u.bio
    FROM follows f1
    JOIN follows f2 ON f1.following_id = f2.follower_id AND f1.follower_id = f2.following_id
    JOIN users u ON f1.following_id = u.id
    WHERE f1.follower_id = ? AND u.status = 0
    ORDER BY u.nickname
    LIMIT ? OFFSET ?
  `).all(req.userId, pageSize, offset) as any[];

  const total = db.prepare(`
    SELECT COUNT(*) as count
    FROM follows f1
    JOIN follows f2 ON f1.following_id = f2.follower_id AND f1.follower_id = f2.following_id
    WHERE f1.follower_id = ?
  `).get(req.userId) as any;

  success(res, paginate(friends, total.count, page, pageSize));
});

export default router;
