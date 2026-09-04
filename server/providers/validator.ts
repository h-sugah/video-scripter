import type { ProviderId } from './types.js';

// クラウドプロバイダー用の厳格なホスト名ホワイトリスト
const CLOUD_ALLOWLIST: Record<'openai' | 'anthropic' | 'google', { hosts: string[]; defaultPort: number }> = {
  openai: {
    hosts: ['api.openai.com'],
    defaultPort: 443,
  },
  anthropic: {
    hosts: ['api.anthropic.com'],
    defaultPort: 443,
  },
  google: {
    hosts: ['generativelanguage.googleapis.com'],
    defaultPort: 443,
  },
};

// LM Studio で許可されるループバックホスト名
const LMSTUDIO_ALLOWED_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
]);

// SSRF での悪用を防止するために禁止する既知の危険ポート
const DANGEROUS_PORTS = new Set([
  20, 21,    // FTP
  22,        // SSH
  23,        // Telnet
  25,        // SMTP
  53,        // DNS
  67, 68,    // DHCP
  69,        // TFTP
  80,        // HTTP (標準Web管理画面等)
  110,       // POP3
  123,       // NTP
  135, 137, 138, 139, 445, // NetBIOS / SMB
  143,       // IMAP
  389, 636,  // LDAP
  443,       // HTTPS (標準Web管理画面等)
  993, 995,  // IMAPS / POP3S
  1433,      // MS SQL
  1521,      // Oracle
  2049,      // NFS
  2375, 2376,// Docker daemon
  3306,      // MySQL
  3389,      // RDP
  5000,      // Docker registry / Flask default
  5432,      // PostgreSQL
  5900, 5901,// VNC
  6379,      // Redis
  8080, 8443,// 共通内部Web/Proxy
  9000,      // SonarQube / PHP-FPM
  9200, 9300,// Elasticsearch
  11211,     // Memcached
  27017, 27018, // MongoDB
]);

export interface ValidationResult {
  valid: boolean;
  normalizedUrl?: string;
  error?: string;
}

/**
 * AI Provider の Base URL を検証し、SSRF 脆弱性を防止する
 */
export function validateProviderUrl(providerId: ProviderId, rawUrl: string): ValidationResult {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { valid: false, error: 'URLが指定されていません' };
  }

  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: `無効なURL形式です: ${trimmed}` };
  }

  // 1. Userinfo (username / password) の禁止 (例: http://api.openai.com@127.0.0.1/)
  if (parsed.username || parsed.password) {
    return { valid: false, error: 'ユーザー名・パスワード付きのURLは許可されていません' };
  }

  // 2. クラウドプロバイダー（OpenAI / Anthropic / Google）の検証
  if (providerId === 'openai' || providerId === 'anthropic' || providerId === 'google') {
    // スキームは https: のみ
    if (parsed.protocol !== 'https:') {
      return { valid: false, error: `${providerId} のプロトコルは https: のみ許可されています (指定: ${parsed.protocol})` };
    }

    const allowConfig = CLOUD_ALLOWLIST[providerId];
    const hostname = parsed.hostname.toLowerCase();

    // ホスト名ホワイトリスト検証
    if (!allowConfig.hosts.includes(hostname)) {
      return {
        valid: false,
        error: `${providerId} のホスト名 '${hostname}' は許可されていません。公式エンドポイント (${allowConfig.hosts.join(', ')}) を指定してください`,
      };
    }

    // ポート番号の検証 (指定されている場合は 443 のみ)
    if (parsed.port && parsed.port !== '443') {
      return { valid: false, error: `${providerId} のポート番号は 443 のみ許可されています (指定: ${parsed.port})` };
    }

    // 末尾スラッシュを除去した正規化URLを返却
    const normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
    return { valid: true, normalizedUrl: normalized };
  }

  // 3. ローカルプロバイダー（LM Studio）の検証
  if (providerId === 'lmstudio') {
    // スキームは http: または https: のみ
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, error: `LM Studio のプロトコルは http: または https: のみ許可されています (指定: ${parsed.protocol})` };
    }

    const rawHost = parsed.hostname.toLowerCase();
    // IPv6 角括弧の正規化
    const cleanHost = rawHost.replace(/^\[|\]$/g, '');

    if (!LMSTUDIO_ALLOWED_HOSTS.has(rawHost) && !LMSTUDIO_ALLOWED_HOSTS.has(cleanHost)) {
      return {
        valid: false,
        error: `LM Studio のホスト名 '${rawHost}' は許可されていません。ローカルホスト (127.0.0.1, localhost, [::1]) を指定してください`,
      };
    }

    // ポート番号の検証
    const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'http:' ? 80 : 443);
    if (isNaN(port) || port < 1 || port > 65535) {
      return { valid: false, error: `無効なポート番号です: ${parsed.port}` };
    }

    if (DANGEROUS_PORTS.has(port)) {
      return {
        valid: false,
        error: `ポート ${port} への接続はセキュリティ上の理由により禁止されています。LM Studio の Local Server ポート（デフォルト: 1234）を指定してください`,
      };
    }

    const normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
    return { valid: true, normalizedUrl: normalized };
  }

  return { valid: false, error: `未知のプロバイダーIDです: ${providerId}` };
}

/**
 * Google Gemini の Resumable Upload URL を検証する
 */
export function validateGoogleUploadUrl(rawUrl: string): ValidationResult {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { valid: false, error: 'Upload URLが指定されていません' };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { valid: false, error: `無効なUpload URL形式です: ${rawUrl}` };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, error: '不正なUpload URL形式です' };
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, error: 'Google Upload URLのプロトコルは https: である必要があります' };
  }

  const hostname = parsed.hostname.toLowerCase();
  const isGoogleHost = hostname === 'generativelanguage.googleapis.com' ||
    hostname.endsWith('.googleapis.com') ||
    hostname.endsWith('.google.com');

  if (!isGoogleHost) {
    return { valid: false, error: `許可されていないUploadホスト名です: ${hostname}` };
  }

  return { valid: true, normalizedUrl: parsed.toString() };
}
