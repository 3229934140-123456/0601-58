import { Router } from 'express';
import { getDb } from '../database';
import { success, error, paginate } from '../utils/response';
import { authMiddleware, AuthRequest, optionalAuthMiddleware } from '../middleware/auth';
import { config } from '../config';

const router = Router();

router.get('/:id', optionalAuthMiddleware, (req: AuthRequest, res) => {
  const userId = parseInt(req.params.id);
  if (isNaN(userId)) {
    return error(res, '无效的用户ID');
  }

  const db = getDb();
  const user = db.prepare(`
    SELECT id, username, nickname, avatar, bio, gender, birthday, location,
           follower_count, following_count, post_count, created_at
    FROM users WHERE id = ? AND status = 0
  `).get(userId) as any;

  if (!user) {
    return error(res, '用户不存在', 404, 404);
  }

  let isFollowing = false;
  let isBlocked = false;
  if (req.userId && req.userId !== userId) {
    const follow = db.prepare('SELECT id FROM follows WHERE follower_id = ? AND following_id = ?')
      .get(req.userId, userId);
    isFollowing = !!follow;

    const block = db.prepare('SELECT id FROM blocks WHERE user_id = ? AND blocked_user_id = ?')
      .get(req.userId, userId);
    isBlocked = !!block;
  }

  success(res, {
    ...user,
    is_following: isFollowing,
    is_blocked: isBlocked,
  });
});

router.put('/profile', authMiddleware, (req: AuthRequest, res) => {
  const { nickname, avatar, bio, gender, birthday, location, email, phone } = req.body;

  const db = getDb();

  db.prepare(`
    UPDATE users
    SET nickname = COALESCE(?, nickname),
        avatar = COALESCE(?, avatar),
        bio = COALESCE(?, bio),
        gender = COALESCE(?, gender),
        birthday = COALESCE(?, birthday),
        location = COALESCE(?, location),
        email = COALESCE(?, email),
        phone = COALESCE(?, phone),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(nickname, avatar, bio, gender, birthday, location, email, phone, req.userId);

  const user = db.prepare(`
    SELECT id, username, nickname, avatar, bio, gender, birthday, location, email, phone,
           follower_count, following_count, post_count, updated_at
    FROM users WHERE id = ?
  `).get(req.userId);

  success(res, user, '资料更新成功');
});

router.get('/search', optionalAuthMiddleware, (req: AuthRequest, res) => {
  const keyword = (req.query.keyword as string) || '';
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;

  if (!keyword.trim()) {
    return success(res, paginate([], 0, page, pageSize));
  }

  const db = getDb();
  const offset = (page - 1) * pageSize;

  const users = db.prepare(`
    SELECT id, username, nickname, avatar, bio, follower_count
    FROM users
    WHERE status = 0 AND (username LIKE ? OR nickname LIKE ? OR bio LIKE ?)
    ORDER BY follower_count DESC
    LIMIT ? OFFSET ?
  `).all(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, pageSize, offset) as any[];

  const total = db.prepare(`
    SELECT COUNT(*) as count FROM users
    WHERE status = 0 AND (username LIKE ? OR nickname LIKE ? OR bio LIKE ?)
  `).get(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`) as any;

  success(res, paginate(users, total.count, page, pageSize));
});

router.post('/block/:userId', authMiddleware, (req: AuthRequest, res) => {
  const blockedUserId = parseInt(req.params.userId);
  if (isNaN(blockedUserId)) {
    return error(res, '无效的用户ID');
  }
  if (blockedUserId === req.userId) {
    return error(res, '不能拉黑自己');
  }

  const db = getDb();

  const targetUser = db.prepare('SELECT id FROM users WHERE id = ?').get(blockedUserId);
  if (!targetUser) {
    return error(res, '用户不存在', 404, 404);
  }

  try {
    db.prepare('INSERT INTO blocks (user_id, blocked_user_id) VALUES (?, ?)')
      .run(req.userId, blockedUserId);

    db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?')
      .run(req.userId, blockedUserId);
    db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?')
      .run(blockedUserId, req.userId);

    success(res, null, '拉黑成功');
  } catch (e) {
    success(res, null, '已在黑名单中');
  }
});

router.post('/unblock/:userId', authMiddleware, (req: AuthRequest, res) => {
  const blockedUserId = parseInt(req.params.userId);
  if (isNaN(blockedUserId)) {
    return error(res, '无效的用户ID');
  }

  const db = getDb();
  db.prepare('DELETE FROM blocks WHERE user_id = ? AND blocked_user_id = ?')
    .run(req.userId!, blockedUserId);

  success(res, null, '取消拉黑成功');
});

router.get('/blocks/list', authMiddleware, (req: AuthRequest, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;

  const db = getDb();

  const blocks = db.prepare(`
    SELECT b.id, b.blocked_user_id as user_id, u.nickname, u.avatar, u.username, b.created_at
    FROM blocks b
    JOIN users u ON b.blocked_user_id = u.id
    WHERE b.user_id = ?
    ORDER BY b.created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.userId, pageSize, offset) as any[];

  const total = db.prepare('SELECT COUNT(*) as count FROM blocks WHERE user_id = ?')
    .get(req.userId) as any;

  success(res, paginate(blocks, total.count, page, pageSize));
});

export default router;
