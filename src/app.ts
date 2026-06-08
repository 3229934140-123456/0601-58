import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import * as path from 'path';
import { config } from './config';
import { initDatabase } from './database';
import { error } from './utils/response';

import authRoutes from './routes/auth';
import userRoutes from './routes/user';
import followRoutes from './routes/follow';
import postRoutes from './routes/post';
import commentRoutes from './routes/comment';
import circleRoutes from './routes/circle';
import notificationRoutes from './routes/notification';
import riskRoutes from './routes/risk';
import searchRoutes from './routes/search';
import uploadRoutes from './routes/upload';

const app = express();

initDatabase();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    code: 0,
    message: 'ok',
    data: {
      service: 'social-platform-backend',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    },
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/follow', followRoutes);
app.use('/api/post', postRoutes);
app.use('/api/comment', commentRoutes);
app.use('/api/circle', circleRoutes);
app.use('/api/notification', notificationRoutes);
app.use('/api/risk', riskRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/upload', uploadRoutes);

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Server error:', err);
  error(res, err.message || '服务器内部错误', 500, 500);
});

app.use((_req: Request, res: Response) => {
  error(res, '接口不存在', 404, 404);
});

app.listen(config.port, () => {
  console.log(`🚀 Social platform backend server is running on http://localhost:${config.port}`);
  console.log(`📚 API documentation: /api/health`);
});

export default app;
