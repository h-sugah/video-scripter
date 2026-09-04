// アップロードされた動画ファイルの検証ロジック。
// ファイル名の拡張子だけを信用せず、ffprobeで実データを解析して
// 「実際に映像トラックを持つ、対応コンテナ形式のファイルか」を確認する。
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { extname } from 'node:path';

export class VideoValidationError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'VideoValidationError';
  }
}

interface VideoFamily {
  // このコンテナ系統として許可する拡張子
  extensions: string[];
  // ffprobeの format.format_name (カンマ区切り) に含まれるべきトークン
  formatTokens: string[];
}

// アプリが正式にサポートする動画形式。
// mp4/mov/m4v は ISO Base Media 系の同一デマルチプレクサを共有するため、
// ffprobe の format_name だけでは相互に区別できず、まとめて1系統として扱う。
// mkv/webm も Matroska 系デマルチプレクサを共有するため同様に1系統。
export const VIDEO_FAMILIES: VideoFamily[] = [
  { extensions: ['.mp4', '.mov', '.m4v'], formatTokens: ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'] },
  { extensions: ['.mkv', '.webm'], formatTokens: ['matroska', 'webm'] },
  { extensions: ['.avi'], formatTokens: ['avi'] },
];

export const ALLOWED_VIDEO_EXTENSIONS = new Set(VIDEO_FAMILIES.flatMap(f => f.extensions));

export function findVideoFamily(extension: string): VideoFamily | undefined {
  return VIDEO_FAMILIES.find(f => f.extensions.includes(extension));
}

// multerのオリジナルファイル名(latin1)からUTF-8のファイル名・拡張子を取り出す共通処理
export function decodeOriginalName(originalname: string): string {
  return Buffer.from(originalname, 'latin1').toString('utf8');
}

export function allowedExtensionsLabel(): string {
  return [...ALLOWED_VIDEO_EXTENSIONS].sort().join(', ');
}

// multer fileFilter: 拡張子allowlistによる早期(ディスク書き込み前)の足切り。
// あくまで「明らかに非対応な拡張子」を安価に弾くための一次フィルタであり、
// 実際にファイル内容が動画かどうかは validateUploadedVideo() で別途検証する。
export function videoFileFilter(
  _req: unknown,
  file: Express.Multer.File,
  cb: (error: Error | null, acceptFile?: boolean) => void
): void {
  const originalName = decodeOriginalName(file.originalname);
  const ext = extname(originalName).toLowerCase();
  if (!ALLOWED_VIDEO_EXTENSIONS.has(ext)) {
    cb(new VideoValidationError(`対応していない拡張子です（対応形式: ${allowedExtensionsLabel()}）`));
    return;
  }
  cb(null, true);
}

const PROBE_TIMEOUT_MS = 30_000;

interface ProbedMedia {
  formatName: string;
  hasVideoStream: boolean;
}

// ffprobeでファイル実体を解析する。破損ファイル・非対応形式・動画以外のファイルは
// 例外(VideoValidationError)またはffprobe起動失敗のErrorとして拒否される。
function probeMediaInfo(filePath: string): Promise<ProbedMedia> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath]);
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      p.kill('SIGKILL');
      reject(new VideoValidationError('動画の検証がタイムアウトしました（ファイルが壊れているか、非対応の形式の可能性があります）'));
    }, PROBE_TIMEOUT_MS);

    p.stdout.on('data', d => { stdout += d; });
    p.stderr.on('data', d => { stderr += d; });
    p.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`ffprobeの起動に失敗しました (${err.message})。FFmpeg/ffprobeがシステムにインストールされているか確認してください。`));
    });
    p.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new VideoValidationError('動画ファイルとして認識できませんでした（壊れているか、非対応の形式の可能性があります）'));
        return;
      }
      try {
        const info = JSON.parse(stdout);
        const formatName = String(info?.format?.format_name || '').toLowerCase();
        const streams = Array.isArray(info?.streams) ? info.streams : [];
        const hasVideoStream = streams.some((s: any) => s?.codec_type === 'video');
        resolve({ formatName, hasVideoStream });
      } catch {
        reject(new VideoValidationError('動画ファイルの解析結果を読み取れませんでした'));
      }
    });
  });
}

// アップロードされたファイルの実体を検証する。
// 1. 空ファイルを拒否
// 2. 拡張子が許可リストに含まれるか確認
// 3. ffprobeで実際にデコード可能か、映像トラックを含むか確認
// 4. 検出したコンテナ系統が申告拡張子と一致するか確認（拡張子偽装対策）
export async function validateUploadedVideo(filePath: string, extension: string): Promise<void> {
  const stat = statSync(filePath);
  if (stat.size === 0) {
    throw new VideoValidationError('空のファイルはアップロードできません');
  }

  const family = findVideoFamily(extension);
  if (!family) {
    throw new VideoValidationError(`対応していない拡張子です（対応形式: ${allowedExtensionsLabel()}）`);
  }

  const { formatName, hasVideoStream } = await probeMediaInfo(filePath);

  if (!hasVideoStream) {
    throw new VideoValidationError('映像トラックが含まれていないファイルです（動画として認識できませんでした）');
  }

  const tokens = formatName.split(',').map(s => s.trim());
  const matches = family.formatTokens.some(t => tokens.includes(t));
  if (!matches) {
    throw new VideoValidationError('ファイルの内容が拡張子と一致しません（拡張子偽装の可能性があります）');
  }
}
