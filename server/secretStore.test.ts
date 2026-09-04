import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  initSecretStore,
  encryptSecret,
  decryptSecret,
  isEncryptedFormat,
  describeSecretSource,
  __resetForTest,
} from './secretStore.js';

let workDir: string;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'secret-store-test-'));
});

after(() => {
  try { rmSync(workDir, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  __resetForTest();
});

function newCaseDir(name: string): string {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('forceFileFallback指定時はファイル方式のマスターキーが使われる', async () => {
  const dir = newCaseDir('case1');
  const info = await initSecretStore(dir, { forceFileFallback: true });
  assert.equal(info.source, 'file-fallback');
  assert.ok(existsSync(join(dir, 'master.key')));
  assert.equal(statSync(join(dir, 'master.key')).mode & 0o777, 0o600);
});

test('暗号化した値は enc:v1: 形式になり、isEncryptedFormatで判定できる', async () => {
  const dir = newCaseDir('case2');
  await initSecretStore(dir, { forceFileFallback: true });
  const cipher = encryptSecret('sk-super-secret-key');
  assert.ok(isEncryptedFormat(cipher));
  assert.ok(!isEncryptedFormat('sk-super-secret-key'));
  assert.notEqual(cipher, 'sk-super-secret-key');
});

test('暗号化した値を同一マスターキーで復号すると元の平文に戻る', async () => {
  const dir = newCaseDir('case3');
  await initSecretStore(dir, { forceFileFallback: true });
  const original = 'sk-abcdefghijklmnopqrstuvwxyz-日本語も含む秘密トークン';
  const cipher = encryptSecret(original);
  const decrypted = decryptSecret(cipher);
  assert.equal(decrypted, original);
});

test('空文字列は暗号化・復号ともに空文字列のまま', async () => {
  const dir = newCaseDir('case4');
  await initSecretStore(dir, { forceFileFallback: true });
  assert.equal(encryptSecret(''), '');
  assert.equal(decryptSecret(''), '');
});

test('暗号化前(移行前)の平文値はそのまま返す(後方互換)', async () => {
  const dir = newCaseDir('case5');
  await initSecretStore(dir, { forceFileFallback: true });
  assert.equal(decryptSecret('legacy-plaintext-token'), 'legacy-plaintext-token');
});

test('毎回異なるnonceで暗号化されるため、同じ平文でも暗号文は毎回異なる', async () => {
  const dir = newCaseDir('case6');
  await initSecretStore(dir, { forceFileFallback: true });
  const a = encryptSecret('same-token');
  const b = encryptSecret('same-token');
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a), 'same-token');
  assert.equal(decryptSecret(b), 'same-token');
});

test('改ざんされた暗号文は復号時に例外を投げる(認証タグ検証)', async () => {
  const dir = newCaseDir('case7');
  await initSecretStore(dir, { forceFileFallback: true });
  const cipher = encryptSecret('secret-value');
  const parts = cipher.split(':');
  // ciphertext部分の末尾1文字を変え、認証タグ検証で失敗させる
  const tamperedCiphertext = parts[4].slice(0, -1) + (parts[4].slice(-1) === 'A' ? 'B' : 'A');
  const tampered = [parts[0], parts[1], parts[2], parts[3], tamperedCiphertext].join(':');
  assert.throws(() => decryptSecret(tampered));
});

test('既存のmaster.keyファイルがあれば再利用し、新規作成しない(暗号化データとの整合性維持)', async () => {
  const dir = newCaseDir('case8');
  const info1 = await initSecretStore(dir, { forceFileFallback: true });
  assert.equal(info1.source, 'file-fallback');
  const cipher = encryptSecret('token-encrypted-with-first-key');

  __resetForTest();
  const info2 = await initSecretStore(dir, { forceFileFallback: true });
  assert.equal(info2.source, 'file-fallback');
  // 同じキーが再利用されていれば復号できる
  assert.equal(decryptSecret(cipher), 'token-encrypted-with-first-key');
});

test('describeSecretSourceは全ソース種別に対して説明文字列を返す', () => {
  assert.equal(typeof describeSecretSource('dpapi'), 'string');
  assert.equal(typeof describeSecretSource('macos-keychain'), 'string');
  assert.equal(typeof describeSecretSource('linux-secret-service'), 'string');
  assert.equal(typeof describeSecretSource('file-fallback'), 'string');
});

test('初期化前にencryptSecretを呼ぶと例外を投げる', () => {
  assert.throws(() => encryptSecret('x'));
});

// --- 実OS資格情報ストアとの統合テスト(利用可能な環境でのみ実行、失敗しても他のテストに影響しない) ---
test('OS既定の資格情報ストア経由でのマスターキー取得(利用可能な場合のみ検証)', async (t) => {
  const dir = newCaseDir('case-os');
  let info;
  try {
    info = await initSecretStore(dir);
  } catch (e) {
    t.skip(`OS資格情報ストアの初期化に失敗したためスキップ: ${(e as Error).message}`);
    return;
  }
  if (info.source === 'file-fallback') {
    t.skip('この実行環境ではOS資格情報ストアが利用できないため、ファイルフォールバックで動作(想定内)');
    return;
  }
  // OSストア経由の場合、master.keyファイルは作られない
  assert.ok(!existsSync(join(dir, 'master.key')));
  const cipher = encryptSecret('os-store-round-trip');
  assert.equal(decryptSecret(cipher), 'os-store-round-trip');
});
