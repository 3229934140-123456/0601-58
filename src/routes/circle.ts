import { Router } from 'express';
import { getDb } from '../database';
import { success, error, paginate } from '../utils/response';
import { authMiddleware, AuthRequest, optionalAuthMiddleware } from '../middleware/auth';
import { config } from '../config';

const router = Router();

router.get('/topic/list', optionalAuthMiddleware, (_req, res) => {
  const page = parseInt(_req.query.page as string) || 1;
  const pageSize = parseInt(_req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;
  const keyword = (_req.query.keyword as string) || '';

  const db = getDb();

  let whereClause = '';
  const params: any[] = [];
  if (keyword) {
    whereClause = 'WHERE name LIKE ? OR description LIKE ?';
    params.push(`%${keyword}%`, `%${keyword}%`);
  }

  const topics = db.prepare(`
    SELECT * FROM topics
    ${whereClause}
    ORDER BY post_count DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  const total = db.prepare(`SELECT COUNT(*) as count FROM topics ${whereClause}`).get(...params) as any;

  success(res, paginate(topics, total.count, page, pageSize));
});

router.get('/topic/:id', optionalAuthMiddleware, (req, res) => {
  const topicId = parseInt(req.params.id);
  if (isNaN(topicId)) {
    return error(res, '无效的话题ID');
  }

  const db = getDb();
  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(topicId);

  if (!topic) {
    return error(res, '话题不存在', 404, 404);
  }

  success(res, topic);
});

router.post('/topic', authMiddleware, (_req, res) => {
  const { name, description, icon } = _req.body;

  if (!name || !name.trim()) {
    return error(res, '话题名称不能为空');
  }

  const db = getDb();

  const existing = db.prepare('SELECT id FROM topics WHERE name = ?').get(name.trim());
  if (existing) {
    return error(res, '话题已存在');
  }

  const result = db.prepare(`
    INSERT INTO topics (name, description, icon)
    VALUES (?, ?, ?)
  `).run(name.trim(), description || null, icon || null);

  success(res, { id: result.lastInsertRowid }, '话题创建成功');
});

router.get('/list', optionalAuthMiddleware, (_req, res) => {
  const page = parseInt(_req.query.page as string) || 1;
  const pageSize = parseInt(_req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;
  const keyword = (_req.query.keyword as string) || '';
  const type = _req.query.type ? parseInt(_req.query.type as string) : null;

  const db = getDb();

  let whereClause = 'WHERE c.status = 0';
  const params: any[] = [];

  if (keyword) {
    whereClause += ' AND (c.name LIKE ? OR c.description LIKE ?)';
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  if (type !== null) {
    whereClause += ' AND c.type = ?';
    params.push(type);
  }

  const circles = db.prepare(`
    SELECT c.*, u.nickname as owner_name, u.avatar as owner_avatar
    FROM circles c
    JOIN users u ON c.owner_id = u.id
    ${whereClause}
    ORDER BY c.member_count DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  const total = db.prepare(`SELECT COUNT(*) as count FROM circles c ${whereClause}`).get(...params) as any;

  success(res, paginate(circles, total.count, page, pageSize));
});

router.get('/:id', optionalAuthMiddleware, (req, res) => {
  const circleId = parseInt(req.params.id);
  if (isNaN(circleId)) {
    return error(res, '无效的圈子ID');
  }

  const db = getDb();
  const circle = db.prepare(`
    SELECT c.*, u.nickname as owner_name, u.avatar as owner_avatar
    FROM circles c
    JOIN users u ON c.owner_id = u.id
    WHERE c.id = ? AND c.status = 0
  `).get(circleId) as any;

  if (!circle) {
    return error(res, '圈子不存在', 404, 404);
  }

  success(res, circle);
});

router.post('/', authMiddleware, (req: AuthRequest, res) => {
  const { name, description, avatar, type } = req.body;

  if (!name || !name.trim()) {
    return error(res, '圈子名称不能为空');
  }
  if (name.length > 50) {
    return error(res, '圈子名称不能超过50字');
  }

  const db = getDb();

  const result = db.prepare(`
    INSERT INTO circles (name, description, avatar, owner_id, type)
    VALUES (?, ?, ?, ?, ?)
  `).run(name.trim(), description || null, avatar || null, req.userId, type || 0);

  const circleId = result.lastInsertRowid as number;

  db.prepare(`
    INSERT INTO circle_members (circle_id, user_id, role, status)
    VALUES (?, ?, 1, 1)
  `).run(circleId, req.userId);

  db.prepare('UPDATE circles SET member_count = 1 WHERE id = ?').run(circleId);

  success(res, { id: circleId }, '圈子创建成功');
});

router.post('/join/:id', authMiddleware, (req: AuthRequest, res) => {
  const circleId = parseInt(req.params.id);
  if (isNaN(circleId)) {
    return error(res, '无效的圈子ID');
  }

  const { reason } = req.body;

  const db = getDb();

  const circle = db.prepare('SELECT id, type, status FROM circles WHERE id = ?').get(circleId) as any;
  if (!circle || circle.status !== 0) {
    return error(res, '圈子不存在');
  }

  const existingMember = db.prepare('SELECT status FROM circle_members WHERE circle_id = ? AND user_id = ?')
    .get(circleId, req.userId) as any;

  if (existingMember) {
    if (existingMember.status === 1) {
      return success(res, { status: 1 }, '已加入该圈子');
    } else if (existingMember.status === 0) {
      return success(res, { status: 0 }, '申请已提交，请等待审核');
    }
  }

  if (circle.type === 0) {
    db.prepare(`
      INSERT INTO circle_members (circle_id, user_id, role, status)
      VALUES (?, ?, 0, 1)
    `).run(circleId, req.userId);
    db.prepare('UPDATE circles SET member_count = member_count + 1 WHERE id = ?').run(circleId);
    success(res, { status: 1 }, '加入成功');
  } else {
    db.prepare(`
      INSERT INTO circle_join_requests (circle_id, user_id, reason, status)
      VALUES (?, ?, ?, 0)
    `).run(circleId, req.userId, reason || null);

    db.prepare(`
      INSERT OR IGNORE INTO circle_members (circle_id, user_id, role, status)
      VALUES (?, ?, 0, 0)
    `).run(circleId, req.userId);

    success(res, { status: 0 }, '申请已提交，请等待审核');
  }
});

router.post('/leave/:id', authMiddleware, (req: AuthRequest, res) => {
  const circleId = parseInt(req.params.id);
  if (isNaN(circleId)) {
    return error(res, '无效的圈子ID');
  }

  const db = getDb();

  const circle = db.prepare('SELECT owner_id FROM circles WHERE id = ?').get(circleId) as any;
  if (circle && circle.owner_id === req.userId) {
    return error(res, '圈主不能退出圈子');
  }

  const result = db.prepare('DELETE FROM circle_members WHERE circle_id = ? AND user_id = ?')
    .run(circleId, req.userId);

  if (result.changes > 0) {
    db.prepare('UPDATE circles SET member_count = member_count - 1 WHERE id = ?').run(circleId);
  }

  success(res, null, '已退出圈子');
});

router.get('/members/:circleId', (req, res) => {
  const circleId = parseInt(req.params.circleId);
  if (isNaN(circleId)) {
    return error(res, '无效的圈子ID');
  }

  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;

  const db = getDb();

  const members = db.prepare(`
    SELECT cm.id, cm.role, cm.joined_at, u.id as user_id, u.username, u.nickname, u.avatar, u.bio
    FROM circle_members cm
    JOIN users u ON cm.user_id = u.id
    WHERE cm.circle_id = ? AND cm.status = 1
    ORDER BY cm.role DESC, cm.joined_at ASC
    LIMIT ? OFFSET ?
  `).all(circleId, pageSize, offset);

  const total = db.prepare('SELECT COUNT(*) as count FROM circle_members WHERE circle_id = ? AND status = 1')
    .get(circleId) as any;

  success(res, paginate(members, total.count, page, pageSize));
});

router.get('/my/circles', authMiddleware, (req: AuthRequest, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || config.pageSize;
  const offset = (page - 1) * pageSize;

  const db = getDb();

  const circles = db.prepare(`
    SELECT c.*, cm.role, cm.status as member_status
    FROM circle_members cm
    JOIN circles c ON cm.circle_id = c.id
    WHERE cm.user_id = ?
    ORDER BY cm.joined_at DESC
    LIMIT ? OFFSET ?
  `).all(req.userId, pageSize, offset);

  const total = db.prepare('SELECT COUNT(*) as count FROM circle_members WHERE user_id = ?')
    .get(req.userId) as any;

  success(res, paginate(circles, total.count, page, pageSize));
});

router.post('/approve/:circleId/:userId', authMiddleware, (req: AuthRequest, res) => {
  const circleId = parseInt(req.params.circleId);
  const userId = parseInt(req.params.userId);

  if (isNaN(circleId) || isNaN(userId)) {
    return error(res, '无效的参数');
  }

  const db = getDb();

  const circle = db.prepare('SELECT owner_id FROM circles WHERE id = ?').get(circleId) as any;
  if (!circle || circle.owner_id !== req.userId) {
    return error(res, '无权限操作', 403, 403);
  }

  const member = db.prepare('SELECT * FROM circle_members WHERE circle_id = ? AND user_id = ?')
    .get(circleId, userId) as any;

  if (!member) {
    return error(res, '申请不存在');
  }

  db.prepare('UPDATE circle_members SET status = 1 WHERE circle_id = ? AND user_id = ?')
    .run(circleId, userId);

  db.prepare(`
    UPDATE circle_join_requests SET status = 1
    WHERE circle_id = ? AND user_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).run(circleId, userId);

  db.prepare('UPDATE circles SET member_count = member_count + 1 WHERE id = ?').run(circleId);

  success(res, null, '已通过申请');
});

router.get('/hot/topics', (_req, res) => {
  const db = getDb();
  const topics = db.prepare(`
    SELECT * FROM topics
    ORDER BY post_count DESC
    LIMIT 10
  `).all();

  success(res, topics);
});

export default router;
