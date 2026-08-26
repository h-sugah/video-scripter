import express from 'express';
import multer from 'multer';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  getProvider,
  getAllProviders,
  getProviderMetaList,
  cleanModelText,
  parseModelJson,
  normalizeEvents,
  type ProviderId,
  type ProviderConfig,
} from './providers/index.js';

import {
  getProfile,
  getAllProfiles,
  buildPerceptionPrompt,
  buildDirectVideoPrompt,
  buildReportPrompt,
  type ProfileId,
} from './profiles/index.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const data = join(root, 'data');
const uploads = join(data, 'uploads');
const framesRoot = join(data, 'frames');
for (const path of [data, uploads, framesRoot]) mkdirSync(path, { recursive: true });

const db = new DatabaseSync(join(data, 'video-scripter.sqlite'));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, duration REAL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, video_id TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, type TEXT DEFAULT 'analyze', state_json TEXT);
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, video_id TEXT NOT NULL, start_time REAL NOT NULL, end_time REAL, event_type TEXT NOT NULL, description TEXT NOT NULL, objects_json TEXT NOT NULL, confidence REAL, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, video_id TEXT NOT NULL, title TEXT NOT NULL, markdown TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_audits (id TEXT PRIMARY KEY, video_id TEXT NOT NULL, stage TEXT NOT NULL, model TEXT NOT NULL, prompt TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);

// jobs テーブルのマイグレーション確認（既存DBとの互換性確保）
try {
  const tableInfo = db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[];
  const cols = new Set(tableInfo.map(c => c.name));
  if (!cols.has('type')) {
    db.exec("ALTER TABLE jobs ADD COLUMN type TEXT DEFAULT 'analyze'");
  }
  if (!cols.has('state_json')) {
    db.exec('ALTER TABLE jobs ADD COLUMN state_json TEXT');
  }
} catch (e) {
  console.warn('jobsテーブルのマイグレーション確認中に警告が発生しました:', e);
}

// 保存された動画パスの自動修復（異なる環境間での同期やフォルダ移動に対応）
try {
  const existingVideos = db.prepare('SELECT id, path FROM videos').all() as { id: string; path: string }[];
  for (const v of existingVideos) {
    if (!v.path || !existsSync(v.path)) {
      const filename = v.path ? basename(v.path) : `${v.id}.mp4`;
      const target = join(uploads, filename);
      if (existsSync(target)) {
        db.prepare('UPDATE videos SET path=? WHERE id=?').run(target, v.id);
      } else if (existsSync(uploads)) {
        const matching = readdirSync(uploads).find(f => f.startsWith(v.id));
        if (matching) {
          db.prepare('UPDATE videos SET path=? WHERE id=?').run(join(uploads, matching), v.id);
        }
      }
    }
  }
} catch (e) {
  console.warn('動画パスの整合性確認中に警告が発生しました:', e);
}

const now = () => new Date().toISOString();
const getSetting = (key: string, fallback = '') => (db.prepare('SELECT value FROM settings WHERE key=?').get(key) as any)?.value ?? fallback;
const setSetting = (key: string, value: string) => db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);

// 初期設定の投入
if (!getSetting('active_provider')) setSetting('active_provider', 'lmstudio');
if (!getSetting('active_profile') || getSetting('active_profile') === 'meeting') setSetting('active_profile', 'operation');
if (!getSetting('lmstudio_url')) setSetting('lmstudio_url', 'http://127.0.0.1:1234/v1');
if (!getSetting('openai_url')) setSetting('openai_url', 'https://api.openai.com/v1');
if (!getSetting('openai_model')) setSetting('openai_model', '');
if (!getSetting('anthropic_url')) setSetting('anthropic_url', 'https://api.anthropic.com/v1');
if (!getSetting('anthropic_model')) setSetting('anthropic_model', '');
if (!getSetting('google_url')) setSetting('google_url', 'https://generativelanguage.googleapis.com');
if (!getSetting('google_model')) setSetting('google_model', '');

function getProviderConfig(providerId: ProviderId): ProviderConfig {
  const provider = getProvider(providerId);
  return {
    id: providerId,
    name: provider.name,
    baseUrl: getSetting(`${providerId}_url`, provider.defaultBaseUrl),
    token: getSetting(`${providerId}_token`, ''),
    model: getSetting(`${providerId}_model`, provider.defaultModel),
  };
}

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use('/media', express.static(data));

const upload = multer({ dest: join(data, 'incoming'), limits: { fileSize: 10 * 1024 * 1024 * 1024 } });
const subscribers = new Map<string, Set<express.Response>>();
const jobAbortControllers = new Map<string, AbortController>();

function updateJob(id: string, progress: number, message: string, status?: string, stateJson?: string | null) {
  const existing = db.prepare('SELECT status, state_json FROM jobs WHERE id=?').get(id) as any;
  const newStatus = status ?? existing?.status ?? 'running';
  const newState = stateJson !== undefined ? stateJson : (existing?.state_json ?? null);
  db.prepare('UPDATE jobs SET progress=?,message=?,status=?,state_json=?,updated_at=? WHERE id=?').run(
    progress,
    message,
    newStatus,
    newState,
    now(),
    id
  );
  const payload = JSON.stringify(db.prepare('SELECT * FROM jobs WHERE id=?').get(id));
  const subs = subscribers.get(id);
  if (subs) {
    for (const res of subs) {
      try {
        res.write(`data: ${payload}\n\n`);
      } catch {
        subs.delete(res);
      }
    }
  }
}

function resolveVideoPath(video: { id: string; path?: string; name?: string }): string {
  // 1. 保存されたパスがそのまま存在する場合
  if (video.path && existsSync(video.path)) {
    return video.path;
  }

  // 2. uploadsディレクトリ内をファイル名で検索
  if (video.path) {
    const filename = basename(video.path);
    const candidateInUploads = join(uploads, filename);
    if (existsSync(candidateInUploads)) {
      try {
        db.prepare('UPDATE videos SET path=? WHERE id=?').run(candidateInUploads, video.id);
      } catch {}
      return candidateInUploads;
    }
  }

  // 3. video.id で始まるファイルをuploadsから検索
  if (existsSync(uploads)) {
    try {
      const files = readdirSync(uploads);
      const matching = files.find(f => f.startsWith(video.id));
      if (matching) {
        const found = join(uploads, matching);
        try {
          db.prepare('UPDATE videos SET path=? WHERE id=?').run(found, video.id);
        } catch {}
        return found;
      }
    } catch {}
  }

  throw new Error(`動画ファイルが見つかりません (${video.path || video.id})。ファイルが uploads ディレクトリ内に存在するか確認してください。`);
}

function probeDuration(videoPath: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    if (!existsSync(videoPath)) {
      return reject(new Error(`動画ファイルが見つかりません: ${videoPath}`));
    }
    const p = spawn('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ]);
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', d => stdout += d);
    p.stderr.on('data', d => stderr += d);
    p.on('error', err => reject(new Error(`ffprobeの起動に失敗しました (${err.message})。FFmpeg/ffprobeがシステムにインストールされているか確認してください。`)));
    p.on('close', code => {
      if (code === 0) {
        const dur = Number(stdout.trim());
        resolve(Number.isFinite(dur) && dur > 0 ? dur : 0);
      } else {
        reject(new Error(`ffprobeを実行できませんでした (終了コード ${code}): ${stderr.trim() || '動画情報を取得できませんでした'}`));
      }
    });
  });
}

function command(bin: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const p = spawn(bin, args);
    let err = '';
    p.stderr.on('data', d => err += d);
    p.on('error', errObj => reject(new Error(`${bin}の起動に失敗しました: ${errObj.message}`)));
    p.on('close', code => code === 0 ? resolve(err) : reject(new Error(`${bin}の実行に失敗しました (終了コード ${code}): ${err.trim() || `${bin} failed`}`)));
  });
}

function seconds(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function formatDuration(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function reportFallback(video: any, events: any[], profileId: ProfileId, reason?: string) {
  const profile = getProfile(profileId);
  const lines = events.map((event) => {
    const objects = JSON.parse(event.objects_json || '[]');
    return `- ${formatDuration(event.start_time)}　${event.description}${objects.length ? `（対象: ${objects.join('、')}）` : ''}`;
  });

  return `# ${video.name} ${profile.name}

## 概要
- **対象動画**: ${video.name}
- **解析プロファイル**: ${profile.name}
- **イベント件数**: ${events.length} 件

## 時系列記録
${lines.join('\n')}

## 留意事項
観測イベント上、明示的な異常や特記事項は記録されていません。

## 根拠
本記録は、保存された時系列イベントおよび各イベントに紐づく動画フレームを根拠に作成しました。
${reason ? `\n> 注記: AIモデルによる文章整形が利用できなかったため、イベントデータから直接生成しています（${reason}）。` : ''}`;
}

interface AnalyzeResumeState {
  completedBatches: number;
  events: any[];
  files: string[];
  interval: number;
  duration: number;
  totalBatches: number;
}

interface AnalyzeOptions {
  providerId?: ProviderId;
  profileId?: ProfileId;
  customPerceptionPrompt?: string;
  mode?: 'auto' | 'direct' | 'frames';
  resumeState?: AnalyzeResumeState;
}

// 動画解析処理オーケストレーター
async function analyze(
  jobId: string,
  video: any,
  options?: AnalyzeOptions,
  signal?: AbortSignal
) {
  const providerId = (options?.providerId || getSetting('active_provider', 'lmstudio')) as ProviderId;
  const profileId = (options?.profileId || getSetting('active_profile', 'operation')) as ProfileId;
  const customPrompt = options?.customPerceptionPrompt ?? getSetting('custom_perception_prompt', '');
  const mode = options?.mode || (getSetting('video_analysis_mode', 'auto') as 'auto' | 'direct' | 'frames');

  const provider = getProvider(providerId);
  const providerConfig = getProviderConfig(providerId);
  const profile = getProfile(profileId);

  let duration = options?.resumeState?.duration || 0;
  let files: string[] = options?.resumeState?.files || [];
  let interval = options?.resumeState?.interval || 1;
  let totalBatches = options?.resumeState?.totalBatches || 0;
  let completedBatchCount = options?.resumeState?.completedBatches || 0;
  const allEvents: any[] = options?.resumeState?.events ? [...options.resumeState.events] : [];
  let currentProgress = options?.resumeState ? Math.min(90, Math.round(20 + (completedBatchCount / Math.max(1, totalBatches)) * 75)) : 5;

  const folder = join(framesRoot, video.id);

  try {
    const checkAbort = () => {
      if (signal?.aborted) throw new DOMException('中断されました', 'AbortError');
    };

    const resolvedPath = resolveVideoPath(video);
    checkAbort();

    // 再開時でない場合は動画メタデータ取得とフレーム抽出を実施
    if (!options?.resumeState || !files.length) {
      updateJob(jobId, 5, '動画情報を確認しています');
      duration = await probeDuration(resolvedPath);
      db.prepare('UPDATE videos SET duration=? WHERE id=?').run(duration, video.id);

      checkAbort();
      updateJob(jobId, 10, '代表フレームを抽出しています');
      mkdirSync(folder, { recursive: true });

      // 既存フレームのクリーンアップ
      const existing = readdirSync(folder);
      for (const f of existing) {
        try { rmSync(join(folder, f)); } catch {}
      }

      // 証跡・フォールバック用フレーム抽出
      const count = Math.max(6, Math.ceil(duration / 15));
      interval = Math.max(1, duration / count);
      await command('ffmpeg', [
        '-y',
        '-i',
        resolvedPath,
        '-vf',
        `fps=1/${interval},scale='min(1080,iw)':-2`,
        '-frames:v',
        String(count),
        join(folder, 'frame-%03d.jpg'),
      ]);

      checkAbort();
      files = readdirSync(folder).filter(x => x.endsWith('.jpg')).sort();
      if (!files.length) throw new Error('フレーム画像を抽出できませんでした。');
    } else {
      updateJob(jobId, currentProgress, `中断された解析を再開しています (区間 ${completedBatchCount + 1}/${totalBatches} より)...`);
    }

    // Geminiなど、Capabilityとしてvideo_input = true を持ち、モードが direct / auto の場合
    if (provider.capabilities.video_input && mode !== 'frames' && provider.analyzeVideoDirect) {
      checkAbort();
      updateJob(jobId, 20, `${provider.name} に動画を送信して直接解析を開始します...`);

      const prompt = buildDirectVideoPrompt({
        profileId,
        videoName: video.name,
        duration,
        customPrompt,
      });

      const modelResponse = await provider.analyzeVideoDirect({
        config: providerConfig,
        prompt,
        videoPath: resolvedPath,
        videoName: video.name,
        mimeType: 'video/mp4',
        duration,
        onProgress: (msg) => {
          updateJob(jobId, 45, msg);
        },
        signal,
      });

      db.prepare('INSERT INTO ai_audits VALUES (?,?,?,?,?,?,?)').run(
        randomUUID(),
        video.id,
        `direct_video_${profileId}`,
        providerConfig.model || provider.defaultModel,
        prompt,
        String(modelResponse),
        now()
      );

      const parsed = parseModelJson(String(modelResponse));
      const directEvents = normalizeEvents(parsed);

      for (const ev of directEvents) {
        const st = seconds(ev.start_time);
        const et = ev.end_time == null ? null : seconds(ev.end_time);
        const frameIdx = Math.max(1, Math.min(files.length, Math.round(st / interval) + 1));
        allEvents.push({
          ...ev,
          frame_index: frameIdx,
          start_time: st,
          end_time: et,
        });
      }
    } else {
      // フレーム画像バッチ方式 (LM Studio, OpenAI, Claude, またはフレーム指定時)
      const BATCH_SIZE = 4;
      totalBatches = Math.ceil(files.length / BATCH_SIZE);

      for (let b = completedBatchCount; b < totalBatches; b++) {
        checkAbort();

        const batchFiles = files.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
        const batchStartIndex = b * BATCH_SIZE + 1; // 1-indexed
        const batchEndIndex = batchStartIndex + batchFiles.length - 1;

        const batchStartTime = (batchStartIndex - 1) * interval;
        const batchEndTime = Math.min(duration, batchEndIndex * interval);

        currentProgress = Math.round(20 + (b / totalBatches) * 75);
        const rangeStr = `${formatDuration(batchStartTime)}〜${formatDuration(batchEndTime)}`;
        updateJob(jobId, currentProgress, `[${profile.name}] 区間 ${b + 1}/${totalBatches} (${rangeStr}) の${batchFiles.length}フレームを ${provider.name} で解析中...`);

        const prompt = buildPerceptionPrompt({
          profileId,
          duration,
          batchCount: batchFiles.length,
          batchStartIndex,
          batchEndIndex,
          batchStartTime,
          batchEndTime,
          interval,
          customPrompt,
        });

        const modelResponse = await provider.analyzeVisionBatch({
          config: providerConfig,
          prompt,
          batchFiles,
          folder,
          onProgress: (tokenCount) => {
            updateJob(jobId, currentProgress, `[${profile.name}] 区間 ${b + 1}/${totalBatches} (${rangeStr}) 解析中 (${tokenCount}トークン)...`);
          },
          signal,
        });

        db.prepare('INSERT INTO ai_audits VALUES (?,?,?,?,?,?,?)').run(
          randomUUID(),
          video.id,
          `batch_${b + 1}_of_${totalBatches}_${profileId}`,
          providerConfig.model || provider.defaultModel,
          prompt,
          String(modelResponse),
          now()
        );

        const parsed = parseModelJson(String(modelResponse));
        const batchEvents = normalizeEvents(parsed);

        for (const ev of batchEvents) {
          let fIdx = Number(ev.frame_index) || batchStartIndex;
          if (fIdx >= 1 && fIdx <= batchFiles.length && fIdx < batchStartIndex) {
            fIdx = batchStartIndex + fIdx - 1;
          }
          fIdx = Math.max(1, Math.min(files.length, fIdx));

          let st = seconds(ev.start_time);
          if (st < batchStartTime && (st + batchStartTime) <= (batchEndTime + interval * 2)) {
            st = st + batchStartTime;
          }
          let et = ev.end_time == null ? null : seconds(ev.end_time);
          if (et != null && et < batchStartTime && (et + batchStartTime) <= (batchEndTime + interval * 2)) {
            et = et + batchStartTime;
          }

          allEvents.push({
            ...ev,
            frame_index: fIdx,
            start_time: st,
            end_time: et,
          });
        }

        completedBatchCount = b + 1;
        currentProgress = Math.round(20 + (completedBatchCount / totalBatches) * 75);

        // 各バッチ完了時のスナップショットを state_json に保持
        const batchStateJson = JSON.stringify({
          providerId,
          profileId,
          customPerceptionPrompt: customPrompt,
          mode,
          completedBatches: completedBatchCount,
          events: allEvents,
          files,
          interval,
          duration,
          totalBatches,
        });
        updateJob(jobId, currentProgress, `[${profile.name}] 区間 ${completedBatchCount}/${totalBatches} (${rangeStr}) 解析完了`, 'running', batchStateJson);
      }
    }

    if (!allEvents.length) {
      throw new Error(`モデルがイベントを返しませんでした。${provider.name} の設定とモデルの画像/動画認識対応を確認してください。`);
    }

    updateJob(jobId, 95, '時系列イベントを保存しています');
    allEvents.sort((a, b) => a.start_time - b.start_time);

    db.prepare('DELETE FROM events WHERE video_id=?').run(video.id);
    const insert = db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const event of allEvents) {
      const idx = Math.max(1, Math.min(files.length, Math.round(Number(event.frame_index) || 1)));
      const start = seconds(event.start_time);
      insert.run(
        randomUUID(),
        video.id,
        start,
        event.end_time == null ? null : seconds(event.end_time),
        String(event.event_type || 'other'),
        String(event.description || '内容不明'),
        JSON.stringify(Array.isArray(event.objects) ? event.objects : []),
        Math.max(0, Math.min(1, Number(event.confidence) || 0.8)),
        JSON.stringify({
          frame: `frames/${video.id}/${files[idx - 1]}`,
          frame_index: idx,
          approximate_time: (idx - 0.5) * interval,
          provider: provider.name,
          profile: profile.name,
        }),
        now()
      );
    }

    updateJob(jobId, 100, `【${profile.name}】${allEvents.length}件のイベントを抽出しました（${provider.name}）`, 'completed', null);
  } catch (error: any) {
    const isAbort = error?.name === 'AbortError';
    const currentJob = db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId) as any;
    const isPaused = currentJob?.status === 'paused';

    if (isAbort && isPaused) {
      // 中断（paused）: 中断時点のスナップショットを保存
      const savedState = JSON.stringify({
        providerId,
        profileId,
        customPerceptionPrompt: customPrompt,
        mode,
        completedBatches: completedBatchCount,
        events: allEvents,
        files,
        interval,
        duration,
        totalBatches: totalBatches || Math.ceil(files.length / 4),
      });

      // すでに抽出できたイベントがあれば events テーブルにも一時反映
      if (allEvents.length > 0) {
        try {
          db.prepare('DELETE FROM events WHERE video_id=?').run(video.id);
          const insert = db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?)');
          for (const event of allEvents) {
            const idx = Math.max(1, Math.min(files.length, Math.round(Number(event.frame_index) || 1)));
            const start = seconds(event.start_time);
            insert.run(
              randomUUID(),
              video.id,
              start,
              event.end_time == null ? null : seconds(event.end_time),
              String(event.event_type || 'other'),
              String(event.description || '内容不明'),
              JSON.stringify(Array.isArray(event.objects) ? event.objects : []),
              Math.max(0, Math.min(1, Number(event.confidence) || 0.8)),
              JSON.stringify({
                frame: `frames/${video.id}/${files[idx - 1]}`,
                frame_index: idx,
                approximate_time: (idx - 0.5) * interval,
                provider: provider.name,
                profile: profile.name,
              }),
              now()
            );
          }
        } catch {}
      }

      const batchMsg = totalBatches > 0 ? ` (${completedBatchCount}/${totalBatches}区間完了)` : '';
      updateJob(
        jobId,
        currentProgress || 20,
        `解析を中断しました${batchMsg}。「再開」ボタンで続きから処理できます。`,
        'paused',
        savedState
      );
    } else if (isAbort) {
      // キャンセル（cancelled）
      updateJob(jobId, 0, '解析をキャンセルしました。', 'cancelled', null);
    } else {
      const cause = error?.cause ? ` (詳細: ${error.cause.message || error.cause.code || error.cause})` : '';
      updateJob(jobId, 0, `${error.message}${cause}`, 'failed', null);
    }
  } finally {
    jobAbortControllers.delete(jobId);
  }
}

// 報告書生成処理オーケストレーター（キャンセル対応・再開なし）
async function generateReport(
  jobId: string,
  video: any,
  options?: { providerId?: ProviderId; profileId?: ProfileId; customReportPrompt?: string },
  signal?: AbortSignal
) {
  try {
    if (signal?.aborted) throw new DOMException('中断されました', 'AbortError');
    updateJob(jobId, 10, '観測イベントを確認しています');
    const events = db.prepare('SELECT * FROM events WHERE video_id=? ORDER BY start_time').all(video.id) as any[];
    if (!events.length) throw new Error('先にイベントを解析してください');

    const providerId = (options?.providerId || getSetting('active_provider', 'lmstudio')) as ProviderId;
    const profileId = (options?.profileId || getSetting('active_profile', 'operation')) as ProfileId;
    const customPrompt = options?.customReportPrompt ?? getSetting('custom_report_prompt', '');

    const provider = getProvider(providerId);
    const providerConfig = getProviderConfig(providerId);
    const profile = getProfile(profileId);

    const compact = events.map(e => ({
      time: e.start_time,
      description: e.description,
      type: e.event_type,
      confidence: e.confidence,
      objects: JSON.parse(e.objects_json || '[]'),
    }));

    const prompt = buildReportPrompt({
      profileId,
      videoName: video.name,
      duration: video.duration || 0,
      events: compact,
      customPrompt,
    });

    if (signal?.aborted) throw new DOMException('中断されました', 'AbortError');
    updateJob(jobId, 25, `${provider.name} で【${profile.name}】の報告書を生成中...`);

    let markdown = '';
    let fallbackReason = '';

    try {
      const rawText = await provider.generateText({
        config: providerConfig,
        prompt,
        onProgress: (tokenCount) => {
          const p = Math.min(90, 25 + Math.floor(tokenCount / 8));
          updateJob(jobId, p, `報告書を生成中 (${provider.name}: ${tokenCount}トークン)...`);
        },
        signal,
      });

      db.prepare('INSERT INTO ai_audits VALUES (?,?,?,?,?,?,?)').run(
        randomUUID(),
        video.id,
        `report_${profileId}`,
        providerConfig.model || provider.defaultModel,
        prompt,
        rawText,
        now()
      );

      const cleaned = cleanModelText(rawText);
      markdown = cleaned.replace(/^```(?:markdown)?\s*/i, '').replace(/\s*```$/, '').trim();
      if (!markdown) throw new Error(`${provider.name} が有効な報告書本文を返しませんでした`);
    } catch (err: any) {
      // AbortError は上位にそのまま伝播させる
      if (err?.name === 'AbortError') throw err;
      fallbackReason = err.message;
      markdown = reportFallback(video, events, profileId, fallbackReason);
    }

    if (signal?.aborted) throw new DOMException('中断されました', 'AbortError');
    updateJob(jobId, 95, '報告書を保存しています');
    const report = {
      id: randomUUID(),
      video_id: video.id,
      title: `${video.name} ${profile.name}${fallbackReason ? '（イベントから自動整形）' : ''}`,
      markdown,
      created_at: now(),
    };
    db.prepare('INSERT INTO reports VALUES (?,?,?,?,?)').run(report.id, report.video_id, report.title, report.markdown, report.created_at);

    updateJob(
      jobId,
      100,
      fallbackReason ? `イベントから報告書を生成しました: ${fallbackReason}` : `【${profile.name}】報告書の生成が完了しました（${provider.name}）`,
      'completed',
      null
    );
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      updateJob(jobId, 0, '報告書の生成をキャンセルしました。', 'cancelled', null);
    } else {
      const cause = error?.cause ? ` (詳細: ${error.cause.message || error.cause.code || error.cause})` : '';
      updateJob(jobId, 0, `${error.message}${cause}`, 'failed', null);
    }
  } finally {
    jobAbortControllers.delete(jobId);
  }
}

// API Routes
app.get('/api/health', (_req, res) => {
  const activeProvider = getSetting('active_provider', 'lmstudio') as ProviderId;
  let ffmpegOk = false;
  let ffprobeOk = false;
  try {
    ffmpegOk = spawnSync('ffmpeg', ['-version']).status === 0;
  } catch {}
  try {
    ffprobeOk = spawnSync('ffprobe', ['-version']).status === 0;
  } catch {}

  res.json({
    ffmpeg: ffmpegOk,
    ffprobe: ffprobeOk,
    activeProvider,
    activeProfile: getSetting('active_profile', 'operation'),
    node: process.version,
  });
});

app.get('/api/settings', (_req, res) => {
  const activeProvider = getSetting('active_provider', 'lmstudio') as ProviderId;
  const activeProfile = getSetting('active_profile', 'operation') as ProfileId;

  const providerSettings: Record<string, any> = {};
  for (const p of getAllProviders()) {
    providerSettings[p.id] = {
      url: getSetting(`${p.id}_url`, p.defaultBaseUrl),
      model: getSetting(`${p.id}_model`, p.defaultModel),
      configured: Boolean(getSetting(`${p.id}_token`, '')),
    };
  }

  res.json({
    active_provider: activeProvider,
    active_profile: activeProfile,
    custom_perception_prompt: getSetting('custom_perception_prompt', ''),
    custom_report_prompt: getSetting('custom_report_prompt', ''),
    video_analysis_mode: getSetting('video_analysis_mode', 'auto'),
    providers_meta: getProviderMetaList(),
    profiles: getAllProfiles(),
    provider_settings: providerSettings,
    // 既存互換用
    lmstudio_url: getSetting('lmstudio_url', 'http://127.0.0.1:1234/v1'),
    lmstudio_model: getSetting('lmstudio_model', ''),
    lmstudio_token_configured: Boolean(getSetting('lmstudio_token', '')),
  });
});

app.put('/api/settings', (req, res) => {
  const b = req.body;

  if (typeof b.active_provider === 'string') setSetting('active_provider', b.active_provider);
  if (typeof b.active_profile === 'string') setSetting('active_profile', b.active_profile);
  if (typeof b.custom_perception_prompt === 'string') setSetting('custom_perception_prompt', b.custom_perception_prompt);
  if (typeof b.custom_report_prompt === 'string') setSetting('custom_report_prompt', b.custom_report_prompt);
  if (typeof b.video_analysis_mode === 'string') setSetting('video_analysis_mode', b.video_analysis_mode);

  for (const p of getAllProviders()) {
    const pid = p.id;
    if (typeof b[`${pid}_url`] === 'string') setSetting(`${pid}_url`, b[`${pid}_url`]);
    if (typeof b[`${pid}_model`] === 'string') setSetting(`${pid}_model`, b[`${pid}_model`]);
    if (typeof b[`${pid}_token`] === 'string' && b[`${pid}_token`].trim()) {
      setSetting(`${pid}_token`, b[`${pid}_token`].trim());
    }
    if (b[`clear_${pid}_token`] === true) {
      setSetting(`${pid}_token`, '');
    }
  }

  // ネストされた provider_settings からの保存もサポート
  if (b.provider_settings && typeof b.provider_settings === 'object') {
    for (const [pid, ps] of Object.entries(b.provider_settings) as [string, any][]) {
      if (typeof ps.url === 'string') setSetting(`${pid}_url`, ps.url);
      if (typeof ps.model === 'string') setSetting(`${pid}_model`, ps.model);
      if (typeof ps.token === 'string' && ps.token.trim()) setSetting(`${pid}_token`, ps.token.trim());
      if (ps.clear_token === true) setSetting(`${pid}_token`, '');
    }
  }

  res.sendStatus(204);
});

// プロバイダー接続テスト
app.post('/api/providers/:id/test', async (req, res) => {
  const pid = req.params.id as ProviderId;
  try {
    const provider = getProvider(pid);
    const config: ProviderConfig = {
      id: pid,
      name: provider.name,
      baseUrl: (typeof req.body.url === 'string' && req.body.url.trim()) ? req.body.url.trim() : getSetting(`${pid}_url`, provider.defaultBaseUrl),
      token: (typeof req.body.token === 'string' && req.body.token.trim()) ? req.body.token.trim() : getSetting(`${pid}_token`, ''),
      model: (typeof req.body.model === 'string' && req.body.model.trim()) ? req.body.model.trim() : getSetting(`${pid}_model`, provider.defaultModel),
    };

    const result = await provider.testConnection(config);
    res.json({
      success: true,
      provider: pid,
      models: result.models,
    });
  } catch (error: any) {
    const cause = error?.cause ? ` (${error.cause.message || error.cause.code || ''})` : '';
    res.status(502).json({ error: `${error.message}${cause}` });
  }
});

// 既存互換のLM Studioテスト
app.post('/api/lmstudio/test', async (req, res) => {
  try {
    const provider = getProvider('lmstudio');
    const config: ProviderConfig = {
      id: 'lmstudio',
      name: 'LM Studio',
      baseUrl: getSetting('lmstudio_url', provider.defaultBaseUrl),
      token: getSetting('lmstudio_token', ''),
      model: getSetting('lmstudio_model', ''),
    };
    const result = await provider.testConnection(config);
    res.json({ models: result.models });
  } catch (error: any) {
    const cause = error?.cause ? ` (${error.cause.message || error.cause.code || ''})` : '';
    res.status(502).json({ error: `LM Studioへ接続できません: ${error.message}${cause}` });
  }
});

app.get('/api/projects', (_req, res) => res.json(db.prepare('SELECT p.*, COUNT(v.id) AS video_count FROM projects p LEFT JOIN videos v ON p.id=v.project_id GROUP BY p.id ORDER BY p.created_at DESC').all()));
app.post('/api/projects', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'プロジェクト名を入力してください' });
  const row = { id: randomUUID(), name, created_at: now() };
  db.prepare('INSERT INTO projects VALUES (?,?,?)').run(row.id, row.name, row.created_at);
  res.status(201).json(row);
});

app.get('/api/projects/:id', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!project) return res.sendStatus(404);
  res.json({ project, videos: db.prepare('SELECT * FROM videos WHERE project_id=? ORDER BY created_at DESC').all(req.params.id) });
});

app.post('/api/projects/:id/videos', upload.single('video'), (req, res) => {
  const projectId = String(req.params.id);
  if (!req.file) return res.status(400).json({ error: '動画を選択してください' });
  const project = db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId);
  if (!project) return res.sendStatus(404);
  const id = randomUUID();
  const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const target = join(uploads, `${id}${extname(name).toLowerCase() || '.mp4'}`);
  renameSync(req.file.path, target);
  const hash = createHash('sha256').update(readFileSync(target)).digest('hex');
  const row = { id, project_id: projectId, name, path: target, sha256: hash, duration: null, created_at: now() };
  db.prepare('INSERT INTO videos VALUES (?,?,?,?,?,?,?)').run(row.id, row.project_id, row.name, row.path, row.sha256, row.duration, row.created_at);
  res.status(201).json({ ...row, path: undefined });
});

app.get('/api/videos/:id', (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id=?').get(req.params.id) as any;
  if (!video) return res.sendStatus(404);
  res.json({
    video: { ...video, path: undefined },
    events: db.prepare('SELECT * FROM events WHERE video_id=? ORDER BY start_time').all(video.id),
    reports: db.prepare('SELECT id,title,created_at FROM reports WHERE video_id=? ORDER BY created_at DESC').all(video.id),
    jobs: db.prepare('SELECT * FROM jobs WHERE video_id=? ORDER BY created_at DESC').all(video.id),
  });
});

app.delete('/api/videos/:id', (req, res) => {
  const id = String(req.params.id);
  const video = db.prepare('SELECT * FROM videos WHERE id=?').get(id) as any;
  if (!video) return res.sendStatus(404);
  try {
    try {
      const resolvedPath = resolveVideoPath(video);
      if (existsSync(resolvedPath)) rmSync(resolvedPath);
    } catch {}
    const frameDir = join(framesRoot, id);
    if (existsSync(frameDir)) rmSync(frameDir, { recursive: true, force: true });
    db.exec('BEGIN');
    db.prepare('DELETE FROM events WHERE video_id=?').run(id);
    db.prepare('DELETE FROM reports WHERE video_id=?').run(id);
    db.prepare('DELETE FROM jobs WHERE video_id=?').run(id);
    db.prepare('DELETE FROM videos WHERE id=?').run(id);
    db.exec('COMMIT');
    subscribers.get(id)?.forEach(stream => stream.end());
    subscribers.delete(id);
    res.sendStatus(204);
  } catch (error: any) {
    try { db.exec('ROLLBACK'); } catch {}
    res.status(500).json({ error: `動画を削除できませんでした: ${error.message}` });
  }
});

app.post('/api/videos/:id/analyze', (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id=?').get(req.params.id);
  if (!video) return res.sendStatus(404);
  const job = {
    id: randomUUID(),
    video_id: req.params.id,
    status: 'queued',
    progress: 0,
    message: '解析を待機中',
    created_at: now(),
    updated_at: now(),
    type: 'analyze',
    state_json: null,
  };
  db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?)').run(
    job.id, job.video_id, job.status, job.progress, job.message, job.created_at, job.updated_at, job.type, job.state_json
  );
  const abortController = new AbortController();
  jobAbortControllers.set(job.id, abortController);
  void analyze(job.id, video, req.body, abortController.signal);
  res.status(202).json(job);
});

// SSE (Server-Sent Events) エンドポイント
app.get('/api/jobs/:id/stream', (req, res) => {
  req.socket.setTimeout(0);
  req.socket.setKeepAlive(true, 10000);

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  if (!subscribers.has(req.params.id)) subscribers.set(req.params.id, new Set());
  subscribers.get(req.params.id)!.add(res);

  const currentJob = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
  if (currentJob) {
    res.write(`data: ${JSON.stringify(currentJob)}\n\n`);
  }

  const heartbeat = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      clearInterval(heartbeat);
      subscribers.get(req.params.id)?.delete(res);
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    subscribers.get(req.params.id)?.delete(res);
  });
});

// 報告書生成エンドポイント
app.post('/api/videos/:id/report', (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id=?').get(req.params.id);
  if (!video) return res.sendStatus(404);
  const events = db.prepare('SELECT 1 FROM events WHERE video_id=? LIMIT 1').get(req.params.id);
  if (!events) return res.status(400).json({ error: '先にイベントを解析してください' });

  const job = {
    id: randomUUID(),
    video_id: req.params.id,
    status: 'queued',
    progress: 0,
    message: '報告書の生成を待機中',
    created_at: now(),
    updated_at: now(),
    type: 'report',
    state_json: null,
  };
  db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?)').run(
    job.id, job.video_id, job.status, job.progress, job.message, job.created_at, job.updated_at, job.type, job.state_json
  );
  const abortController = new AbortController();
  jobAbortControllers.set(job.id, abortController);
  void generateReport(job.id, video, req.body, abortController.signal);
  res.status(202).json(job);
});

app.patch('/api/jobs/:id', (req, res) => {
  const id = String(req.params.id);
  const { status } = req.body;
  if (!['cancelled', 'paused'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const existing = db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as any;
  if (!existing) return res.sendStatus(404);

  // 報告書生成ジョブ（type === 'report'）の中断は不可（キャンセルのみ）
  if (status === 'paused' && existing.type === 'report') {
    return res.status(400).json({ error: '報告書生成は中断できません。キャンセルしてください。' });
  }

  if (!['queued', 'running'].includes(existing.status)) {
    return res.status(409).json({ error: `ジョブはすでに ${existing.status} 状態です` });
  }

  // paused の場合は先に DB を更新してから abort（analyze の catch で isPaused を判定するため）
  if (status === 'paused') {
    db.prepare('UPDATE jobs SET status=?, updated_at=? WHERE id=?').run('paused', now(), id);
  }

  const abortController = jobAbortControllers.get(id);
  if (abortController) {
    abortController.abort();
    jobAbortControllers.delete(id);
  } else {
    // AbortController が登録されていない場合の安全策
    const msg = status === 'paused' ? '解析を中断しました。' : (existing.type === 'report' ? '報告書の生成をキャンセルしました。' : '解析をキャンセルしました。');
    updateJob(id, 0, msg, status, null);
  }

  res.sendStatus(204);
});

// 中断した解析を再開するエンドポイント
app.post('/api/jobs/:id/resume', (req, res) => {
  const jobId = String(req.params.id);
  const pausedJob = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId) as any;
  if (!pausedJob) return res.sendStatus(404);
  if (pausedJob.status !== 'paused') {
    return res.status(409).json({ error: `ジョブは中断状態ではありません (status: ${pausedJob.status})` });
  }

  const video = db.prepare('SELECT * FROM videos WHERE id=?').get(pausedJob.video_id) as any;
  if (!video) return res.sendStatus(404);

  let state: any = null;
  if (pausedJob.state_json) {
    try {
      state = JSON.parse(pausedJob.state_json);
    } catch {}
  }

  // 新しいジョブを作成して再解析を開始
  const newJob = {
    id: randomUUID(),
    video_id: pausedJob.video_id,
    type: 'analyze',
    status: 'queued',
    progress: pausedJob.progress || 0,
    message: '解析を再開しています...',
    created_at: now(),
    updated_at: now(),
    state_json: pausedJob.state_json,
  };
  db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?)').run(
    newJob.id,
    newJob.video_id,
    newJob.status,
    newJob.progress,
    newJob.message,
    newJob.created_at,
    newJob.updated_at,
    newJob.type,
    newJob.state_json
  );

  const abortController = new AbortController();
  jobAbortControllers.set(newJob.id, abortController);

  const options: AnalyzeOptions = {
    providerId: req.body?.providerId || state?.providerId,
    profileId: req.body?.profileId || state?.profileId,
    customPerceptionPrompt: req.body?.customPerceptionPrompt || state?.customPerceptionPrompt,
    mode: req.body?.mode || state?.mode,
    resumeState: state?.files?.length ? {
      completedBatches: state.completedBatches || 0,
      events: state.events || [],
      files: state.files,
      interval: state.interval || 1,
      duration: state.duration || 0,
      totalBatches: state.totalBatches || 0,
    } : undefined,
  };

  void analyze(newJob.id, video, options, abortController.signal);

  res.status(202).json(newJob);
});

// 報告書取得エンドポイント
app.get('/api/reports/:id', (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id);
  report ? res.json(report) : res.sendStatus(404);
});

const dist = join(root, 'dist');
if (existsSync(dist)) app.use(express.static(dist));
app.get(/.*/, (_req, res) => existsSync(dist) ? res.sendFile(join(dist, 'index.html')) : res.status(404).send('フロントエンドを起動するには npm run dev を使用してください。'));

const port = Number(process.env.PORT || 5173);
const server = app.listen(port, () => console.log(`Video Scripter: http://localhost:${port}`));

server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 120000;
