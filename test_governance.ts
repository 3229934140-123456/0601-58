import http from 'http';
import Database from 'better-sqlite3';
import path from 'path';

const BASE = 'localhost:3000';
const dbPath = path.join(process.cwd(), 'data', 'social.db');
const db = new Database(dbPath);

let adminToken: string;
let userToken1: string;
let userToken2: string;
let user1Id: number;
let user2Id: number;
let adminId: number;
let postId: number;
let commentId: number;
let reportId: number;
let appealId: number;

function api(method: string, path: string, data?: any, token?: string): Promise<any> {
  return new Promise((resolve) => {
    const body = data && method !== 'GET' ? JSON.stringify(data) : null;
    let reqPath = '/api' + path;
    if (method === 'GET' && data) {
      const params = new URLSearchParams();
      for (const k in data) params.set(k, data[k]);
      reqPath += '?' + params.toString();
    }
    const options: any = {
      hostname: 'localhost',
      port: 3000,
      path: reqPath,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };
    if (token) options.headers['Authorization'] = `Bearer ${token}`;
    if (body) options.headers['Content-Length'] = Buffer.byteLength(body);

    const req = http.request(options, (res) => {
      let chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString());
          resolve(result);
        } catch (e) {
          resolve({ error: 'parse failed', raw: Buffer.concat(chunks).toString() });
        }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    if (body) req.write(body);
    req.end();
  });
}

function setAdmin(userId: number) {
  db.prepare('UPDATE users SET role = 2 WHERE id = ?').run(userId);
  console.log(`  用户#${userId} 已设为管理员`);
}

async function run() {
  console.log('=== 初始化：注册用户 ===');
  const r1 = await api('post', '/auth/register', { username: 'admin_gov', password: '123456', nickname: '管理员' });
  adminToken = r1.data?.token;
  adminId = r1.data?.user_id;
  setAdmin(adminId);

  const r2 = await api('post', '/auth/register', { username: 'author_gov', password: '123456', nickname: '作者' });
  userToken1 = r2.data?.token;
  user1Id = r2.data?.user_id;
  console.log('作者注册:', r2.code, user1Id);

  const r3 = await api('post', '/auth/register', { username: 'reporter_gov', password: '123456', nickname: '举报人' });
  userToken2 = r3.data?.token;
  user2Id = r3.data?.user_id;
  console.log('举报人注册:', r3.code, user2Id);

  console.log('\n=== 1. 准备测试数据 ===');
  const postRes = await api('post', '/post', { content: '测试治理的动态内容' }, userToken1);
  postId = postRes.data?.id;
  db.prepare('UPDATE posts SET status = 1 WHERE id = ?').run(postId);
  console.log('发布动态(改待审核):', postRes.code, postId);

  const commentRes = await api('post', `/post/${postId}/comment`, { content: '测试治理的评论内容' }, userToken2);
  commentId = commentRes.data?.comment?.id;
  db.prepare('UPDATE comments SET status = 1 WHERE id = ?').run(commentId);
  console.log('发布评论(改待审核):', commentRes.code, commentId);

  const reportRes = await api('post', '/risk/report', {
    target_type: 1, target_id: postId,
    reason: '违规内容', description: '含有不当信息'
  }, userToken2);
  reportId = reportRes.data?.id;
  console.log('提交举报:', reportRes.code, reportId);

  console.log('\n=== 2. 统一待办筛选测试 ===');
  const todoPending = await api('get', '/risk/todo?page=1&pageSize=10&status=1', null, adminToken);
  const pendingTypes = todoPending.data?.list?.reduce((acc: any, x: any) => {
    acc[x.item_type] = (acc[x.item_type] || 0) + 1;
    return acc;
  }, {});
  console.log('待办总数(status=1):', todoPending.code, todoPending.data?.total, ' 各类型:', JSON.stringify(pendingTypes));

  const todoByTarget = await api('get', `/risk/todo?target_type=1&target_id=${postId}`, null, adminToken);
  console.log('按目标筛选(动态ID):', todoByTarget.code, todoByTarget.data?.total, '条');

  const todoKeyword = await api('get', '/risk/todo?keyword=治理', null, adminToken);
  console.log('按关键词筛选(治理):', todoKeyword.code, todoKeyword.data?.total, '条');

  const todoAll = await api('get', '/risk/todo?type=all', null, adminToken);
  console.log('全部待办(含所有类型):', todoAll.code, todoAll.data?.total, '条');

  console.log('\n=== 3. 混合批量处理测试 ===');
  const batchRes = await api('post', '/risk/review/batch', {
    items: [
      { type: 'post', id: postId },
      { type: 'comment', id: commentId },
      { type: 'report', id: reportId },
      { type: 'post', id: 99999 },
    ],
    status: 0,
    review_reason: '批量审核通过测试'
  }, adminToken);
  console.log('混合批量处理结果:');
  console.log('  总数:', batchRes.data?.total);
  console.log('  成功:', batchRes.data?.success);
  console.log('  失败:', batchRes.data?.failed);
  console.log('  详情:', JSON.stringify(batchRes.data?.detail, null, 4).split('\n').map(l => '    ' + l).join('\n'));

  console.log('\n=== 4. 举报联动处理测试 ===');
  const report2Res = await api('post', '/risk/report', {
    target_type: 3, target_id: commentId,
    reason: '垃圾评论', description: '测试联动处理'
  }, userToken2);
  const report2Id = report2Res.data?.id;
  console.log('再提交一条举报(评论):', report2Res.code, report2Id);

  const handleReport = await api('post', `/risk/report/${report2Id}/handle`, {
    status: 1,
    action: 'remove',
    handle_note: '举报成立，下架评论'
  }, adminToken);
  console.log('举报联动处理(下架评论):', handleReport.code, handleReport.message);

  const commentAfter = db.prepare('SELECT status FROM comments WHERE id = ?').get(commentId) as any;
  console.log('  处理后评论状态:', commentAfter?.status, commentAfter?.status === 2 ? '(已拒绝/下架)' : '');

  console.log('\n=== 5. 申诉功能测试 ===');
  const post2Res = await api('post', '/post', { content: '申诉测试动态内容' }, userToken1);
  const post2Id = post2Res.data?.id;
  console.log('发布申诉测试动态:', post2Res.code, post2Id);

  const rejectRes = await api('post', `/risk/post/${post2Id}/review`, {
    status: 2, review_reason: '违反社区规范'
  }, adminToken);
  console.log('拒绝动态:', rejectRes.code);

  const appealRes = await api('post', '/risk/appeal', {
    target_type: 1,
    target_id: post2Id,
    reason: '内容没问题',
    description: '详细说明：这是正常内容，请求复审'
  }, userToken1);
  appealId = appealRes.data?.id;
  console.log('提交申诉:', appealRes.code, appealId);

  const todoAppeal = await api('get', '/risk/todo?type=appeal', null, adminToken);
  console.log('申诉待办:', todoAppeal.code, todoAppeal.data?.total, '条');

  const handleAppeal = await api('post', `/risk/appeal/handle/${appealId}`, {
    status: 1,
    handle_note: '申诉成立，已恢复内容'
  }, adminToken);
  console.log('处理申诉(通过):', handleAppeal.code, handleAppeal.message);

  const postAfter = await api('get', `/post/${post2Id}`, null, userToken1);
  console.log('申诉后动态状态:', postAfter.data?.status, postAfter.data?.status_text);

  console.log('\n=== 6. 治理日志测试 ===');
  const logs = await api('get', '/risk/logs?page=1&pageSize=20', null, adminToken);
  console.log('治理日志总数:', logs.code, logs.data?.total);
  console.log('日志列表(前8条):');
  logs.data?.list?.slice(0, 8).forEach((l: any) => {
    console.log(`  - [${l.created_at}] ${l.operator_name || '系统'} | ${l.action_type_name} | ${l.target_type_name}#${l.target_id} | ${l.status_change_text || ''}`);
  });

  const logsByAction = await api('get', '/risk/logs?action_type=1', null, adminToken);
  console.log('按操作类型筛选(动态审核):', logsByAction.data?.total, '条');

  const logsByTarget = await api('get', `/risk/logs?target_type=1&target_id=${postId}`, null, adminToken);
  console.log('按目标筛选(动态#' + postId + '):', logsByTarget.data?.total, '条');

  console.log('\n=== 7. 站内信通知测试 ===');
  const notices = await api('get', '/notice/messages?type=5', null, userToken1);
  console.log('作者收到的系统通知:', notices.code, notices.data?.total, '条');
  notices.data?.list?.slice(0, 4).forEach((n: any) => {
    console.log(`  - ${n.title} | ${n.content?.substring(0, 40)}...`);
  });

  const notices2 = await api('get', '/notice/messages?type=5', null, userToken2);
  console.log('举报人收到的系统通知:', notices2.code, notices2.data?.total, '条');

  console.log('\n=== 8. 封禁/解封加日志测试 ===');
  const banRes = await api('post', '/risk/ban/user/' + user2Id, { reason: '测试封禁' }, adminToken);
  console.log('封禁用户:', banRes.code, banRes.message);

  const unbanRes = await api('post', '/risk/unban/user/' + user2Id, {}, adminToken);
  console.log('解封用户:', unbanRes.code, unbanRes.message);

  const logsBan = await api('get', '/risk/logs?action_type=4', null, adminToken);
  console.log('封禁日志条数:', logsBan.data?.total);

  const logsUnban = await api('get', '/risk/logs?action_type=5', null, adminToken);
  console.log('解封日志条数:', logsUnban.data?.total);

  console.log('\n=== 9. 我的申诉测试 ===');
  const myAppeals = await api('get', '/risk/appeal/mine?page=1&pageSize=10', null, userToken1);
  console.log('我的申诉:', myAppeals.code, myAppeals.data?.total, '条');
  myAppeals.data?.list?.forEach((a: any) => {
    console.log(`  - 申诉#${a.id} 状态:${a.status_text} 目标:${a.target_type_name || ''}#${a.target_id}`);
  });

  console.log('\n=== 10. 统计概览 ===');
  const stats = await api('get', '/risk/stats', null, adminToken);
  console.log('待办统计:', JSON.stringify(stats.data, null, 2));

  console.log('\n=== 11. 公告上下线日志测试 ===');
  const annRes = await api('post', '/risk/announcement', {
    title: '治理测试公告',
    content: '测试公告内容',
    status: 1,
  }, adminToken);
  const annId = annRes.data?.id;
  console.log('创建公告:', annRes.code, annId);

  const offlineRes = await api('put', `/risk/announcement/${annId}/status`, { status: 2 }, adminToken);
  console.log('公告下线:', offlineRes.code);

  const logsAnn = await api('get', '/risk/logs?action_type=7', null, adminToken);
  console.log('公告下线日志条数:', logsAnn.data?.total);

  console.log('\n✅ 全部治理功能测试完成');
}

run().catch(console.error);
