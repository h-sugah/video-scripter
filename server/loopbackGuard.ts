// localhost専用アプリとしての多層防御。
// HOSTのバインド設定(既定: 127.0.0.1)に加えて、アプリ層でも接続元がループバック
// アドレスであることを確認する。HOSTの誤設定やリバースプロキシ経由の想定外の露出が
// あっても、非ループバックからのリクエストは静的アセット・SPA配信も含めて全て拒否する。
//
// 判定にはTCP接続元(req.socket.remoteAddress)のみを用いる。
// X-Forwarded-For等のリクエストヘッダはクライアントが自由に偽装できるため信頼しない。
import type { NextFunction, Request, Response } from 'express';

export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return normalized === '127.0.0.1' || normalized === '::1';
}

export function loopbackGuard(req: Request, res: Response, next: NextFunction): void {
  if (isLoopbackAddress(req.socket.remoteAddress)) {
    next();
    return;
  }
  res.status(403).json({ error: 'このアプリケーションは localhost からのみアクセスできます。' });
}
