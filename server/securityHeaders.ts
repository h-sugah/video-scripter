// レスポンスにセキュリティヘッダーを付与するミドルウェア。
// フロントエンドは同一オリジンのJS/CSSのみを読み込み、外部スクリプト・inline scriptや
// eval は使用しない(唯一の例外はプログレスバーのstyle属性によるインラインスタイル)。
// この実態に合わせて、可能な限り厳格なCSPを設定する。
import type { NextFunction, Request, Response } from 'express';

const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Security-Policy', CSP_DIRECTIVES);
  // frame-ancestors(CSP)でクリックジャッキング対策済みだが、CSP未対応の古いブラウザ向けに併記
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // 動画・音声デバイス等、本アプリが使用しないブラウザ機能を無効化
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  next();
}
