import { getDb } from '../database';
import { MOD_LOG_TYPE, REPORT_TARGET_TYPE, APPEAL_TARGET_TYPE } from '../constants';

export function addModLog(
  operatorId: number,
  actionType: number,
  targetType: number,
  targetId: number,
  targetSummary: string,
  oldStatus: number | null,
  newStatus: number | null,
  note: string | null = null
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO moderation_logs (operator_id, action_type, target_type, target_id, target_summary, old_status, new_status, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(operatorId, actionType, targetType, targetId, targetSummary || '', oldStatus, newStatus, note);
}

export const actionTypeNames: Record<number, string> = {
  [MOD_LOG_TYPE.POST_REVIEW]: '动态审核',
  [MOD_LOG_TYPE.COMMENT_REVIEW]: '评论审核',
  [MOD_LOG_TYPE.REPORT_HANDLE]: '举报处理',
  [MOD_LOG_TYPE.USER_BAN]: '用户封禁',
  [MOD_LOG_TYPE.USER_UNBAN]: '用户解封',
  [MOD_LOG_TYPE.ANNOUNCEMENT_PUBLISH]: '公告发布',
  [MOD_LOG_TYPE.ANNOUNCEMENT_OFFLINE]: '公告下线',
  [MOD_LOG_TYPE.APPEAL_HANDLE]: '申诉处理',
};

export const targetTypeNames: Record<number, string> = {
  1: '动态',
  2: '用户',
  3: '评论',
};
