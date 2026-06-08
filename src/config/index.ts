export const config = {
  port: process.env.PORT ? parseInt(process.env.PORT) : 3000,
  jwtSecret: process.env.JWT_SECRET || 'social-platform-secret-key-2024',
  jwtExpiresIn: '7d',
  databasePath: process.env.DB_PATH || './data/social.db',
  uploadDir: './uploads',
  pageSize: 20,
  adminToken: process.env.ADMIN_TOKEN || 'admin-secret-token-2024',
};
