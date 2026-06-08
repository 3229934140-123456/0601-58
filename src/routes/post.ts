import { Router } from 'express';
import { getDb } from '../database';
import { success, error, paginate } from '../utils/response';
import { authMiddleware, AuthRequest, optionalAuthMiddleware } from '../middleware/auth';
import { config } from '../config';

const router = Router();

function createNotification(userId: number, type: number, title: string, content: string, fromUserId?: number, relatedId?: number, relatedType?: string) {
  const db = getDb();
  db.prepare(`
    INSERT INTO notifications (user_id, type, title, content, from_user_id, related_id, related_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, type, title, content, fromUserId || null, relatedId || null, relatedType || null);
}

router.post('/', authMiddleware, (req: AuthRequest, res) => {
  const { content, images, visibility, topic_id, circle_id } = req.body;

  if (!content || !content.trim()) {
    return error(res, '动态内容不能为空');
  }
  if (content.length > 5000) {
    return error(res, '动态内容不能超过5000字');
  }

  const db = getDb();

  if (circle_id) {
    const member = db.prepare('SELECT status FROM circle_members WHERE circle_id = ? AND user_id = ?')
      .get(circle_id, req.userId) as any;
    if (!member || member.status !== 1) {
      return error(res, '请先加入该圈子');
    }
  }

  const result = db.prepare(`
    INSERT INTO posts (user_id, content, images, visibility, topic_id, circle_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    req.userId,
    content.trim(),
    images ? JSON.stringify(images) : null,
    visibility || 0,
    topic_id || null,
    circle_id || null
  );

  db.prepare('UPDATE users SET post_count = post_count + 1 WHERE id = ?').run(req.userId);

  if (topic_id) {
    db.prepare('UPDATE topics SET post_count = post_count + 1 WHERE id = ?').run(topic_id);
  }
  if (circle_id) {
    db.prepare('UPDATE circles SET post_count = post_count + 1 WHERE id = ?').run(circle_id);
  }

  const postId = result.lastInsertRowid as number;
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);

  success(res, post, '发布成功');
});

router.get('/detail/:id', optionalAuthMiddleware, (req: AuthRequest, res) => {
  const postId = parseInt(req.params.id);
  if (isNaN(postId)) {
    return error(res, '无效的动态ID');
  }

  const db = getDb();

  const post = db.prepare(`
    SELECT p.*, u.username, u.nickname, u.avatar,
           t.name as topic_name, c.name as circle_name
    FROM posts p
    JOIN users u ON p.user_id = u.id
    LEFT JOIN topics t ON p.topic_id = t.id
    LEFT JOIN circles c ON p.circle_id = c.id
    WHERE p.id = ? AND p.status = 0
  `).get(postId) as any;

  if (!post) {
    return error(res, '动态不存在', 404, 404);
  }

  if (post.images) {
    post.images = JSON.parse(post.images);
  }

  db.prepare('UPDATE posts SET view_count = view_count + 1 WHERE id = ?').run(postId);

  let isLiked = false;
  let isCollected = false;
  if (req.userId) {
    const like = db.prepare('SELECT id FROM post_likes WHERE post_id = ? AND user_id = ?')
      .get(postId, req.userId);
    isLiked = !!like;

    const collect = db.prepare('SELECT id FROM post_collects WHERE post_id = ? AND user_id = ?')
      .get(postId, req.userId);
    isCollected = !!collect;
  }

  post.is_liked = isLiked;
  post.is_collected = isCollected;

  success(res, post);
});

router.get('/list', optionalAuthMiddleware, (req: AuthRequest, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;
  const userId = req.query.user_id ? parseInt(req.query.user_id as string) : null;
  const topicId = req.query.topic_id ? parseInt(req.query.topic_id as string) : null;
  const circleId = req.query.circle_id ? parseInt(req.query.circle_id as string) : null;
  const sort = (req.query.sort as string) || 'latest';

  const db = getDb();

  let whereClause = 'WHERE p.status = 0';
  const params: any[] = [];

  if (userId) {
    whereClause += ' AND p.user_id = ?';
    params.push(userId);
  }
  if (topicId) {
    whereClause += ' AND p.topic_id = ?';
    params.push(topicId);
  }
  if (circleId) {
    whereClause += ' AND p.circle_id = ?';
    params.push(circleId);
  }

  let orderBy = 'ORDER BY p.is_top DESC, p.created_at DESC';
  if (sort === 'hot') {
    orderBy = 'ORDER BY p.like_count + p.comment_count * 2 + p.view_count / 10 DESC';
  }

  const posts = db.prepare(`
    SELECT p.*, u.username, u.nickname, u.avatar,
           t.name as topic_name, c.name as circle_name
    FROM posts p
    JOIN users u ON p.user_id = u.id
    LEFT JOIN topics t ON p.topic_id = t.id
    LEFT JOIN circles c ON p.circle_id = c.id
    ${whereClause}
    ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset) as any[];

  posts.forEach(post => {
    if (post.images) {
      post.images = JSON.parse(post.images);
    }
  });

  const total = db.prepare(`SELECT COUNT(*) as count FROM posts p ${whereClause}`)
    .get(...params) as any;

  success(res, paginate(posts, total.count, page, pageSize));
});

router.get('/following', authMiddleware, (req: AuthRequest, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;

  const db = getDb();

  const posts = db.prepare(`
    SELECT p.*, u.username, u.nickname, u.avatar, t.name as topic_name
    FROM posts p
    JOIN users u ON p.user_id = u.id
    LEFT JOIN topics t ON p.topic_id = t.id
    WHERE p.status = 0 AND p.user_id IN (
      SELECT following_id FROM follows WHERE follower_id = ?
    )
    ORDER BY p.created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.userId, pageSize, offset) as any[];

  posts.forEach(post => {
    if (post.images) {
      post.images = JSON.parse(post.images);
    }
  });

  const total = db.prepare(`
    SELECT COUNT(*) as count FROM posts p
    WHERE p.status = 0 AND p.user_id IN (
      SELECT following_id FROM follows WHERE follower_id = ?
    )
  `).get(req.userId) as any;

  success(res, paginate(posts, total.count, page, pageSize));
});

router.get('/recommend', optionalAuthMiddleware, (_req, res) => {
  const page = parseInt(_req.query.page as string) || 1;
  const pageSize = parseInt(_req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;

  const db = getDb();

  const posts = db.prepare(`
    SELECT p.*, u.username, u.nickname, u.avatar, t.name as topic_name
    FROM posts p
    JOIN users u ON p.user_id = u.id
    LEFT JOIN topics t ON p.topic_id = t.id
    WHERE p.status = 0 AND p.visibility = 0
    ORDER BY (p.like_count + p.comment_count * 2 + p.view_count / 10 + p.share_count * 3) DESC, p.created_at DESC
    LIMIT ? OFFSET ?
  `).all(pageSize, offset) as any[];

  posts.forEach(post => {
    if (post.images) {
      post.images = JSON.parse(post.images);
    }
  });

  const total = db.prepare('SELECT COUNT(*) as count FROM posts WHERE status = 0 AND visibility = 0')
    .get() as any;

  success(res, paginate(posts, total.count, page, pageSize));
});

router.get('/hot', optionalAuthMiddleware, (_req, res) => {
  const pageSize = parseInt(_req.query.pageSize as string) || 20;

  const db = getDb();

  const posts = db.prepare(`
    SELECT p.*, u.username, u.nickname, u.avatar
    FROM posts p
    JOIN users u ON p.user_id = u.id
    WHERE p.status = 0 AND p.visibility = 0
    ORDER BY (p.like_count * 3 + p.comment_count * 5 + p.view_count / 100 + p.share_count * 2) DESC
    LIMIT ?
  `).all(pageSize) as any[];

  posts.forEach(post => {
    if (post.images) {
      post.images = JSON.parse(post.images);
    }
  });

  success(res, posts);
});

router.post('/like/:id', authMiddleware, (req: AuthRequest, res) => {
  const postId = parseInt(req.params.id);
  if (isNaN(postId)) {
    return error(res, '无效的动态ID');
  }

  const db = getDb();

  const post = db.prepare('SELECT id, user_id FROM posts WHERE id = ? AND status = 0').get(postId) as any;
  if (!post) {
    return error(res, '动态不存在', 404, 404);
  }

  try {
    db.prepare('INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)')
      .run(postId, req.userId);
    db.prepare('UPDATE posts SET like_count = like_count + 1 WHERE id = ?').run(postId);

    if (post.user_id !== req.userId) {
      const user = db.prepare('SELECT nickname FROM users WHERE id = ?').get(req.userId) as any;
      createNotification(post.user_id, 2, '动态点赞', `${user.nickname} 赞了你的动态`, req.userId!, postId, 'post_like');
    }

    success(res, { is_liked: true, like_count: post.like_count + 1 }, '点赞成功');
  } catch (e) {
    success(res, { is_liked: true }, '已点赞');
  }
});

router.post('/unlike/:id', authMiddleware, (req: AuthRequest, res) => {
  const postId = parseInt(req.params.id);
  if (isNaN(postId)) {
    return error(res, '无效的动态ID');
  }

  const db = getDb();
  const result = db.prepare('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?')
    .run(postId, req.userId);

  if (result.changes > 0) {
    db.prepare('UPDATE posts SET like_count = like_count - 1 WHERE id = ?').run(postId);
  }

  success(res, { is_liked: false }, '取消点赞成功');
});

router.post('/collect/:id', authMiddleware, (req: AuthRequest, res) => {
  const postId = parseInt(req.params.id);
  if (isNaN(postId)) {
    return error(res, '无效的动态ID');
  }

  const db = getDb();

  const post = db.prepare('SELECT id FROM posts WHERE id = ? AND status = 0').get(postId);
  if (!post) {
    return error(res, '动态不存在', 404, 404);
  }

  try {
    db.prepare('INSERT INTO post_collects (post_id, user_id) VALUES (?, ?)')
      .run(postId, req.userId);
    db.prepare('UPDATE posts SET collect_count = collect_count + 1 WHERE id = ?').run(postId);

    success(res, { is_collected: true }, '收藏成功');
  } catch (e) {
    success(res, { is_collected: true }, '已收藏');
  }
});

router.post('/uncollect/:id', authMiddleware, (req: AuthRequest, res) => {
  const postId = parseInt(req.params.id);
  if (isNaN(postId)) {
    return error(res, '无效的动态ID');
  }

  const db = getDb();
  const result = db.prepare('DELETE FROM post_collects WHERE post_id = ? AND user_id = ?')
    .run(postId, req.userId);

  if (result.changes > 0) {
    db.prepare('UPDATE posts SET collect_count = collect_count - 1 WHERE id = ?').run(postId);
  }

  success(res, { is_collected: false }, '取消收藏成功');
});

router.get('/collections', authMiddleware, (req: AuthRequest, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;

  const db = getDb();

  const posts = db.prepare(`
    SELECT p.*, u.username, u.nickname, u.avatar, pc.created_at as collect_time
    FROM post_collects pc
    JOIN posts p ON pc.post_id = p.id
    JOIN users u ON p.user_id = u.id
    WHERE pc.user_id = ? AND p.status = 0
    ORDER BY pc.created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.userId, pageSize, offset) as any[];

  posts.forEach(post => {
    if (post.images) {
      post.images = JSON.parse(post.images);
    }
  });

  const total = db.prepare('SELECT COUNT(*) as count FROM post_collects WHERE user_id = ?')
    .get(req.userId) as any;

  success(res, paginate(posts, total.count, page, pageSize));
});

router.post('/share/:id', authMiddleware, (req: AuthRequest, res) => {
  const postId = parseInt(req.params.id);
  if (isNaN(postId)) {
    return error(res, '无效的动态ID');
  }

  const { content } = req.body;

  const db = getDb();

  const originalPost = db.prepare('SELECT * FROM posts WHERE id = ? AND status = 0').get(postId) as any;
  if (!originalPost) {
    return error(res, '动态不存在', 404, 404);
  }

  db.prepare('UPDATE posts SET share_count = share_count + 1 WHERE id = ?').run(postId);

  const newContent = content || originalPost.content;

  const result = db.prepare(`
    INSERT INTO posts (user_id, content, images, visibility)
    VALUES (?, ?, ?, 0)
  `).run(req.userId, newContent, originalPost.images);

  db.prepare(`
    INSERT INTO post_shares (post_id, user_id, original_post_id, content)
    VALUES (?, ?, ?, ?)
  `).run(result.lastInsertRowid, req.userId, postId, content || null);

  db.prepare('UPDATE users SET post_count = post_count + 1 WHERE id = ?').run(req.userId);

  if (originalPost.user_id !== req.userId) {
    const user = db.prepare('SELECT nickname FROM users WHERE id = ?').get(req.userId) as any;
    createNotification(originalPost.user_id, 4, '动态被转发', `${user.nickname} 转发了你的动态`, req.userId!, postId, 'post_share');
  }

  success(res, { id: result.lastInsertRowid }, '转发成功');
});

router.delete('/:id', authMiddleware, (req: AuthRequest, res) => {
  const postId = parseInt(req.params.id);
  if (isNaN(postId)) {
    return error(res, '无效的动态ID');
  }

  const db = getDb();

  const post = db.prepare('SELECT user_id, topic_id, circle_id FROM posts WHERE id = ?').get(postId) as any;
  if (!post) {
    return error(res, '动态不存在', 404, 404);
  }

  if (post.user_id !== req.userId) {
    return error(res, '无权限删除', 403, 403);
  }

  db.prepare('DELETE FROM posts WHERE id = ?').run(postId);
  db.prepare('UPDATE users SET post_count = post_count - 1 WHERE id = ?').run(req.userId!);

  if (post.topic_id) {
    db.prepare('UPDATE topics SET post_count = post_count - 1 WHERE id = ?').run(post.topic_id);
  }
  if (post.circle_id) {
    db.prepare('UPDATE circles SET post_count = post_count - 1 WHERE id = ?').run(post.circle_id);
  }

  success(res, null, '删除成功');
});

export default router;
