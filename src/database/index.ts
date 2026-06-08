import Database from 'better-sqlite3';
import { config } from '../config';
import * as fs from 'fs';
import * as path from 'path';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dbDir = path.dirname(config.databasePath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    db = new Database(config.databasePath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

export function initDatabase(): void {
  const database = getDb();

  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      nickname TEXT,
      avatar TEXT,
      bio TEXT,
      gender INTEGER DEFAULT 0,
      birthday TEXT,
      location TEXT,
      email TEXT,
      phone TEXT,
      status INTEGER DEFAULT 0,
      role INTEGER DEFAULT 0,
      follower_count INTEGER DEFAULT 0,
      following_count INTEGER DEFAULT 0,
      post_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS follows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      follower_id INTEGER NOT NULL,
      following_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(follower_id, following_id),
      FOREIGN KEY (follower_id) REFERENCES users(id),
      FOREIGN KEY (following_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      blocked_user_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, blocked_user_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (blocked_user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      images TEXT,
      visibility INTEGER DEFAULT 0,
      topic_id INTEGER,
      circle_id INTEGER,
      like_count INTEGER DEFAULT 0,
      comment_count INTEGER DEFAULT 0,
      share_count INTEGER DEFAULT 0,
      collect_count INTEGER DEFAULT 0,
      view_count INTEGER DEFAULT 0,
      status INTEGER DEFAULT 0,
      review_reason TEXT,
      is_top INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS post_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      original_post_id INTEGER,
      content TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (post_id) REFERENCES posts(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS post_collects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(post_id, user_id),
      FOREIGN KEY (post_id) REFERENCES posts(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      parent_id INTEGER,
      reply_to_user_id INTEGER,
      like_count INTEGER DEFAULT 0,
      status INTEGER DEFAULT 0,
      review_reason TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (post_id) REFERENCES posts(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS comment_likes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(comment_id, user_id),
      FOREIGN KEY (comment_id) REFERENCES comments(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS post_likes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(post_id, user_id),
      FOREIGN KEY (post_id) REFERENCES posts(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      icon TEXT,
      post_count INTEGER DEFAULT 0,
      follower_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS circles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      avatar TEXT,
      owner_id INTEGER NOT NULL,
      member_count INTEGER DEFAULT 0,
      post_count INTEGER DEFAULT 0,
      type INTEGER DEFAULT 0,
      status INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (owner_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS circle_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      circle_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role INTEGER DEFAULT 0,
      status INTEGER DEFAULT 0,
      joined_at TEXT DEFAULT (datetime('now')),
      UNIQUE(circle_id, user_id),
      FOREIGN KEY (circle_id) REFERENCES circles(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS circle_join_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      circle_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      reason TEXT,
      status INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (circle_id) REFERENCES circles(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type INTEGER NOT NULL,
      title TEXT,
      content TEXT,
      related_id INTEGER,
      related_type TEXT,
      from_user_id INTEGER,
      is_read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (from_user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user_id INTEGER NOT NULL,
      to_user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      is_read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (from_user_id) REFERENCES users(id),
      FOREIGN KEY (to_user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_id INTEGER NOT NULL,
      target_type INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      reason TEXT,
      description TEXT,
      status INTEGER DEFAULT 0,
      handler_id INTEGER,
      handle_note TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (reporter_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS bans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      reason TEXT,
      end_time TEXT,
      handler_id INTEGER,
      status INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT,
      type INTEGER DEFAULT 0,
      status INTEGER DEFAULT 1,
      publisher_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (publisher_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS search_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      keyword TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_posts_user_id ON posts(user_id);
    CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_posts_topic_id ON posts(topic_id);
    CREATE INDEX IF NOT EXISTS idx_posts_circle_id ON posts(circle_id);
    CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id);
    CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
    CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
    CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(to_user_id, is_read);
  `);

  migrateDatabase(database);

  console.log('Database initialized successfully.');
}

function migrateDatabase(db: Database.Database): void {
  const columns = db.pragma('table_info(posts)') as any[];
  const hasReviewReason = columns.some((c: any) => c.name === 'review_reason');
  if (!hasReviewReason) {
    db.exec('ALTER TABLE posts ADD COLUMN review_reason TEXT');
    console.log('Migration: added review_reason to posts');
  }

  const commentColumns = db.pragma('table_info(comments)') as any[];
  const hasCommentReviewReason = commentColumns.some((c: any) => c.name === 'review_reason');
  if (!hasCommentReviewReason) {
    db.exec('ALTER TABLE comments ADD COLUMN review_reason TEXT');
    console.log('Migration: added review_reason to comments');
  }

  const reportColumns = db.pragma('table_info(reports)') as any[];
  const hasHandleNote = reportColumns.some((c: any) => c.name === 'handle_note');
  if (!hasHandleNote) {
    db.exec('ALTER TABLE reports ADD COLUMN handle_note TEXT');
    console.log('Migration: added handle_note to reports');
  }

  const hasHandledAt = reportColumns.some((c: any) => c.name === 'handled_at');
  if (!hasHandledAt) {
    db.exec('ALTER TABLE reports ADD COLUMN handled_at TEXT');
    console.log('Migration: added handled_at to reports');
  }
}
