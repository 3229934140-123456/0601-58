import { initDatabase, getDb } from './index';
import bcrypt from 'bcryptjs';

function seedData() {
  const db = getDb();

  const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!adminExists) {
    const hashedPassword = bcrypt.hashSync('admin123456', 10);
    db.prepare(`
      INSERT INTO users (username, password, nickname, role, status, bio)
      VALUES (?, ?, ?, 2, 0, '平台管理员')
    `).run('admin', hashedPassword, '管理员');
    console.log('Created admin user: admin / admin123456');
  }

  const sampleUsers = [
    { username: 'zhangsan', nickname: '张三', bio: '热爱生活，热爱分享' },
    { username: 'lisi', nickname: '李四', bio: '程序员一枚' },
    { username: 'wangwu', nickname: '王五', bio: '摄影爱好者' },
  ];

  for (const user of sampleUsers) {
    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(user.username);
    if (!exists) {
      const hashedPassword = bcrypt.hashSync('123456', 10);
      db.prepare(`
        INSERT INTO users (username, password, nickname, bio)
        VALUES (?, ?, ?, ?)
      `).run(user.username, hashedPassword, user.nickname, user.bio);
      console.log(`Created user: ${user.username} / 123456`);
    }
  }

  const sampleTopics = [
    { name: '日常生活', description: '分享你的日常生活点滴' },
    { name: '技术交流', description: '程序员的技术交流天地' },
    { name: '美食分享', description: '美食爱好者的聚集地' },
    { name: '旅行日记', description: '记录旅途中的美好时光' },
  ];

  for (const topic of sampleTopics) {
    const exists = db.prepare('SELECT id FROM topics WHERE name = ?').get(topic.name);
    if (!exists) {
      db.prepare(`
        INSERT INTO topics (name, description)
        VALUES (?, ?)
      `).run(topic.name, topic.description);
      console.log(`Created topic: ${topic.name}`);
    }
  }

  const sampleCircles = [
    { name: '前端开发者社区', description: '前端技术交流圈', ownerId: 2, type: 0 },
    { name: '摄影爱好者', description: '分享摄影作品和技巧', ownerId: 4, type: 0 },
  ];

  for (const circle of sampleCircles) {
    const exists = db.prepare('SELECT id FROM circles WHERE name = ?').get(circle.name);
    if (!exists) {
      const result = db.prepare(`
        INSERT INTO circles (name, description, owner_id, type, member_count)
        VALUES (?, ?, ?, ?, 1)
      `).run(circle.name, circle.description, circle.ownerId, circle.type);

      db.prepare(`
        INSERT INTO circle_members (circle_id, user_id, role, status)
        VALUES (?, ?, 1, 1)
      `).run(result.lastInsertRowid, circle.ownerId);

      console.log(`Created circle: ${circle.name}`);
    }
  }

  console.log('Data seeding completed.');
}

initDatabase();
seedData();
