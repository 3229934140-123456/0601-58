export const POST_VISIBILITY = {
  PUBLIC: 0,
  FOLLOWERS_ONLY: 1,
  PRIVATE: 2,
  CIRCLE_ONLY: 3,
} as const;

export const CONTENT_STATUS = {
  APPROVED: 0,
  PENDING: 1,
  REJECTED: 2,
} as const;

export const ANNOUNCEMENT_STATUS = {
  DRAFT: 0,
  PUBLISHED: 1,
  OFFLINE: 2,
} as const;

export const NOTIFICATION_TYPE = {
  FOLLOW: 1,
  LIKE: 2,
  COMMENT: 3,
  SHARE: 4,
  SYSTEM: 5,
} as const;

export const REPORT_TARGET_TYPE = {
  POST: 1,
  USER: 2,
  COMMENT: 3,
} as const;

export const REPORT_STATUS = {
  PENDING: 0,
  PROCESSED: 1,
  REJECTED: 2,
} as const;
