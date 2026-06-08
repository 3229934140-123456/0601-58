import { Response } from 'express';

export interface ApiResponse<T = any> {
  code: number;
  message: string;
  data?: T;
}

export function success<T>(res: Response, data?: T, message = 'success'): Response<ApiResponse<T>> {
  return res.json({
    code: 0,
    message,
    data,
  });
}

export function error(res: Response, message: string, code = 1, status = 400): Response<ApiResponse> {
  return res.status(status).json({
    code,
    message,
  });
}

export function paginate(list: any[], total: number, page: number, pageSize: number) {
  return {
    list,
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total,
  };
}
