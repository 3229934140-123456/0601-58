import { Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import * as fs from 'fs';
import { success, error } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { config } from '../config';

const router = Router();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const uploadDir = config.uploadDir;
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const filename = `${uuidv4()}${ext}`;
    cb(null, filename);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) {
      cb(null, true);
    } else {
      cb(new Error('只支持图片文件'));
    }
  },
});

router.post('/image', authMiddleware, upload.single('file'), (req: AuthRequest, res) => {
  if (!req.file) {
    return error(res, '请选择要上传的文件');
  }

  const fileUrl = `/uploads/${req.file.filename}`;
  success(res, { url: fileUrl, filename: req.file.filename }, '上传成功');
});

router.post('/images', authMiddleware, upload.array('files', 9), (req: AuthRequest, res) => {
  if (!req.files || (Array.isArray(req.files) && req.files.length === 0)) {
    return error(res, '请选择要上传的文件');
  }

  const files = Array.isArray(req.files) ? req.files : [];
  const urls = files.map(file => ({
    url: `/uploads/${file.filename}`,
    filename: file.filename,
  }));

  success(res, { files: urls }, '上传成功');
});

export default router;
