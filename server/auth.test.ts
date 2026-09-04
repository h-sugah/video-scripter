import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';

import {
  ensureLanAuthToken,
  verifyToken,
  createSession,
  isValidSession,
  destroySession,
  parseCookies,
  isLoginRateLimited,
  recordLoginAttempt,
  resetLoginAttempts,
  csrfGuard,
  createRequireAuth,
  createLoginHandler,
  logoutHandler,
  SESSION_COOKIE_NAME,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
} from './auth.js';

let workDir: string;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'auth-test-'));
});

after(() => {
  try { rmSync(workDir, { recursive: true, force: true }); } catch {}
});

// --- ensureLanAuthToken ---
test('ensureLanAuthTokenは初回呼び出しでトークンを生成しファイルに保存する', () => {
  const dir = mkdtempSync(join(workDir, 'token-'));
  const token = ensureLanAuthToken(dir);
  assert.equal(typeof token, 'string');
  assert.equal(token.length, 64); // 32byte hex

  const filePath = join(dir, 'lan-auth-token');
  const saved = readFileSync(filePath, 'utf8').trim();
  assert.equal(saved, token);

  const mode = statSync(filePath).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('ensureLanAuthTokenは2回目以降同じトークンを返す', () => {
  const dir = mkdtempSync(join(workDir, 'token-'));
  const first = ensureLanAuthToken(dir);
  const second = ensureLanAuthToken(dir);
  assert.equal(first, second);
});

// --- verifyToken ---
test('verifyTokenは一致する場合trueを返す', () => {
  assert.equal(verifyToken('abc123', 'abc123'), true);
});

test('verifyTokenは不一致の場合falseを返す', () => {
  assert.equal(verifyToken('abc123', 'xyz999'), false);
});

test('verifyTokenは長さが異なる場合例外を投げずfalseを返す', () => {
  assert.equal(verifyToken('short', 'much-longer-token-value'), false);
});

// --- セッション管理 ---
test('createSessionで発行したセッションはisValidSessionでtrueになる', () => {
  const id = createSession();
  assert.equal(isValidSession(id), true);
});

test('存在しないセッションIDはisValidSessionでfalse', () => {
  assert.equal(isValidSession('nonexistent'), false);
  assert.equal(isValidSession(undefined), false);
});

test('destroySessionで破棄したセッションはisValidSessionでfalseになる', () => {
  const id = createSession();
  destroySession(id);
  assert.equal(isValidSession(id), false);
});

// --- parseCookies ---
test('parseCookiesは複数Cookieを正しく分解する', () => {
  const parsed = parseCookies('a=1; b=hello%20world; c=');
  assert.deepEqual(parsed, { a: '1', b: 'hello world', c: '' });
});

test('parseCookiesはundefinedの場合空オブジェクトを返す', () => {
  assert.deepEqual(parseCookies(undefined), {});
});

// --- ログイン試行レート制限 ---
test('ログイン試行が上限未満ならisLoginRateLimitedはfalse', () => {
  const key = 'rl-test-1';
  for (let i = 0; i < 5; i++) recordLoginAttempt(key);
  assert.equal(isLoginRateLimited(key), false);
});

test('ログイン試行が上限(10回)に達するとisLoginRateLimitedはtrueになる', () => {
  const key = 'rl-test-2';
  for (let i = 0; i < 10; i++) recordLoginAttempt(key);
  assert.equal(isLoginRateLimited(key), true);
});

test('resetLoginAttemptsで制限がクリアされる', () => {
  const key = 'rl-test-3';
  for (let i = 0; i < 10; i++) recordLoginAttempt(key);
  assert.equal(isLoginRateLimited(key), true);
  resetLoginAttempts(key);
  assert.equal(isLoginRateLimited(key), false);
});

// --- csrfGuard: モックreq/resでの単体テスト ---
function mockRes() {
  const state: { statusCode?: number; body?: unknown } = {};
  const res = {
    status(code: number) { state.statusCode = code; return res; },
    json(body: unknown) { state.body = body; return res; },
  };
  return { res: res as any, state };
}

function mockReq(opts: { method: string; path: string; origin?: string; host?: string; remoteAddress?: string; csrfHeader?: string }) {
  return {
    method: opts.method,
    path: opts.path,
    protocol: 'http',
    socket: { remoteAddress: opts.remoteAddress ?? '127.0.0.1' },
    headers: {
      ...(opts.origin ? { origin: opts.origin } : {}),
      host: opts.host ?? '127.0.0.1:5173',
      ...(opts.csrfHeader ? { [CSRF_HEADER_NAME]: opts.csrfHeader } : {}),
    },
  } as any;
}

test('csrfGuard: GETリクエストは常に通過する', () => {
  const req = mockReq({ method: 'GET', path: '/api/projects' });
  const { res, state } = mockRes();
  let called = false;
  csrfGuard(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(state.statusCode, undefined);
});

test('csrfGuard: /api/以外へのPOSTは通過する', () => {
  const req = mockReq({ method: 'POST', path: '/some/other/path' });
  const { res } = mockRes();
  let called = false;
  csrfGuard(req, res, () => { called = true; });
  assert.equal(called, true);
});

test('csrfGuard: Origin一致+正しいCSRFヘッダーがあれば通過する', () => {
  const req = mockReq({ method: 'POST', path: '/api/projects', origin: 'http://127.0.0.1:5173', csrfHeader: CSRF_HEADER_VALUE });
  const { res } = mockRes();
  let called = false;
  csrfGuard(req, res, () => { called = true; });
  assert.equal(called, true);
});

test('csrfGuard: Originが不一致なら403で拒否', () => {
  const req = mockReq({ method: 'POST', path: '/api/projects', origin: 'http://evil.example.com', csrfHeader: CSRF_HEADER_VALUE });
  const { res, state } = mockRes();
  let called = false;
  csrfGuard(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(state.statusCode, 403);
});

test('csrfGuard: ループバックでOriginヘッダーが無くてもCSRFヘッダーがあれば通過する', () => {
  const req = mockReq({ method: 'POST', path: '/api/projects', remoteAddress: '127.0.0.1', csrfHeader: CSRF_HEADER_VALUE });
  const { res } = mockRes();
  let called = false;
  csrfGuard(req, res, () => { called = true; });
  assert.equal(called, true);
});

test('csrfGuard: 非ループバックでOriginヘッダーが無いと403で拒否(LAN経由の想定)', () => {
  const req = mockReq({ method: 'POST', path: '/api/projects', remoteAddress: '192.168.1.50', csrfHeader: CSRF_HEADER_VALUE });
  const { res, state } = mockRes();
  let called = false;
  csrfGuard(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(state.statusCode, 403);
});

test('csrfGuard: Originが正しくてもCSRFヘッダーが無ければ403で拒否', () => {
  const req = mockReq({ method: 'POST', path: '/api/projects', origin: 'http://127.0.0.1:5173' });
  const { res, state } = mockRes();
  let called = false;
  csrfGuard(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(state.statusCode, 403);
});

// --- requireAuth: モックreq/resでの単体テスト ---
function mockAuthReq(opts: { path: string; remoteAddress?: string; cookie?: string; authHeader?: string }) {
  return {
    path: opts.path,
    socket: { remoteAddress: opts.remoteAddress ?? '192.168.1.50' },
    headers: {
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.authHeader ? { authorization: opts.authHeader } : {}),
    },
  } as any;
}

test('requireAuth: 保護対象外パス(SPA静的アセット等)は常に通過する', () => {
  const requireAuth = createRequireAuth(() => 'secret-token');
  const req = mockAuthReq({ path: '/assets/index.js' });
  const { res } = mockRes();
  let called = false;
  requireAuth(req, res, () => { called = true; });
  assert.equal(called, true);
});

test('requireAuth: /api/auth/loginは常に通過する', () => {
  const requireAuth = createRequireAuth(() => 'secret-token');
  const req = mockAuthReq({ path: '/api/auth/login', remoteAddress: '192.168.1.50' });
  const { res } = mockRes();
  let called = false;
  requireAuth(req, res, () => { called = true; });
  assert.equal(called, true);
});

test('requireAuth: ループバックからの保護対象パスは認証なしで通過する', () => {
  const requireAuth = createRequireAuth(() => 'secret-token');
  const req = mockAuthReq({ path: '/api/projects', remoteAddress: '127.0.0.1' });
  const { res } = mockRes();
  let called = false;
  requireAuth(req, res, () => { called = true; });
  assert.equal(called, true);
});

test('requireAuth: 非ループバック+認証情報なしは401', () => {
  const requireAuth = createRequireAuth(() => 'secret-token');
  const req = mockAuthReq({ path: '/api/projects', remoteAddress: '192.168.1.50' });
  const { res, state } = mockRes();
  let called = false;
  requireAuth(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(state.statusCode, 401);
});

test('requireAuth: 非ループバック+正しいBearerトークンは通過する', () => {
  const requireAuth = createRequireAuth(() => 'secret-token');
  const req = mockAuthReq({ path: '/api/projects', remoteAddress: '192.168.1.50', authHeader: 'Bearer secret-token' });
  const { res } = mockRes();
  let called = false;
  requireAuth(req, res, () => { called = true; });
  assert.equal(called, true);
});

test('requireAuth: 非ループバック+誤ったBearerトークンは401', () => {
  const requireAuth = createRequireAuth(() => 'secret-token');
  const req = mockAuthReq({ path: '/api/projects', remoteAddress: '192.168.1.50', authHeader: 'Bearer wrong-token' });
  const { res, state } = mockRes();
  let called = false;
  requireAuth(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(state.statusCode, 401);
});

test('requireAuth: 非ループバック+有効なセッションCookieは通過する', () => {
  const requireAuth = createRequireAuth(() => 'secret-token');
  const sessionId = createSession();
  const req = mockAuthReq({ path: '/api/projects', remoteAddress: '192.168.1.50', cookie: `${SESSION_COOKIE_NAME}=${sessionId}` });
  const { res } = mockRes();
  let called = false;
  requireAuth(req, res, () => { called = true; });
  assert.equal(called, true);
});

// --- 実HTTP経路での統合テスト(LANクライアントを模擬) ---
function buildLanTestApp(token: string) {
  const app = express();
  // テスト専用: 接続元をLAN上のクライアントに見立てる(本番コードは変更しない)。
  // 実SocketのremoteAddressはgetter専用のため、テスト目的でプロパティごと差し替える。
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: '192.168.1.77', configurable: true });
    next();
  });
  app.use(csrfGuard);
  app.use(createRequireAuth(() => token));
  app.use(express.json());
  app.post('/api/auth/login', createLoginHandler(() => token));
  app.post('/api/auth/logout', logoutHandler);
  app.get('/api/projects', (_req, res) => res.status(200).json({ ok: true }));
  app.post('/api/projects', (_req, res) => res.status(201).json({ ok: true }));
  return app;
}

async function startServer(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function extractCookie(res: Response): string {
  const raw = res.headers.get('set-cookie') || '';
  return raw.split(';')[0];
}

test('LANクライアント経路: 未認証での保護APIアクセスは401', async () => {
  const { server, baseUrl } = await startServer(buildLanTestApp('correct-token'));
  try {
    const res = await fetch(`${baseUrl}/api/projects`);
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('LANクライアント経路: 誤ったトークンでのログインは401', async () => {
  const { server, baseUrl } = await startServer(buildLanTestApp('correct-token'));
  try {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE, Origin: baseUrl },
      body: JSON.stringify({ token: 'wrong-token' }),
    });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('LANクライアント経路: 正しいトークンでログイン→Cookieでの継続アクセス→ログアウト後は再び401', async () => {
  const { server, baseUrl } = await startServer(buildLanTestApp('correct-token'));
  try {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE, Origin: baseUrl },
      body: JSON.stringify({ token: 'correct-token' }),
    });
    assert.equal(loginRes.status, 204);
    const cookie = extractCookie(loginRes as any);
    assert.match(cookie, new RegExp(`^${SESSION_COOKIE_NAME}=`));

    const authedRes = await fetch(`${baseUrl}/api/projects`, { headers: { Cookie: cookie } });
    assert.equal(authedRes.status, 200);

    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookie, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE, Origin: baseUrl },
    });
    assert.equal(logoutRes.status, 204);

    const afterLogoutRes = await fetch(`${baseUrl}/api/projects`, { headers: { Cookie: cookie } });
    assert.equal(afterLogoutRes.status, 401);
  } finally {
    server.close();
  }
});

test('LANクライアント経路: CSRFヘッダーの無いPOSTは403(Cookie認証済みでも)', async () => {
  const { server, baseUrl } = await startServer(buildLanTestApp('correct-token'));
  try {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE, Origin: baseUrl },
      body: JSON.stringify({ token: 'correct-token' }),
    });
    const cookie = extractCookie(loginRes as any);

    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: baseUrl }, // CSRFヘッダーなし
      body: JSON.stringify({ name: 'x' }),
    });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test('LANクライアント経路: Origin不一致のPOSTは403(Cookie認証済みでも)', async () => {
  const { server, baseUrl } = await startServer(buildLanTestApp('correct-token'));
  try {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE, Origin: baseUrl },
      body: JSON.stringify({ token: 'correct-token' }),
    });
    const cookie = extractCookie(loginRes as any);

    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: 'http://evil.example.com', [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
      body: JSON.stringify({ name: 'x' }),
    });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});
