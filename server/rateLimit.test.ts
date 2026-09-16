import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRateLimiter } from './rateLimit.js';

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

function mockReq(remoteAddress: string) {
  return { socket: { remoteAddress } } as any;
}

test('上限内のリクエストはnext()が呼ばれ、429は返さない', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2, message: '制限中' });
  const { res, state } = mockRes();
  let nextCalled = 0;
  limiter(mockReq('192.168.1.1'), res, () => { nextCalled += 1; });
  assert.equal(nextCalled, 1);
  assert.equal(state.statusCode, undefined);
});

test('上限を超えたリクエストは429で拒否され、next()は呼ばれない', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2, message: '制限中です' });
  const { res: res1 } = mockRes();
  limiter(mockReq('192.168.1.1'), res1, () => {});
  const { res: res2 } = mockRes();
  limiter(mockReq('192.168.1.1'), res2, () => {});

  const { res: res3, state: state3 } = mockRes();
  let nextCalled = false;
  limiter(mockReq('192.168.1.1'), res3, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(state3.statusCode, 429);
  assert.equal((state3.body as any).error, '制限中です');
});

test('IPアドレスが異なれば独立してカウントされる', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1, message: '制限中' });
  const { res: resA, state: stateA } = mockRes();
  limiter(mockReq('192.168.1.1'), resA, () => {});
  assert.equal(stateA.statusCode, undefined);

  const { res: resB, state: stateB } = mockRes();
  limiter(mockReq('192.168.1.2'), resB, () => {});
  assert.equal(stateB.statusCode, undefined);
});

test('ウィンドウ経過後はカウントがリセットされる', async () => {
  const limiter = createRateLimiter({ windowMs: 10, max: 1, message: '制限中' });
  const { res: res1 } = mockRes();
  limiter(mockReq('192.168.1.1'), res1, () => {});

  await new Promise(resolve => setTimeout(resolve, 20));

  const { res: res2, state: state2 } = mockRes();
  let nextCalled = false;
  limiter(mockReq('192.168.1.1'), res2, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(state2.statusCode, undefined);
});
