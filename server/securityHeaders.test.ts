import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

import { securityHeaders } from './securityHeaders.js';

// --- 単体テスト(モックres) ---
function mockRes() {
  const headers: Record<string, string> = {};
  const res = {
    setHeader(name: string, value: string) { headers[name] = value; return res; },
  };
  return { res: res as any, headers };
}

test('securityHeaders: Content-Security-Policyを付与する', () => {
  const { res, headers } = mockRes();
  let called = false;
  securityHeaders({} as any, res, () => { called = true; });
  assert.equal(called, true);
  assert.match(headers['Content-Security-Policy'], /default-src 'self'/);
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
});

test('securityHeaders: X-Frame-Options: DENYを付与する', () => {
  const { res, headers } = mockRes();
  securityHeaders({} as any, res, () => {});
  assert.equal(headers['X-Frame-Options'], 'DENY');
});

test('securityHeaders: X-Content-Type-Options: nosniffを付与する', () => {
  const { res, headers } = mockRes();
  securityHeaders({} as any, res, () => {});
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
});

test('securityHeaders: Referrer-Policy: no-referrerを付与する', () => {
  const { res, headers } = mockRes();
  securityHeaders({} as any, res, () => {});
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
});

test('securityHeaders: Permissions-Policyでカメラ/マイク等を無効化する', () => {
  const { res, headers } = mockRes();
  securityHeaders({} as any, res, () => {});
  assert.match(headers['Permissions-Policy'], /camera=\(\)/);
  assert.match(headers['Permissions-Policy'], /microphone=\(\)/);
});

// --- 実HTTP経路での確認 ---
test('実サーバーのレスポンスに全ヘッダーが含まれる', async () => {
  const app = express();
  app.use(securityHeaders);
  app.get('/ping', (_req, res) => res.status(200).json({ ok: true }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ping`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-security-policy'));
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  } finally {
    server.close();
  }
});
