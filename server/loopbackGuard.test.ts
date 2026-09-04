import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

import { isLoopbackAddress, loopbackGuard } from './loopbackGuard.js';

// --- isLoopbackAddress: 判定ロジックの単体テスト ---
test('127.0.0.1はループバックと判定される', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
});

test('::1(IPv6ループバック)はループバックと判定される', () => {
  assert.equal(isLoopbackAddress('::1'), true);
});

test('::ffff:127.0.0.1(IPv4射影アドレス)はループバックと判定される', () => {
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
});

test('LAN上の他ホスト(例: 192.168.1.5)はループバックと判定されない', () => {
  assert.equal(isLoopbackAddress('192.168.1.5'), false);
});

test('外部ホスト(例: 10.0.0.2)はループバックと判定されない', () => {
  assert.equal(isLoopbackAddress('10.0.0.2'), false);
});

test('undefined/空文字はループバックと判定されない', () => {
  assert.equal(isLoopbackAddress(undefined), false);
  assert.equal(isLoopbackAddress(null), false);
  assert.equal(isLoopbackAddress(''), false);
});

// --- loopbackGuard: ミドルウェア単体テスト(モックreq/res) ---
function mockRes() {
  const state: { statusCode?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  };
  return { res: res as any, state };
}

test('ループバックからのリクエストはnext()が呼ばれ、403は返さない', () => {
  const req = { socket: { remoteAddress: '127.0.0.1' } } as any;
  const { res, state } = mockRes();
  let nextCalled = false;
  loopbackGuard(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(state.statusCode, undefined);
});

test('非ループバックからのリクエストは403で拒否され、next()は呼ばれない', () => {
  const req = { socket: { remoteAddress: '203.0.113.5' } } as any;
  const { res, state } = mockRes();
  let nextCalled = false;
  loopbackGuard(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(state.statusCode, 403);
  assert.match((state.body as any).error, /localhost/);
});

// --- 回帰確認: 実際のHTTP経路で、localhost経由の通常アクセスが壊れていないこと ---
test('実サーバーへのlocalhost経由アクセスはガードを通過して200が返る', async () => {
  const app = express();
  app.use(loopbackGuard);
  app.get('/ping', (_req, res) => res.status(200).json({ ok: true }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ping`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true });
  } finally {
    server.close();
  }
});
