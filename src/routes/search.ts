import { Router } from 'express';
import { getDb } from '../database';
import { success, error, paginate } from '../utils/response';
import { authMiddleware, AuthRequest, optionalAuthMiddleware } from '../middleware/auth';
import { config } from '../config';

const router = Router();

router.get('/all', optionalAuthMiddleware, (req: AuthRequest, res) => {
  const keyword = (req.query.keyword as string) || '';
  const type = (req.query.type as string) || 'all';
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;

  if (!keyword.trim()) {
    return success(res, paginate([], 0, page, pageSize));
  }

  const db = getDb();

  if (req.userId) {
    db.prepare('INSERT INTO search_history (user_id, keyword) VALUES (?, ?)')
      .run(req.userId, keyword.trim());
  }

  let results: any = {};

  if (type === 'all' || type === 'user') {
    const users = db.prepare(`
      SELECT id, username, nickname, avatar, bio, follower_count
      FROM users
      WHERE status = 0 AND (username LIKE ? OR nickname LIKE ? OR bio LIKE ?)
      ORDER BY follower_count DESC
      LIMIT ?
    `).all(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, pageSize);
    results.users = users;
  }

  if (type === 'all' || type === 'post') {
    const posts = db.prepare(`
      SELECT p.*, u.username, u.nickname, u.avatar, t.name as topic_name
      FROM posts p
      JOIN users u ON p.user_id = u.id
      LEFT JOIN topics t ON p.topic_id = t.id
      WHERE p.status = 0 AND p.visibility = 0
        AND (p.content LIKE ?)
      ORDER BY p.created_at DESC
      LIMIT ?
    `).all(`%${keyword}%`, pageSize);

    posts.forEach((post: any) => {
      if (post.images) {
        post.images = JSON.parse(post.images);
      }
    });
    results.posts = posts;
  }

  if (type === 'all' || type === 'topic') {
    const topics = db.prepare(`
      SELECT * FROM topics
      WHERE name LIKE ? OR description LIKE ?
      ORDER BY post_count DESC
      LIMIT ?
    `).all(`%${keyword}%`, `%${keyword}%`, pageSize);
    results.topics = topics;
  }

  if (type === 'all' || type === 'circle') {
    const circles = db.prepare(`
      SELECT c.*, u.nickname as owner_name
      FROM circles c
      JOIN users u ON c.owner_id = u.id
      WHERE c.status = 0 AND (c.name LIKE ? OR c.description LIKE ?)
      ORDER BY c.member_count DESC
      LIMIT ?
    `).all(`%${keyword}%`, `%${keyword}%`, pageSize);
    results.circles = circles;
  }

  success(res, results);
});

router.get('/users', optionalAuthMiddleware, (req: AuthRequest, res) => {
  const keyword = (req.query.keyword as string) || '';
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;

  if (!keyword.trim()) {
    return success(res, paginate([], 0, page, pageSize));
  }

  const db = getDb();

  if (req.userId) {
    db.prepare('INSERT INTO search_history (user_id, keyword) VALUES (?, ?)')
      .run(req.userId, keyword.trim());
  }

  const users = db.prepare(`
    SELECT id, username, nickname, avatar, bio, follower_count
    FROM users
    WHERE status = 0 AND (username LIKE ? OR nickname LIKE ? OR bio LIKE ?)
    ORDER BY follower_count DESC
    LIMIT ? OFFSET ?
  `).all(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, pageSize, offset);

  const total = db.prepare(`
    SELECT COUNT(*) as count FROM users
    WHERE status = 0 AND (username LIKE ? OR nickname LIKE ? OR bio LIKE ?)
  `).get(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`) as any;

  success(res, paginate(users, total.count, page, pageSize));
});

router.get('/posts', optionalAuthMiddleware, (req: AuthRequest, res) => {
  const keyword = (req.query.keyword as string) || '';
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;

  if (!keyword.trim()) {
    return success(res, paginate([], 0, page, pageSize));
  }

  const db = getDb();

  if (req.userId) {
    db.prepare('INSERT INTO search_history (user_id, keyword) VALUES (?, ?)')
      .run(req.userId, keyword.trim());
  }

  const posts = db.prepare(`
    SELECT p.*, u.username, u.nickname, u.avatar, t.name as topic_name
    FROM posts p
    JOIN users u ON p.user_id = u.id
    LEFT JOIN topics t ON p.topic_id = t.id
    WHERE p.status = 0 AND p.visibility = 0
      AND p.content LIKE ?
    ORDER BY p.created_at DESC
    LIMIT ? OFFSET ?
  `).all(`%${keyword}%`, pageSize, offset) as any[];

  posts.forEach(post => {
    if (post.images) {
      post.images = JSON.parse(post.images);
    }
  });

  const total = db.prepare(`
    SELECT COUNT(*) as count FROM posts
    WHERE status = 0 AND visibility = 0 AND content LIKE ?
  `).get(`%${keyword}%`) as any;

  success(res, paginate(posts, total.count, page, pageSize));
});

router.get('/history', authMiddleware, (req: AuthRequest, res) => {
  const db = getDb();

  const history = db.prepare(`
    SELECT DISTINCT keyword, MAX(created_at) as last_time
    FROM search_history
    WHERE user_id = ?
    GROUP BY keyword
    ORDER BY last_time DESC
    LIMIT 20
  `).all(req.userId);

  success(res, history);
});

router.delete('/history', authMiddleware, (req: AuthRequest, res) => {
  const db = getDb();
  db.prepare('DELETE FROM search_history WHERE user_id = ?').run(req.userId);
  success(res, null, '搜索历史已清空');
});

router.get('/hot/keywords', (_req, res) => {
  const db = getDb();

  const hotKeywords = db.prepare(`
    SELECT keyword, COUNT(*) as search_count
    FROM search_history
    WHERE created_at >= datetime('now', '-7 days')
    GROUP BY keyword
    ORDER BY search_count DESC
    LIMIT 20
  `).all();

  success(res, hotKeywords);
});

export default router;
