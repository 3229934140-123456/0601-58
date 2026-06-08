import { getDb } from '../database';
import { POST_VISIBILITY, CONTENT_STATUS } from '../constants';

export interface VisibilityCheckResult {
  visible: boolean;
  reason?: string;
}

export function checkPostVisibility(
  post: any,
  currentUserId: number | undefined
): VisibilityCheckResult {
  if (!post) {
    return { visible: false, reason: '动态不存在' };
  }

  const isAuthor = currentUserId && post.user_id === currentUserId;

  if (post.status !== CONTENT_STATUS.APPROVED && !isAuthor) {
    if (post.status === CONTENT_STATUS.REJECTED) {
      return { visible: false, reason: '内容已被下架' };
    }
    if (post.status === CONTENT_STATUS.PENDING) {
      return { visible: false, reason: '内容审核中' };
    }
  }

  if (isAuthor) {
    return { visible: true };
  }

  if (!currentUserId && post.visibility !== POST_VISIBILITY.PUBLIC) {
    return { visible: false, reason: '请登录后查看' };
  }

  switch (post.visibility) {
    case POST_VISIBILITY.PUBLIC:
      return { visible: true };

    case POST_VISIBILITY.FOLLOWERS_ONLY: {
      if (!currentUserId) {
        return { visible: false, reason: '请登录后查看' };
      }
      const db = getDb();
      const follow = db.prepare(
        'SELECT id FROM follows WHERE follower_id = ? AND following_id = ?'
      ).get(currentUserId, post.user_id);
      if (!follow) {
        return { visible: false, reason: '仅关注者可见' };
      }
      return { visible: true };
    }

    case POST_VISIBILITY.PRIVATE:
      return { visible: false, reason: '仅作者可见' };

    case POST_VISIBILITY.CIRCLE_ONLY: {
      if (!currentUserId || !post.circle_id) {
        return { visible: false, reason: '仅圈子成员可见' };
      }
      const db = getDb();
      const member = db.prepare(
        'SELECT status FROM circle_members WHERE circle_id = ? AND user_id = ?'
      ).get(post.circle_id, currentUserId) as any;
      if (!member || member.status !== 1) {
        return { visible: false, reason: '仅圈子成员可见' };
      }
      return { visible: true };
    }

    default:
      return { visible: true };
  }
}

export function maskPost(post: any, reason?: string): any {
  return {
    id: post.id,
    user_id: post.user_id,
    username: post.username,
    nickname: post.nickname,
    avatar: post.avatar,
    visibility: post.visibility,
    topic_id: post.topic_id,
    topic_name: post.topic_name,
    circle_id: post.circle_id,
    circle_name: post.circle_name,
    like_count: post.like_count,
    comment_count: post.comment_count,
    share_count: post.share_count,
    view_count: post.view_count,
    is_top: post.is_top,
    created_at: post.created_at,
    content: null,
    images: null,
    is_liked: false,
    is_collected: false,
    is_masked: true,
    mask_reason: reason || '无权限查看',
  };
}

export function processPostList(posts: any[], currentUserId: number | undefined): any[] {
  if (posts.length === 0) return posts;

  const db = getDb();

  const authorIds = [...new Set(posts.map(p => p.user_id))];
  const circleIds = [...new Set(posts.filter(p => p.circle_id).map(p => p.circle_id))];

  const followMap = new Map<number, boolean>();
  if (currentUserId && authorIds.length > 0) {
    const placeholders = authorIds.map(() => '?').join(',');
    const follows = db.prepare(`
      SELECT following_id FROM follows
      WHERE follower_id = ? AND following_id IN (${placeholders})
    `).all(currentUserId, ...authorIds) as any[];
    follows.forEach(f => followMap.set(f.following_id, true));
  }

  const circleMemberMap = new Map<number, boolean>();
  if (currentUserId && circleIds.length > 0) {
    const placeholders = circleIds.map(() => '?').join(',');
    const members = db.prepare(`
      SELECT circle_id FROM circle_members
      WHERE user_id = ? AND circle_id IN (${placeholders}) AND status = 1
    `).all(currentUserId, ...circleIds) as any[];
    members.forEach(m => circleMemberMap.set(m.circle_id, true));
  }

  return posts.map(post => {
    const isAuthor = currentUserId && post.user_id === currentUserId;

    if (post.status !== CONTENT_STATUS.APPROVED && !isAuthor) {
      return maskPost(post, post.status === CONTENT_STATUS.REJECTED ? '内容已被下架' : '内容审核中');
    }

    if (isAuthor) {
      if (post.images && typeof post.images === 'string') {
        post.images = JSON.parse(post.images);
      }
      return post;
    }

    let visible = true;
    let maskReason = '';

    switch (post.visibility) {
      case POST_VISIBILITY.PUBLIC:
        visible = true;
        break;

      case POST_VISIBILITY.FOLLOWERS_ONLY:
        if (!currentUserId) {
          visible = false;
          maskReason = '请登录后查看';
        } else if (!followMap.has(post.user_id)) {
          visible = false;
          maskReason = '仅关注者可见';
        }
        break;

      case POST_VISIBILITY.PRIVATE:
        visible = false;
        maskReason = '仅作者可见';
        break;

      case POST_VISIBILITY.CIRCLE_ONLY:
        if (!currentUserId || !post.circle_id) {
          visible = false;
          maskReason = '仅圈子成员可见';
        } else if (!circleMemberMap.has(post.circle_id)) {
          visible = false;
          maskReason = '仅圈子成员可见';
        }
        break;
    }

    if (!visible) {
      return maskPost(post, maskReason);
    }

    if (post.images && typeof post.images === 'string') {
      post.images = JSON.parse(post.images);
    }
    return post;
  });
}

export function attachUserInteractions(posts: any[], userId: number | undefined): any[] {
  if (!userId || posts.length === 0) return posts;

  const db = getDb();
  const postIds = posts.filter(p => !p.is_masked).map(p => p.id);
  if (postIds.length === 0) return posts;

  const placeholders = postIds.map(() => '?').join(',');

  const likes = db.prepare(`
    SELECT post_id FROM post_likes
    WHERE user_id = ? AND post_id IN (${placeholders})
  `).all(userId, ...postIds) as any[];
  const likeSet = new Set(likes.map(l => l.post_id));

  const collects = db.prepare(`
    SELECT post_id FROM post_collects
    WHERE user_id = ? AND post_id IN (${placeholders})
  `).all(userId, ...postIds) as any[];
  const collectSet = new Set(collects.map(c => c.post_id));

  return posts.map(post => {
    if (post.is_masked) return post;
    return {
      ...post,
      is_liked: likeSet.has(post.id),
      is_collected: collectSet.has(post.id),
    };
  });
}
