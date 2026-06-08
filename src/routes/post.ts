import { Router } from 'express';
import { getDb } from '../database';
import { success, error, paginate } from '../utils/response';
import { authMiddleware, AuthRequest, optionalAuthMiddleware } from '../middleware/auth';
import { config } from '../config';
import { CONTENT_STATUS, POST_VISIBILITY } from '../constants';
import { processPostList, attachUserInteractions, checkPostVisibility } from '../utils/visibility';

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

  const vis = visibility !== undefined ? parseInt(visibility) : POST_VISIBILITY.PUBLIC;
  const validVisibilities: number[] = [POST_VISIBILITY.PUBLIC, POST_VISIBILITY.FOLLOWERS_ONLY, POST_VISIBILITY.PRIVATE, POST_VISIBILITY.CIRCLE_ONLY];
  if (!validVisibilities.includes(vis)) {
    return error(res, '无效的可见范围');
  }

  if (vis === POST_VISIBILITY.CIRCLE_ONLY && !circle_id) {
    return error(res, '圈子内可见需要指定圈子');
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
    vis,
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
  const post = db.prepare(`
    SELECT p.*, u.username, u.nickname, u.avatar,
           t.name as topic_name, c.name as circle_name
    FROM posts p
    JOIN users u ON p.user_id = u.id
    LEFT JOIN topics t ON p.topic_id = t.id
    LEFT JOIN circles c ON p.circle_id = c.id
    WHERE p.id = ?
  `).get(postId) as any;

  if (post.images) {
    post.images = JSON.parse(post.images);
  }
  post.is_liked = false;
  post.is_collected = false;

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
    WHERE p.id = ?
  `).get(postId) as any;

  if (!post) {
    return error(res, '动态不存在', 404, 404);
  }

  const isAuthor = req.userId && post.user_id === req.userId;

  if (post.status !== CONTENT_STATUS.APPROVED && !isAuthor) {
    if (post.status === CONTENT_STATUS.REJECTED) {
      return error(res, '内容已被下架', 403, 403);
    }
    if (post.status === CONTENT_STATUS.PENDING) {
      return error(res, '内容审核中', 403, 403);
    }
  }

  const processed = processPostList([post], req.userId)[0];

  if (processed.is_masked) {
    return error(res, processed.mask_reason || '无权限查看', 403, 403);
  }

  db.prepare('UPDATE posts SET view_count = view_count + 1 WHERE id = ?').run(postId);

  const result = attachUserInteractions([processed], req.userId)[0];

  success(res, result);
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

  const isSelf = req.userId && userId === req.userId;

  let whereClause = 'WHERE 1=1';
  const params: any[] = [];

  if (!isSelf) {
    whereClause += ' AND p.status = ?';
    params.push(CONTENT_STATUS.APPROVED);
  }

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

  let processed = processPostList(posts, req.userId);
  processed = attachUserInteractions(processed, req.userId);

  const total = db.prepare(`SELECT COUNT(*) as count FROM posts p ${whereClause}`)
    .get(...params) as any;

  success(res, paginate(processed, total.count, page, pageSize));
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
    WHERE p.status = ? AND p.user_id IN (
      SELECT following_id FROM follows WHERE follower_id = ?
    )
    ORDER BY p.created_at DESC
    LIMIT ? OFFSET ?
  `).all(CONTENT_STATUS.APPROVED, req.userId, pageSize, offset) as any[];

  let processed = processPostList(posts, req.userId);
  processed = attachUserInteractions(processed, req.userId);

  const total = db.prepare(`
    SELECT COUNT(*) as count FROM posts p
    WHERE p.status = ? AND p.user_id IN (
      SELECT following_id FROM follows WHERE follower_id = ?
    )
  `).get(CONTENT_STATUS.APPROVED, req.userId) as any;

  success(res, paginate(processed, total.count, page, pageSize));
});

router.get('/recommend', optionalAuthMiddleware, (req: AuthRequest, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;

  const db = getDb();

  const posts = db.prepare(`
    SELECT p.*, u.username, u.nickname, u.avatar, t.name as topic_name
    FROM posts p
    JOIN users u ON p.user_id = u.id
    LEFT JOIN topics t ON p.topic_id = t.id
    WHERE p.status = ? AND p.visibility = ?
    ORDER BY (p.like_count + p.comment_count * 2 + p.view_count / 10 + p.share_count * 3) DESC, p.created_at DESC
    LIMIT ? OFFSET ?
  `).all(CONTENT_STATUS.APPROVED, POST_VISIBILITY.PUBLIC, pageSize, offset) as any[];

  let processed = processPostList(posts, req.userId);
  processed = attachUserInteractions(processed, req.userId);

  const total = db.prepare('SELECT COUNT(*) as count FROM posts WHERE status = ? AND visibility = ?')
    .get(CONTENT_STATUS.APPROVED, POST_VISIBILITY.PUBLIC) as any;

  success(res, paginate(processed, total.count, page, pageSize));
});

router.get('/hot', optionalAuthMiddleware, (req: AuthRequest, res) => {
  const pageSize = parseInt(req.query.pageSize as string) || 20;

  const db = getDb();

  const posts = db.prepare(`
    SELECT p.*, u.username, u.nickname, u.avatar
    FROM posts p
    JOIN users u ON p.user_id = u.id
    WHERE p.status = ? AND p.visibility = ?
    ORDER BY (p.like_count * 3 + p.comment_count * 5 + p.view_count / 100 + p.share_count * 2) DESC
    LIMIT ?
  `).all(CONTENT_STATUS.APPROVED, POST_VISIBILITY.PUBLIC, pageSize) as any[];

  let processed = processPostList(posts, req.userId);
  processed = attachUserInteractions(processed, req.userId);

  success(res, processed);
});

router.post('/like/:id', authMiddleware, (req: AuthRequest, res) => {
  const postId = parseInt(req.params.id);
  if (isNaN(postId)) {
    return error(res, '无效的动态ID');
  }

  const db = getDb();

  const post = db.prepare('SELECT id, user_id, status, visibility, circle_id FROM posts WHERE id = ?').get(postId) as any;
  if (!post) {
    return error(res, '动态不存在', 404, 404);
  }
  if (post.status !== CONTENT_STATUS.APPROVED) {
    return error(res, '动态不可用');
  }

  const checkResult = processPostList([{ ...post, username: '', nickname: '', avatar: '' }], req.userId);
  if (checkResult[0].is_masked) {
    return error(res, checkResult[0].mask_reason || '无权限操作', 403, 403);
  }

  const existingLike = db.prepare('SELECT id FROM post_likes WHERE post_id = ? AND user_id = ?')
    .get(postId, req.userId);

  if (existingLike) {
    const current = db.prepare('SELECT like_count FROM posts WHERE id = ?').get(postId) as any;
    return success(res, { is_liked: true, like_count: current.like_count }, '已点赞');
  }

  const dbTx = db.transaction(() => {
    db.prepare('INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)')
      .run(postId, req.userId);
    db.prepare('UPDATE posts SET like_count = like_count + 1 WHERE id = ?').run(postId);
  });
  dbTx();

  if (post.user_id !== req.userId) {
    const user = db.prepare('SELECT nickname FROM users WHERE id = ?').get(req.userId) as any;
    createNotification(post.user_id, 2, '动态点赞', `${user.nickname} 赞了你的动态`, req.userId!, postId, 'post_like');
  }

  const current = db.prepare('SELECT like_count FROM posts WHERE id = ?').get(postId) as any;
  success(res, { is_liked: true, like_count: current.like_count }, '点赞成功');
});

router.post('/unlike/:id', authMiddleware, (req: AuthRequest, res) => {
  const postId = parseInt(req.params.id);
  if (isNaN(postId)) {
    return error(res, '无效的动态ID');
  }

  const db = getDb();

  const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(postId);
  if (!post) {
    return error(res, '动态不存在', 404, 404);
  }

  const existingLike = db.prepare('SELECT id FROM post_likes WHERE post_id = ? AND user_id = ?')
    .get(postId, req.userId);

  if (!existingLike) {
    const current = db.prepare('SELECT like_count FROM posts WHERE id = ?').get(postId) as any;
    return success(res, { is_liked: false, like_count: current.like_count }, '未点赞');
  }

  const dbTx = db.transaction(() => {
    db.prepare('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?')
      .run(postId, req.userId);
    db.prepare('UPDATE posts SET like_count = like_count - 1 WHERE id = ?').run(postId);
  });
  dbTx();

  const current = db.prepare('SELECT like_count FROM posts WHERE id = ?').get(postId) as any;
  success(res, { is_liked: false, like_count: current.like_count }, '取消点赞成功');
});

router.post('/collect/:id', authMiddleware, (req: AuthRequest, res) => {
  const postId = parseInt(req.params.id);
  if (isNaN(postId)) {
    return error(res, '无效的动态ID');
  }

  const db = getDb();

  const post = db.prepare('SELECT id, status, visibility, circle_id FROM posts WHERE id = ?').get(postId) as any;
  if (!post) {
    return error(res, '动态不存在', 404, 404);
  }
  if (post.status !== CONTENT_STATUS.APPROVED) {
    return error(res, '动态不可用');
  }

  const checkResult = processPostList([{ ...post, username: '', nickname: '', avatar: '', user_id: post.user_id }], req.userId);
  if (checkResult[0].is_masked) {
    return error(res, checkResult[0].mask_reason || '无权限操作', 403, 403);
  }

  const existingCollect = db.prepare('SELECT id FROM post_collects WHERE post_id = ? AND user_id = ?')
    .get(postId, req.userId);

  if (existingCollect) {
    const current = db.prepare('SELECT collect_count FROM posts WHERE id = ?').get(postId) as any;
    return success(res, { is_collected: true, collect_count: current.collect_count }, '已收藏');
  }

  const dbTx = db.transaction(() => {
    db.prepare('INSERT INTO post_collects (post_id, user_id) VALUES (?, ?)')
      .run(postId, req.userId);
    db.prepare('UPDATE posts SET collect_count = collect_count + 1 WHERE id = ?').run(postId);
  });
  dbTx();

  const current = db.prepare('SELECT collect_count FROM posts WHERE id = ?').get(postId) as any;
  success(res, { is_collected: true, collect_count: current.collect_count }, '收藏成功');
});

router.post('/uncollect/:id', authMiddleware, (req: AuthRequest, res) => {
  const postId = parseInt(req.params.id);
  if (isNaN(postId)) {
    return error(res, '无效的动态ID');
  }

  const db = getDb();

  const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(postId);
  if (!post) {
    return error(res, '动态不存在', 404, 404);
  }

  const existingCollect = db.prepare('SELECT id FROM post_collects WHERE post_id = ? AND user_id = ?')
    .get(postId, req.userId);

  if (!existingCollect) {
    const current = db.prepare('SELECT collect_count FROM posts WHERE id = ?').get(postId) as any;
    return success(res, { is_collected: false, collect_count: current.collect_count }, '未收藏');
  }

  const dbTx = db.transaction(() => {
    db.prepare('DELETE FROM post_collects WHERE post_id = ? AND user_id = ?')
      .run(postId, req.userId);
    db.prepare('UPDATE posts SET collect_count = collect_count - 1 WHERE id = ?').run(postId);
  });
  dbTx();

  const current = db.prepare('SELECT collect_count FROM posts WHERE id = ?').get(postId) as any;
  success(res, { is_collected: false, collect_count: current.collect_count }, '取消收藏成功');
});

router.get('/collections', authMiddleware, (req: AuthRequest, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;

  const db = getDb();

  const posts = db.prepare(`
    SELECT p.*, u.username, u.nickname, u.avatar, pc.created_at as collect_time,
           t.name as topic_name, c.name as circle_name
    FROM post_collects pc
    JOIN posts p ON pc.post_id = p.id
    JOIN users u ON p.user_id = u.id
    LEFT JOIN topics t ON p.topic_id = t.id
    LEFT JOIN circles c ON p.circle_id = c.id
    WHERE pc.user_id = ?
    ORDER BY pc.created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.userId, pageSize, offset) as any[];

  let processed = processPostList(posts, req.userId);
  processed = attachUserInteractions(processed, req.userId);

  const total = db.prepare('SELECT COUNT(*) as count FROM post_collects WHERE user_id = ?')
    .get(req.userId) as any;

  success(res, paginate(processed, total.count, page, pageSize));
});

router.post('/share/:id', authMiddleware, (req: AuthRequest, res) => {
  const postId = parseInt(req.params.id);
  if (isNaN(postId)) {
    return error(res, '无效的动态ID');
  }

  const { content } = req.body;

  const db = getDb();

  const originalPost = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId) as any;
  if (!originalPost) {
    return error(res, '动态不存在', 404, 404);
  }

  const checkResult = processPostList([{ ...originalPost, username: '', nickname: '', avatar: '' }], req.userId);
  if (checkResult[0].is_masked) {
    return error(res, checkResult[0].mask_reason || '无权限操作', 403, 403);
  }

  if (originalPost.status !== CONTENT_STATUS.APPROVED) {
    return error(res, '动态不可用');
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

router.get('/mine', authMiddleware, (req: AuthRequest, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const status = req.query.status ? parseInt(req.query.status as string) : null;

  const offset = (page - 1) * pageSize;

  const db = getDb();

  let whereClause = 'WHERE p.user_id = ?';
  const params: any[] = [req.userId];

  if (status !== null) {
    whereClause += ' AND p.status = ?';
    params.push(status);
  }

  const posts = db.prepare(`
    SELECT p.*, u.username, u.nickname, u.avatar,
           t.name as topic_name, c.name as circle_name
    FROM posts p
    JOIN users u ON p.user_id = u.id
    LEFT JOIN topics t ON p.topic_id = t.id
    LEFT JOIN circles c ON p.circle_id = c.id
    ${whereClause}
    ORDER BY p.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset) as any[];

  let processed = processPostList(posts, req.userId);
  processed = attachUserInteractions(processed, req.userId);

  const total = db.prepare(`SELECT COUNT(*) as count FROM posts p ${whereClause}`)
    .get(...params) as any;

  success(res, paginate(processed, total.count, page, pageSize));
});

export default router;
