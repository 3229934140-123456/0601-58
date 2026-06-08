import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/jwt';
import { error } from '../utils/response';

export interface AuthRequest extends Request {
  userId?: number;
  username?: string;
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    error(res, '未登录或登录已过期', 401, 401);
    return;
  }

  const token = authHeader.slice(7);
  const payload = verifyToken(token);
  if (!payload) {
    error(res, '未登录或登录已过期', 401, 401);
    return;
  }

  req.userId = payload.userId;
  req.username = payload.username;
  next();
}

export function optionalAuthMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const payload = verifyToken(token);
    if (payload) {
      req.userId = payload.userId;
      req.username = payload.username;
    }
  }
  next();
}
