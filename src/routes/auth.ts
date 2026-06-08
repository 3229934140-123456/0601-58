import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getDb } from '../database';
import { generateToken } from '../utils/jwt';
import { success, error } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();

router.post('/register', (req, res) => {
  const { username, password, nickname } = req.body;

  if (!username || !password) {
    return error(res, '用户名和密码不能为空');
  }
  if (username.length < 3 || username.length > 20) {
    return error(res, '用户名长度需在3-20个字符之间');
  }
  if (password.length < 6) {
    return error(res, '密码长度不能少于6位');
  }

  const db = getDb();

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return error(res, '用户名已存在');
  }

  const hashedPassword = bcrypt.hashSync(password, 10);
  const result = db.prepare(`
    INSERT INTO users (username, password, nickname)
    VALUES (?, ?, ?)
  `).run(username, hashedPassword, nickname || username);

  const userId = result.lastInsertRowid as number;
  const token = generateToken({ userId, username });

  success(res, {
    token,
    user: {
      id: userId,
      username,
      nickname: nickname || username,
    },
  }, '注册成功');
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return error(res, '用户名和密码不能为空');
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;

  if (!user) {
    return error(res, '用户名或密码错误');
  }

  if (user.status !== 0) {
    return error(res, '账号已被封禁，请联系客服');
  }

  const valid = bcrypt.compareSync(password, user.password);
  if (!valid) {
    return error(res, '用户名或密码错误');
  }

  const token = generateToken({ userId: user.id, username: user.username });

  success(res, {
    token,
    user: {
      id: user.id,
      username: user.username,
      nickname: user.nickname,
      avatar: user.avatar,
      role: user.role,
    },
  }, '登录成功');
});

router.get('/profile', authMiddleware, (req: AuthRequest, res) => {
  const db = getDb();
  const user = db.prepare(`
    SELECT id, username, nickname, avatar, bio, gender, birthday, location, email, phone,
           follower_count, following_count, post_count, role, status, created_at
    FROM users WHERE id = ?
  `).get(req.userId) as any;

  if (!user) {
    return error(res, '用户不存在', 404, 404);
  }

  success(res, user);
});

router.post('/logout', authMiddleware, (_req, res) => {
  success(res, null, '退出成功');
});

export default router;
