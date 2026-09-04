import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import multer from 'multer';
import type { AddressInfo } from 'node:net';

import {
  ALLOWED_VIDEO_EXTENSIONS,
  validateUploadedVideo,
  videoFileFilter,
  VideoValidationError,
} from './videoValidation.js';

let workDir: string;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'video-validation-test-'));
});

after(() => {
  try { rmSync(workDir, { recursive: true, force: true }); } catch {}
});

function makeValidVideo(filename: string, format: 'mp4' | 'avi' = 'mp4'): string {
  const target = join(workDir, filename);
  const result = spawnSync('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc=duration=1:size=64x64:rate=5',
    '-pix_fmt', 'yuv420p',
    '-f', format,
    target,
  ]);
  assert.equal(result.status, 0, `テスト用動画の生成に失敗しました: ${result.stderr?.toString()}`);
  return target;
}

// --- 1. 正常な動画: 検証を通過すること ---
test('正常なmp4動画は検証を通過する', async () => {
  const path = makeValidVideo('valid.mp4', 'mp4');
  await assert.doesNotReject(() => validateUploadedVideo(path, '.mp4'));
});

test('正常なavi動画は検証を通過する', async () => {
  const path = makeValidVideo('valid.avi', 'avi');
  await assert.doesNotReject(() => validateUploadedVideo(path, '.avi'));
});

// --- 2. .mp4だが動画ではないファイル ---
test('拡張子がmp4でも中身がテキストのファイルは拒否される', async () => {
  const path = join(workDir, 'fake-text.mp4');
  writeFileSync(path, 'これは動画ファイルではありません。ただのテキストです。'.repeat(20));
  await assert.rejects(() => validateUploadedVideo(path, '.mp4'), VideoValidationError);
});

// --- 3. unsupported extension ---
test('許可されていない拡張子は拒否される（ffprobeを呼ぶ前に判定）', async () => {
  const path = join(workDir, 'evil.exe');
  writeFileSync(path, Buffer.from([0x4d, 0x5a, 0x90, 0x00])); // MZヘッダ風のダミーバイト列
  assert.equal(ALLOWED_VIDEO_EXTENSIONS.has('.exe'), false);
  await assert.rejects(() => validateUploadedVideo(path, '.exe'), VideoValidationError);
});

// --- 4. malformed video (壊れた動画ファイル) ---
test('破損した(途中で切れた)mp4ファイルは拒否される', async () => {
  const validPath = makeValidVideo('to-corrupt.mp4', 'mp4');
  const corruptPath = join(workDir, 'corrupt.mp4');
  const fs = await import('node:fs');
  const full = fs.readFileSync(validPath);
  // 先頭の一部だけを切り出し、moovアトム等を欠落させて破損ファイルを作る
  fs.writeFileSync(corruptPath, full.subarray(0, Math.min(500, full.length)));
  await assert.rejects(() => validateUploadedVideo(corruptPath, '.mp4'), VideoValidationError);
});

// --- 5. 空ファイル ---
test('空ファイルは拒否される', async () => {
  const path = join(workDir, 'empty.mp4');
  writeFileSync(path, Buffer.alloc(0));
  await assert.rejects(
    () => validateUploadedVideo(path, '.mp4'),
    (err: unknown) => err instanceof VideoValidationError && /空のファイル/.test(err.message)
  );
});

// --- 6. 拡張子偽装: 実体はaviだがmp4として申告 ---
test('拡張子偽装（実体aviをmp4と偽装）は拒否される', async () => {
  const path = makeValidVideo('disguised.avi', 'avi');
  await assert.rejects(
    () => validateUploadedVideo(path, '.mp4'),
    (err: unknown) => err instanceof VideoValidationError && /拡張子偽装/.test(err.message)
  );
});

// --- 7. MIME type偽装 / 不正なContent-Type（HTTPアップロード経路での確認） ---
function buildTestApp() {
  const incomingDir = mkdtempSync(join(tmpdir(), 'video-validation-incoming-'));
  const testUpload = multer({ dest: incomingDir, fileFilter: videoFileFilter });
  const app = express();
  app.post('/upload', testUpload.single('video'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'no file' });
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const ext = originalName.slice(originalName.lastIndexOf('.')).toLowerCase();
    try {
      await validateUploadedVideo(req.file.path, ext);
    } catch (err: any) {
      try { rmSync(req.file.path); } catch {}
      return res.status(err instanceof VideoValidationError ? 400 : 500).json({ error: err.message });
    }
    try { rmSync(req.file.path); } catch {}
    res.status(201).json({ ok: true });
  });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err instanceof VideoValidationError ? 400 : 500).json({ error: err.message });
  });
  return { app, incomingDir };
}

async function startServer(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

test('Content-Typeがvideo/mp4を偽装していても、中身が動画でなければ拒否される', async () => {
  const { app, incomingDir } = buildTestApp();
  const { server, baseUrl } = await startServer(app);
  try {
    const form = new FormData();
    const fakeVideo = new File(['これは動画データではありません'], 'fake.mp4', { type: 'video/mp4' });
    form.append('video', fakeVideo);
    const res = await fetch(`${baseUrl}/upload`, { method: 'POST', body: form });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /動画ファイルとして認識できません/);
  } finally {
    server.close();
    try { rmSync(incomingDir, { recursive: true, force: true }); } catch {}
  }
});

test('Content-Typeをvideo/mp4と偽っても、許可されていない拡張子は拒否される', async () => {
  const { app, incomingDir } = buildTestApp();
  const { server, baseUrl } = await startServer(app);
  try {
    const form = new FormData();
    const fakeVideo = new File(['dummy'], 'malware.exe', { type: 'video/mp4' });
    form.append('video', fakeVideo);
    const res = await fetch(`${baseUrl}/upload`, { method: 'POST', body: form });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /対応していない拡張子/);
  } finally {
    server.close();
    try { rmSync(incomingDir, { recursive: true, force: true }); } catch {}
  }
});

// --- 正常系: 実際のHTTPアップロード経路でも正常な動画は受理される ---
test('正常な動画はHTTPアップロード経路でも受理される', async () => {
  const { app, incomingDir } = buildTestApp();
  const { server, baseUrl } = await startServer(app);
  try {
    const videoPath = makeValidVideo('http-valid.mp4', 'mp4');
    const fs = await import('node:fs');
    const bytes = fs.readFileSync(videoPath);
    const form = new FormData();
    const videoFile = new File([bytes], 'my-video.mp4', { type: 'video/mp4' });
    form.append('video', videoFile);
    const res = await fetch(`${baseUrl}/upload`, { method: 'POST', body: form });
    assert.equal(res.status, 201);
  } finally {
    server.close();
    try { rmSync(incomingDir, { recursive: true, force: true }); } catch {}
    assert.equal(existsSync(incomingDir), false);
  }
});
