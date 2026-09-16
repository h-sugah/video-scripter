// 汎用の固定ウィンドウ方式レート制限（インメモリ）。
// ログイン試行のレート制限（auth.ts の isLoginRateLimited 等）と同様の方式を、
// 動画アップロードのような重い処理を持つエンドポイントの濫用防止にも使えるよう
// ミドルウェアとして切り出したもの。
import type { NextFunction, Request, Response } from 'express';

interface WindowEntry { count: number; windowStart: number; }

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  message: string;
}

export function createRateLimiter(options: RateLimiterOptions) {
  const hits = new Map<string, WindowEntry>();

  return function rateLimiter(req: Request, res: Response, next: NextFunction): void {
    const key = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now - entry.windowStart > options.windowMs) {
      hits.set(key, { count: 1, windowStart: now });
      next();
      return;
    }

    if (entry.count >= options.max) {
      res.status(429).json({ error: options.message });
      return;
    }

    entry.count += 1;
    next();
  };
}
