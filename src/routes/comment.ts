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

router.post('/:postId', authMiddleware, (req: AuthRequest, res) => {
  const postId = parseInt(req.params.postId);
  const { content, parent_id, reply_to_user_id } = req.body;

  if (isNaN(postId)) {
    return error(res, '无效的动态ID');
  }
  if (!content || !content.trim()) {
    return error(res, '评论内容不能为空');
  }
  if (content.length > 1000) {
    return error(res, '评论内容不能超过1000字');
  }

  const db = getDb();

  const post = db.prepare('SELECT id, user_id FROM posts WHERE id = ? AND status = 0').get(postId) as any;
  if (!post) {
    return error(res, '动态不存在', 404, 404);
  }

  if (parent_id) {
    const parent = db.prepare('SELECT id, user_id FROM comments WHERE id = ?').get(parent_id) as any;
    if (!parent) {
      return error(res, '父评论不存在');
    }
  }

  const result = db.prepare(`
    INSERT INTO comments (post_id, user_id, content, parent_id, reply_to_user_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(postId, req.userId, content.trim(), parent_id || null, reply_to_user_id || null);

  db.prepare('UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?').run(postId);

  const commentId = result.lastInsertRowid as number;

  if (post.user_id !== req.userId) {
    const user = db.prepare('SELECT nickname FROM users WHERE id = ?').get(req.userId) as any;
    createNotification(post.user_id, 3, '新评论', `${user.nickname} 评论了你的动态`, req.userId!, postId, 'comment');
  }

  if (reply_to_user_id && reply_to_user_id !== req.userId) {
    const user = db.prepare('SELECT nickname FROM users WHERE id = ?').get(req.userId) as any;
    createNotification(reply_to_user_id, 3, '回复你的评论', `${user.nickname} 回复了你的评论`, req.userId!, commentId, 'comment_reply');
  }

  const comment = db.prepare(`
    SELECT c.*, u.username, u.nickname, u.avatar
    FROM comments c
    JOIN users u ON c.user_id = u.id
    WHERE c.id = ?
  `).get(commentId);

  success(res, comment, '评论成功');
});

router.get('/list/:postId', optionalAuthMiddleware, (req: AuthRequest, res) => {
  const postId = parseInt(req.params.postId);
  if (isNaN(postId)) {
    return error(res, '无效的动态ID');
  }

  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;

  const db = getDb();

  const comments = db.prepare(`
    SELECT c.*, u.username, u.nickname, u.avatar,
           ru.nickname as reply_to_nickname
    FROM comments c
    JOIN users u ON c.user_id = u.id
    LEFT JOIN users ru ON c.reply_to_user_id = ru.id
    WHERE c.post_id = ? AND c.status = 0 AND c.parent_id IS NULL
    ORDER BY c.created_at DESC
    LIMIT ? OFFSET ?
  `).all(postId, pageSize, offset) as any[];

  const total = db.prepare('SELECT COUNT(*) as count FROM comments WHERE post_id = ? AND status = 0 AND parent_id IS NULL')
    .get(postId) as any;

  success(res, paginate(comments, total.count, page, pageSize));
});

router.get('/replies/:commentId', optionalAuthMiddleware, (req: AuthRequest, res) => {
  const commentId = parseInt(req.params.commentId);
  if (isNaN(commentId)) {
    return error(res, '无效的评论ID');
  }

  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;

  const db = getDb();

  const replies = db.prepare(`
    SELECT c.*, u.username, u.nickname, u.avatar,
           ru.nickname as reply_to_nickname
    FROM comments c
    JOIN users u ON c.user_id = u.id
    LEFT JOIN users ru ON c.reply_to_user_id = ru.id
    WHERE c.parent_id = ? AND c.status = 0
    ORDER BY c.created_at ASC
    LIMIT ? OFFSET ?
  `).all(commentId, pageSize, offset) as any[];

  const total = db.prepare('SELECT COUNT(*) as count FROM comments WHERE parent_id = ? AND status = 0')
    .get(commentId) as any;

  success(res, paginate(replies, total.count, page, pageSize));
});

router.post('/like/:commentId', authMiddleware, (req: AuthRequest, res) => {
  const commentId = parseInt(req.params.commentId);
  if (isNaN(commentId)) {
    return error(res, '无效的评论ID');
  }

  const db = getDb();

  const comment = db.prepare('SELECT id, status FROM comments WHERE id = ?').get(commentId) as any;
  if (!comment) {
    return error(res, '评论不存在', 404, 404);
  }
  if (comment.status !== 0) {
    return error(res, '评论不可用');
  }

  const existingLike = db.prepare('SELECT id FROM comment_likes WHERE comment_id = ? AND user_id = ?')
    .get(commentId, req.userId);

  if (existingLike) {
    const current = db.prepare('SELECT like_count FROM comments WHERE id = ?').get(commentId) as any;
    return success(res, { is_liked: true, like_count: current.like_count }, '已点赞');
  }

  const dbTx = db.transaction(() => {
    db.prepare('INSERT INTO comment_likes (comment_id, user_id) VALUES (?, ?)')
      .run(commentId, req.userId);
    db.prepare('UPDATE comments SET like_count = like_count + 1 WHERE id = ?').run(commentId);
  });
  dbTx();

  const current = db.prepare('SELECT like_count FROM comments WHERE id = ?').get(commentId) as any;
  success(res, { is_liked: true, like_count: current.like_count }, '点赞成功');
});

router.post('/unlike/:commentId', authMiddleware, (req: AuthRequest, res) => {
  const commentId = parseInt(req.params.commentId);
  if (isNaN(commentId)) {
    return error(res, '无效的评论ID');
  }

  const db = getDb();

  const comment = db.prepare('SELECT id FROM comments WHERE id = ?').get(commentId);
  if (!comment) {
    return error(res, '评论不存在', 404, 404);
  }

  const existingLike = db.prepare('SELECT id FROM comment_likes WHERE comment_id = ? AND user_id = ?')
    .get(commentId, req.userId);

  if (!existingLike) {
    const current = db.prepare('SELECT like_count FROM comments WHERE id = ?').get(commentId) as any;
    return success(res, { is_liked: false, like_count: current.like_count }, '未点赞');
  }

  const dbTx = db.transaction(() => {
    db.prepare('DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?')
      .run(commentId, req.userId);
    db.prepare('UPDATE comments SET like_count = like_count - 1 WHERE id = ?').run(commentId);
  });
  dbTx();

  const current = db.prepare('SELECT like_count FROM comments WHERE id = ?').get(commentId) as any;
  success(res, { is_liked: false, like_count: current.like_count }, '取消点赞成功');
});

router.delete('/:commentId', authMiddleware, (req: AuthRequest, res) => {
  const commentId = parseInt(req.params.commentId);
  if (isNaN(commentId)) {
    return error(res, '无效的评论ID');
  }

  const db = getDb();

  const comment = db.prepare('SELECT id, user_id, post_id FROM comments WHERE id = ?').get(commentId) as any;
  if (!comment) {
    return error(res, '评论不存在', 404, 404);
  }

  if (comment.user_id !== req.userId) {
    return error(res, '无权限删除', 403, 403);
  }

  db.prepare('DELETE FROM comments WHERE id = ?').run(commentId);
  db.prepare('UPDATE posts SET comment_count = comment_count - 1 WHERE id = ?').run(comment.post_id);

  success(res, null, '删除成功');
});

export default router;
