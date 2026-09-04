import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createFetchTimeout, combineSignals } from './utils.js';

// --- createFetchTimeout ---
test('createFetchTimeoutは指定時間後にsignalをabortする', async () => {
  const { signal, clear } = createFetchTimeout(50);
  assert.equal(signal.aborted, false);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(signal.aborted, true);
  clear();
});

test('createFetchTimeoutのclear()を呼べばタイムアウトは発火しない', async () => {
  const { signal, clear } = createFetchTimeout(50);
  clear();
  await new Promise(r => setTimeout(r, 100));
  assert.equal(signal.aborted, false);
});

// --- combineSignals ---
test('combineSignals: userSignalが無い場合はtimeoutSignalをそのまま返す', () => {
  const { signal: timeoutSignal, clear } = createFetchTimeout(10_000);
  const combined = combineSignals(undefined, timeoutSignal);
  assert.equal(combined, timeoutSignal);
  clear();
});

test('combineSignals: どちらかがabortされれば合成signalもabortされる(タイムアウト側)', async () => {
  const { signal: timeoutSignal, clear } = createFetchTimeout(30);
  const userController = new AbortController();
  const combined = combineSignals(userController.signal, timeoutSignal);
  assert.equal(combined.aborted, false);
  await new Promise(r => setTimeout(r, 80));
  assert.equal(combined.aborted, true);
  clear();
});

test('combineSignals: ユーザー側signalのabortでも合成signalがabortされる', () => {
  const { signal: timeoutSignal, clear } = createFetchTimeout(10_000);
  const userController = new AbortController();
  const combined = combineSignals(userController.signal, timeoutSignal);
  assert.equal(combined.aborted, false);
  userController.abort();
  assert.equal(combined.aborted, true);
  clear();
});

// --- 実際のfetch()との組み合わせ確認(応答しないサーバーへのリクエストがタイムアウトで中断されること) ---
test('応答しないサーバーへのfetchはcreateFetchTimeoutで中断される', async () => {
  // ヘッダーもボディも一切返さず接続だけ受け付けるサーバー
  const server = http.createServer(() => { /* 何も応答しない */ });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;

  const fetchTimeout = createFetchTimeout(100);
  const start = Date.now();
  try {
    await assert.rejects(
      () => fetch(`http://127.0.0.1:${port}/`, { signal: fetchTimeout.signal }),
      (err: unknown) => err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 5000, `タイムアウトが機能せず長時間待機した(${elapsed}ms)`);
  } finally {
    fetchTimeout.clear();
    server.close();
  }
});

test('応答が速いサーバーへのfetchはタイムアウト前に正常完了する', async () => {
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;

  const fetchTimeout = createFetchTimeout(5000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: fetchTimeout.signal });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
  } finally {
    fetchTimeout.clear();
    server.close();
  }
});
