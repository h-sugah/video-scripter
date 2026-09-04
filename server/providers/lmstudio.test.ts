import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LMStudioProvider, LMSTUDIO_RESPONSE_START_TIMEOUT_MS } from './lmstudio.js';
import { RESPONSE_START_TIMEOUT_MS, CONNECT_TEST_TIMEOUT_MS } from './utils.js';
import type { ProviderConfig } from './types.js';

let workDir: string;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'lmstudio-test-'));
  // analyzeVisionBatchはreadFileSyncで画像ファイルを読むため、中身は問わないダミーを置く
  writeFileSync(join(workDir, 'frame-001.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
});

after(() => {
  try { rmSync(workDir, { recursive: true, force: true }); } catch {}
});

function startMockServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): Promise<{ server: http.Server; port: number }> {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as any).port });
    });
  });
}

function sseChunk(res: http.ServerResponse, delta: Record<string, unknown>, finishReason: string | null = null): void {
  const payload = { choices: [{ delta, finish_reason: finishReason }] };
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function baseConfig(port: number): ProviderConfig {
  return {
    id: 'lmstudio',
    name: 'LM Studio',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: 'test-model',
  };
}

test('finish_reason:"length"の場合、トークン上限による打ち切りを明示したエラーになる(Gemma-4-12Bのケースを再現)', async () => {
  const { server, port } = await startMockServer((_req, res, _body) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sseChunk(res, { content: '```json\n{"events":[{"start_time":0.0,"descr' });
    sseChunk(res, {}, 'length');
    res.write('data: [DONE]\n\n');
    res.end();
  });

  try {
    const provider = new LMStudioProvider();
    await assert.rejects(
      () => provider.analyzeVisionBatch({
        config: baseConfig(port),
        prompt: 'test prompt',
        batchFiles: ['frame-001.jpg'],
        folder: workDir,
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /トークン上限/);
        assert.match(err.message, /max_tokens=8192/);
        return true;
      }
    );
  } finally {
    server.close();
  }
});

test('1回目・2回目とも失敗した場合、両方の失敗理由がエラーメッセージに含まれる(原因の握りつぶし防止)', async () => {
  const { server, port } = await startMockServer((_req, res, body) => {
    const isSchemaAttempt = body.includes('json_schema');
    if (!isSchemaAttempt) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal model error on first attempt' }));
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "'response_format.type' must be 'json_schema' or 'text'" }));
    }
  });

  try {
    const provider = new LMStudioProvider();
    await assert.rejects(
      () => provider.analyzeVisionBatch({
        config: baseConfig(port),
        prompt: 'test prompt',
        batchFiles: ['frame-001.jpg'],
        folder: workDir,
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /stream_plain/);
        assert.match(err.message, /internal model error on first attempt/);
        assert.match(err.message, /stream_json_schema/);
        return true;
      }
    );
  } finally {
    server.close();
  }
});

test('response_format.type には json_object ではなく json_schema を送る(Qwen3.8-27Bで拒否された値を再送しない)', async () => {
  let secondAttemptBody: any = null;
  const { server, port } = await startMockServer((_req, res, body) => {
    if (body.includes('response_format')) {
      secondAttemptBody = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sseChunk(res, { content: '{"events":[]}' });
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      // 1回目(response_formatなし)はあえて失敗させ、2回目(json_schema)まで到達させる
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'force fallback to second attempt' }));
    }
  });

  try {
    const provider = new LMStudioProvider();
    await provider.analyzeVisionBatch({
      config: baseConfig(port),
      prompt: 'test prompt',
      batchFiles: ['frame-001.jpg'],
      folder: workDir,
    });
    assert.ok(secondAttemptBody, '2回目の試行が送信されなかった');
    assert.equal(secondAttemptBody.response_format.type, 'json_schema');
    assert.notEqual(secondAttemptBody.response_format.type, 'json_object');
  } finally {
    server.close();
  }
});

test('正常系: 1回目の試行(response_formatなし)で成功すればストリームの内容を返す', async () => {
  const { server, port } = await startMockServer((_req, res, _body) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sseChunk(res, { content: '{"events":[{"start_time":0,"description":"ok"}]}' }, 'stop');
    res.write('data: [DONE]\n\n');
    res.end();
  });

  try {
    const provider = new LMStudioProvider();
    const result = await provider.analyzeVisionBatch({
      config: baseConfig(port),
      prompt: 'test prompt',
      batchFiles: ['frame-001.jpg'],
      folder: workDir,
    });
    assert.equal(result, '{"events":[{"start_time":0,"description":"ok"}]}');
  } finally {
    server.close();
  }
});

test('生成系リクエストのタイムアウトは5分(重いローカルモデルの実測応答遅延を許容)', () => {
  assert.equal(LMSTUDIO_RESPONSE_START_TIMEOUT_MS, 300_000);
  assert.ok(LMSTUDIO_RESPONSE_START_TIMEOUT_MS > RESPONSE_START_TIMEOUT_MS);
});

test('接続テスト(testConnection)は生成系より短い共通タイムアウトのまま(不必要に待たせない)', async () => {
  const { server, port } = await startMockServer((_req, res, _body) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
  });

  try {
    const provider = new LMStudioProvider();
    const result = await provider.testConnection(baseConfig(port));
    assert.deepEqual(result.models, ['test-model']);
    // testConnectionはCONNECT_TEST_TIMEOUT_MS(短い方)を使うことの確認として、
    // 生成系より小さい値であることも合わせて確認する。
    assert.ok(CONNECT_TEST_TIMEOUT_MS < LMSTUDIO_RESPONSE_START_TIMEOUT_MS);
  } finally {
    server.close();
  }
});

test('応答開始が数百ms遅れる程度なら(旧30秒/新90秒いずれの上限内でも)正常に成功する', async () => {
  const { server, port } = await startMockServer((_req, res, _body) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sseChunk(res, { content: '{"events":[]}' }, 'stop');
      res.write('data: [DONE]\n\n');
      res.end();
    }, 300);
  });

  try {
    const provider = new LMStudioProvider();
    const result = await provider.analyzeVisionBatch({
      config: baseConfig(port),
      prompt: 'test prompt',
      batchFiles: ['frame-001.jpg'],
      folder: workDir,
    });
    assert.equal(result, '{"events":[]}');
  } finally {
    server.close();
  }
});

test('generateTextでもfinish_reason:"length"の場合、トークン上限による打ち切りを明示したエラーになる', async () => {
  const { server, port } = await startMockServer((_req, res, _body) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sseChunk(res, { content: '# 作業報告書\n\n## 概要\n途中で切れる' });
    sseChunk(res, {}, 'length');
    res.write('data: [DONE]\n\n');
    res.end();
  });

  try {
    const provider = new LMStudioProvider();
    await assert.rejects(
      () => provider.generateText({
        config: baseConfig(port),
        prompt: 'test prompt',
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /トークン上限/);
        assert.match(err.message, /max_tokens=8192/);
        return true;
      }
    );
  } finally {
    server.close();
  }
});
