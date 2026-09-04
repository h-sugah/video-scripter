// LAN公開モード向けの認証・CSRF対策。
//
// 設計方針:
// - localhost(ループバック)からのアクセスは従来どおり無認証（このモジュールのチェックは全て素通り）。
// - 非ループバック接続は、LANモードが有効な場合のみ許可され、必ずセッションCookieまたは
//   Bearerトークンでの認証が必要になる。
// - Origin検証はループバック/LAN問わず常時有効。これはloopbackGuard単体では防げない
//   DNSリバインディング攻撃（悪意あるWebページのオリジンを127.0.0.1へ解決させ、
//   ブラウザに正規のTCP接続をさせた上でCSRF的にAPIを叩かせる手口）を塞ぐために必要。
// - CSRF対策ヘッダーも常時必須。単純なフォーム送信型CSRFはカスタムヘッダーを付与できず、
//   fetchによるクロスオリジンCSRFもCORS未許可のためプリフライトで失敗する。
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NextFunction, Request, Response } from 'express';

import { isLoopbackAddress } from './loopbackGuard.js';

export const SESSION_COOKIE_NAME = 'vs_lan_session';
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24時間
export const CSRF_HEADER_NAME = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'video-scripter';

const LOGIN_ATTEMPT_WINDOW_MS = 60 * 1000;
const LOGIN_ATTEMPT_MAX = 10;

// --- LANアクセス用トークンの生成・永続化 ---
export function ensureLanAuthToken(dataDir: string): string {
  const tokenPath = join(dataDir, 'lan-auth-token');
  if (existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, 'utf8').trim();
    if (existing) return existing;
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(tokenPath, token, { mode: 0o600 });
  try { chmodSync(tokenPath, 0o600); } catch {}
  return token;
}

export function verifyToken(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// --- セッション管理（インメモリ。サーバー再起動でクリアされる） ---
interface SessionEntry { expiresAt: number; }
const sessions = new Map<string, SessionEntry>();

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (entry.expiresAt <= now) sessions.delete(id);
  }
}

export function createSession(): string {
  cleanupExpiredSessions();
  const id = randomBytes(32).toString('hex');
  sessions.set(id, { expiresAt: Date.now() + SESSION_TTL_MS });
  return id;
}

export function isValidSession(id: string | undefined): boolean {
  if (!id) return false;
  const entry = sessions.get(id);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    sessions.delete(id);
    return false;
  }
  return true;
}

export function destroySession(id: string | undefined): void {
  if (id) sessions.delete(id);
}

// --- Cookie解析（cookie-parser相当を自前実装。読み取り専用の単純な用途のため） ---
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

// --- ログイン試行のレート制限（簡易・インメモリ。トークンは高エントロピーだが多層防御として） ---
interface AttemptEntry { count: number; windowStart: number; }
const loginAttempts = new Map<string, AttemptEntry>();

export function isLoginRateLimited(key: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.windowStart > LOGIN_ATTEMPT_WINDOW_MS) {
    return false;
  }
  return entry.count >= LOGIN_ATTEMPT_MAX;
}

export function recordLoginAttempt(key: string): void {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.windowStart > LOGIN_ATTEMPT_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, windowStart: now });
    return;
  }
  entry.count += 1;
}

export function resetLoginAttempts(key: string): void {
  loginAttempts.delete(key);
}

// --- Origin検証 + CSRF対策ヘッダー検証（常時適用: ループバック/LAN問わず） ---
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  if (!MUTATING_METHODS.has(req.method) || !req.path.startsWith('/api/')) {
    next();
    return;
  }

  const origin = req.headers.origin;
  if (origin) {
    const expected = `${req.protocol}://${req.headers.host}`;
    if (origin !== expected) {
      res.status(403).json({ error: `許可されていないOriginからのリクエストです (${origin})` });
      return;
    }
  } else if (!isLoopbackAddress(req.socket.remoteAddress)) {
    // LAN経由でOriginヘッダーの無い状態変更リクエストは受け付けない。
    // ループバックはブラウザ以外のローカルツール(curl等)からの利用を考慮し許容する。
    res.status(403).json({ error: 'Originヘッダーが必要です。' });
    return;
  }

  if (req.headers[CSRF_HEADER_NAME] !== CSRF_HEADER_VALUE) {
    res.status(403).json({ error: 'CSRF対策ヘッダーが不足しています。' });
    return;
  }

  next();
}

// --- 認証必須ミドルウェア（LANモード有効時のみ登録） ---
function isProtectedPath(path: string): boolean {
  if (path === '/api/auth/login' || path === '/api/auth/logout') return false;
  return path.startsWith('/api/') || path.startsWith('/media/frames');
}

export function createRequireAuth(getToken: () => string) {
  return function requireAuth(req: Request, res: Response, next: NextFunction): void {
    if (!isProtectedPath(req.path)) {
      next();
      return;
    }
    if (isLoopbackAddress(req.socket.remoteAddress)) {
      next();
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    if (isValidSession(cookies[SESSION_COOKIE_NAME])) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const candidate = authHeader.slice('Bearer '.length).trim();
      if (candidate && verifyToken(candidate, getToken())) {
        next();
        return;
      }
    }

    res.status(401).json({ error: 'LAN経由でのアクセスには認証が必要です。' });
  };
}

// --- ログイン/ログアウトのルートハンドラ ---
export function createLoginHandler(getToken: () => string) {
  return function login(req: Request, res: Response): void {
    const key = req.socket.remoteAddress || 'unknown';
    if (isLoginRateLimited(key)) {
      res.status(429).json({ error: 'ログイン試行回数が多すぎます。しばらく待ってから再試行してください。' });
      return;
    }

    const candidate = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!candidate || !verifyToken(candidate, getToken())) {
      recordLoginAttempt(key);
      res.status(401).json({ error: 'トークンが正しくありません。' });
      return;
    }

    resetLoginAttempts(key);
    const sessionId = createSession();
    res.cookie(SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: 'strict',
      secure: false,
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
    res.status(204).end();
  };
}

export function logoutHandler(req: Request, res: Response): void {
  const cookies = parseCookies(req.headers.cookie);
  destroySession(cookies[SESSION_COOKIE_NAME]);
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  res.status(204).end();
}
