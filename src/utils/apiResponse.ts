import { Response } from "express";

interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface SendSuccessOptions {
  statusCode?: number;
  message?: string;
  meta?: PaginationMeta;
}

export function sendSuccess<T>(res: Response, data: T, options: SendSuccessOptions = {}): void {
  res.status(options.statusCode ?? 200).json({
    success: true,
    message: options.message,
    data,
    meta: options.meta,
  });
}
