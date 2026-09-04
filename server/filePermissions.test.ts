import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hardenPermissions, DIR_MODE, FILE_MODE } from './filePermissions.js';

let workDir: string;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'file-permissions-test-'));
});

after(() => {
  try { rmSync(workDir, { recursive: true, force: true }); } catch {}
});

test('hardenPermissionsはディレクトリを所有者専用(700)に締める', () => {
  const dir = join(workDir, 'secret-dir');
  mkdirSync(dir, { mode: 0o755 });
  hardenPermissions([dir], DIR_MODE);
  const mode = statSync(dir).mode & 0o777;
  assert.equal(mode, 0o700);
});

test('hardenPermissionsはファイルを所有者専用(600)に締める', () => {
  const file = join(workDir, 'secret.txt');
  writeFileSync(file, 'token', { mode: 0o644 });
  hardenPermissions([file], FILE_MODE);
  const mode = statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('存在しないパスを渡しても例外を投げない', () => {
  assert.doesNotThrow(() => hardenPermissions([join(workDir, 'does-not-exist')], FILE_MODE));
});

test('複数パスをまとめて処理できる', () => {
  const a = join(workDir, 'a.txt');
  const b = join(workDir, 'b.txt');
  writeFileSync(a, '1', { mode: 0o644 });
  writeFileSync(b, '2', { mode: 0o644 });
  hardenPermissions([a, b], FILE_MODE);
  assert.equal(statSync(a).mode & 0o777, 0o600);
  assert.equal(statSync(b).mode & 0o777, 0o600);
});
