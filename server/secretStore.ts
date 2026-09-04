// APIキー等の秘密情報をSQLiteへ保存する前に暗号化するためのモジュール。
//
// 設計方針:
// - 各プロバイダーのAPIトークンは AES-256-GCM でアプリ層暗号化してからDBへ保存する。
//   これにより、DBファイル単体が(バックアップ・誤共有・クラウド同期等で)漏れても、
//   マスターキーを別途取得できない限り平文のAPIキーは復元できない。
// - マスターキー(32byte)自体は可能な限りOSの資格情報保護機構に委ねる:
//     - Windows / WSL2(PowerShell経由でWindows側のDPAPIを呼び出す): DPAPI (CurrentUserスコープ)
//     - macOS: security コマンド (ログインキーチェーン)
//     - Linux(非WSL、libsecretのSecret Serviceが利用可能な場合): secret-tool
//   これらが利用できない環境では、data/master.key に chmod 600 で保存するファイル方式へ
//   自動的にフォールバックする(この場合の保護レベルは、これまでのファイルパーミッション
//   依存の保護と同等)。
// - DPAPI/Keychain/secret-toolいずれの経路でも、可能な限り秘密値をコマンドライン引数
//   (argv)には載せない。argvは同一ユーザーの他プロセスから ps / タスクマネージャー等で
//   容易に閲覧できるため、psコマンド経由での秘密漏洩を避けるためである。
//   - Windows(PowerShell)経由: 環境変数(WSLENVで明示的にWindows側へ橋渡し)経由で受け渡す。
//   - Linux(secret-tool): 標準入力経由で受け渡す(secret-tool storeは元々stdin対応)。
//   - macOS(securityコマンド): 既知の制約として `add-generic-password -w <値>` は
//     コマンドライン引数以外に秘密を渡す手段が無いため、マスターキー作成時のみ
//     (通常は初回起動の一度きり)argv露出を許容する。これは既存コード(lmstudio.ts)の
//     curl.exe Authorizationヘッダーと同種の、既知かつ許容された残存リスクとして明記する。
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { hardenPermissions, FILE_MODE } from './filePermissions.js';

const ENC_PREFIX = 'enc:v1:';
const KEYCHAIN_SERVICE = 'video-scripter';
const KEYCHAIN_ACCOUNT = 'master-key';
const OS_OP_TIMEOUT_MS = 10_000;

export type SecretSource = 'dpapi' | 'macos-keychain' | 'linux-secret-service' | 'file-fallback';

export interface SecretStoreInfo {
  source: SecretSource;
}

export interface InitSecretStoreOptions {
  // テスト用: OS資格情報ストアへのアクセスを試みず、常にファイルフォールバックを使う。
  forceFileFallback?: boolean;
}

let cachedMasterKey: Buffer | null = null;

function isWSL(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    return readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

// --- 外部コマンド実行ヘルパー(タイムアウト付き。argv非経由での入出力に対応) ---
function runCommand(
  cmd: string,
  args: string[],
  opts: { input?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const p = spawn(cmd, args, { env: opts.env ?? process.env });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { p.kill('SIGKILL'); } catch {}
      reject(new Error(`${cmd} の実行がタイムアウトしました`));
    }, OS_OP_TIMEOUT_MS);

    let stdout = '';
    let stderr = '';
    p.stdout?.on('data', d => { stdout += d; });
    p.stderr?.on('data', d => { stderr += d; });
    p.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    p.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    if (opts.input !== undefined) {
      p.stdin?.write(opts.input);
    }
    p.stdin?.end();
  });
}

// ============================================================
// Windows DPAPI (ネイティブWindows、およびWSL2からPowerShell経由)
// ============================================================
const DPAPI_PROTECT_SCRIPT = `
Add-Type -AssemblyName System.Security
try {
  $raw = [Convert]::FromBase64String($env:VS_DPAPI_IN)
  $protected = [System.Security.Cryptography.ProtectedData]::Protect($raw, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($protected))
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}
`;

const DPAPI_UNPROTECT_SCRIPT = `
Add-Type -AssemblyName System.Security
try {
  $blob = [Convert]::FromBase64String($env:VS_DPAPI_IN)
  $raw = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($raw))
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}
`;

// WSLEnv経由でWindows側プロセスへ環境変数を橋渡しする(argvに秘密を載せないため)。
function withWslBridgedEnv(varName: string, value: string): NodeJS.ProcessEnv {
  const existingWslEnv = process.env.WSLENV ? `${process.env.WSLENV}:` : '';
  return { ...process.env, [varName]: value, WSLENV: `${existingWslEnv}${varName}` };
}

async function runDpapiScript(script: string, inputB64: string): Promise<string | null> {
  try {
    const env = withWslBridgedEnv('VS_DPAPI_IN', inputB64);
    const { code, stdout } = await runCommand(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env }
    );
    if (code === 0 && stdout.trim()) return stdout.trim();
    return null;
  } catch {
    return null;
  }
}

function dpapiKeyPath(dataDir: string): string {
  return join(dataDir, 'master.key.dpapi');
}

async function dpapiTryLoad(dataDir: string): Promise<Buffer | null> {
  const path = dpapiKeyPath(dataDir);
  if (!existsSync(path)) return null;
  const blobB64 = readFileSync(path, 'utf8').trim();
  if (!blobB64) return null;
  const rawB64 = await runDpapiScript(DPAPI_UNPROTECT_SCRIPT, blobB64);
  if (!rawB64) return null;
  try {
    const key = Buffer.from(rawB64, 'base64');
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

async function dpapiCreate(dataDir: string): Promise<Buffer | null> {
  const raw = randomBytes(32);
  const protectedB64 = await runDpapiScript(DPAPI_PROTECT_SCRIPT, raw.toString('base64'));
  if (!protectedB64) return null;
  const path = dpapiKeyPath(dataDir);
  writeFileSync(path, protectedB64, { mode: FILE_MODE });
  hardenPermissions([path], FILE_MODE);
  return raw;
}

// ============================================================
// macOS Keychain (security コマンド)
// ============================================================
async function macosTryLoad(): Promise<Buffer | null> {
  try {
    const { code, stdout } = await runCommand('security', [
      'find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w',
    ]);
    if (code !== 0) return null;
    const b64 = stdout.trim();
    if (!b64) return null;
    const key = Buffer.from(b64, 'base64');
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

async function macosCreate(): Promise<Buffer | null> {
  const raw = randomBytes(32);
  const b64 = raw.toString('base64');
  try {
    // 既存項目があれば一旦削除してから追加する(項目によって -U 更新が効かない場合があるため)。
    await runCommand('security', ['delete-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE]).catch(() => {});
    // 既知の制約: securityコマンドには秘密をstdin経由で渡すオプションが無く、
    // -w引数(コマンドライン)でしか渡せない。この呼び出し中のみ、同一ユーザーの
    // 他プロセスからargvが観測され得る(初回作成時の一度限り、既存コードの
    // curl.exeヘッダー露出と同種の許容済み残存リスクとして明記)。
    const { code } = await runCommand('security', [
      'add-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w', b64,
    ]);
    return code === 0 ? raw : null;
  } catch {
    return null;
  }
}

// ============================================================
// Linux Secret Service (secret-tool / libsecret)
// ============================================================
async function linuxTryLoad(): Promise<Buffer | null> {
  try {
    const { code, stdout } = await runCommand('secret-tool', [
      'lookup', 'service', KEYCHAIN_SERVICE, 'account', KEYCHAIN_ACCOUNT,
    ]);
    if (code !== 0) return null;
    const b64 = stdout.trim();
    if (!b64) return null;
    const key = Buffer.from(b64, 'base64');
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

async function linuxCreate(): Promise<Buffer | null> {
  const raw = randomBytes(32);
  const b64 = raw.toString('base64');
  try {
    // secret-toolのstoreはパスワードを標準入力から受け取るため、argvに秘密は載らない。
    const { code } = await runCommand('secret-tool', [
      'store', '--label=Video Scripter Master Key',
      'service', KEYCHAIN_SERVICE, 'account', KEYCHAIN_ACCOUNT,
    ], { input: b64 });
    return code === 0 ? raw : null;
  } catch {
    return null;
  }
}

// ============================================================
// ファイルフォールバック(OS資格情報ストアが使えない場合の最終手段)
// ============================================================
function fileKeyPath(dataDir: string): string {
  return join(dataDir, 'master.key');
}

function fileTryLoad(dataDir: string): Buffer | null {
  const path = fileKeyPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

function fileCreate(dataDir: string): Buffer {
  const raw = randomBytes(32);
  const path = fileKeyPath(dataDir);
  writeFileSync(path, raw.toString('base64'), { mode: FILE_MODE });
  hardenPermissions([path], FILE_MODE);
  return raw;
}

// ============================================================
// マスターキー取得のオーケストレーション
// ============================================================
interface KeyProvider {
  source: SecretSource;
  tryLoad: () => Promise<Buffer | null>;
  create: () => Promise<Buffer | null>;
}

function buildProviderChain(dataDir: string, forceFileFallback?: boolean): KeyProvider[] {
  const fileProvider: KeyProvider = {
    source: 'file-fallback',
    tryLoad: async () => fileTryLoad(dataDir),
    create: async () => fileCreate(dataDir),
  };

  if (forceFileFallback) return [fileProvider];

  if (process.platform === 'win32' || isWSL()) {
    return [
      { source: 'dpapi', tryLoad: () => dpapiTryLoad(dataDir), create: () => dpapiCreate(dataDir) },
      fileProvider,
    ];
  }
  if (process.platform === 'darwin') {
    return [
      { source: 'macos-keychain', tryLoad: macosTryLoad, create: macosCreate },
      fileProvider,
    ];
  }
  if (process.platform === 'linux') {
    return [
      { source: 'linux-secret-service', tryLoad: linuxTryLoad, create: linuxCreate },
      fileProvider,
    ];
  }
  return [fileProvider];
}

export async function initSecretStore(dataDir: string, options: InitSecretStoreOptions = {}): Promise<SecretStoreInfo> {
  const chain = buildProviderChain(dataDir, options.forceFileFallback);

  // 1. 既存のキーが見つかれば、そのまま再利用する(暗号化済みデータとの整合性を保つため、
  //    新しいキーへ勝手に切り替えない)。
  for (const provider of chain) {
    const existing = await provider.tryLoad();
    if (existing) {
      cachedMasterKey = existing;
      return { source: provider.source };
    }
  }

  // 2. どこにも既存キーが無ければ、優先順位の高い方式から新規作成を試みる。
  //    fileProviderは常に成功するため、最終的に必ずどれかで初期化が完了する。
  for (const provider of chain) {
    const created = await provider.create();
    if (created) {
      cachedMasterKey = created;
      return { source: provider.source };
    }
  }

  // 理論上到達しない(fileProvider.createは例外を投げない限り必ず成功する)。
  throw new Error('マスターキーの初期化に失敗しました。');
}

export function describeSecretSource(source: SecretSource): string {
  switch (source) {
    case 'dpapi': return 'Windows DPAPI';
    case 'macos-keychain': return 'macOS Keychain';
    case 'linux-secret-service': return 'Linux Secret Service (libsecret)';
    case 'file-fallback': return 'ローカルファイル(chmod 600、OS資格情報ストア利用不可のためのフォールバック)';
  }
}

// ============================================================
// AES-256-GCM によるアプリ層暗号化
// ============================================================
function getMasterKey(): Buffer {
  if (!cachedMasterKey) {
    throw new Error('secretStoreが初期化されていません。initSecretStore()を先に呼び出してください。');
  }
  return cachedMasterKey;
}

export function isEncryptedFormat(value: string): boolean {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) return '';
  const key = getMasterKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${nonce.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

// 復号に失敗した場合は例外を投げる。ただし「暗号化形式(enc:v1:...)ではない値」は
// 本モジュール導入前に平文で保存された既存データとみなし、そのまま返す
// (呼び出し側で再暗号化して移行することを想定した後方互換動作)。
export function decryptSecret(value: string): string {
  if (!value) return '';
  if (!isEncryptedFormat(value)) return value;

  const key = getMasterKey();
  const parts = value.slice(ENC_PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('暗号化データの形式が不正です');
  const [nonceB64, tagB64, ciphertextB64] = parts;
  const nonce = Buffer.from(nonceB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');

  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

// テスト用: モジュール状態をリセットする。
export function __resetForTest(): void {
  cachedMasterKey = null;
}
