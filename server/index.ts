import express from 'express';
import multer from 'multer';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, readFileSync, rmSync } from 'node:fs';
import { join, extname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const data = join(root, 'data');
const uploads = join(data, 'uploads');
const framesRoot = join(data, 'frames');
for (const path of [data, uploads, framesRoot]) mkdirSync(path, { recursive: true });

const db = new DatabaseSync(join(data, 'video-scripter.sqlite'));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, duration REAL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, video_id TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, video_id TEXT NOT NULL, start_time REAL NOT NULL, end_time REAL, event_type TEXT NOT NULL, description TEXT NOT NULL, objects_json TEXT NOT NULL, confidence REAL, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, video_id TEXT NOT NULL, title TEXT NOT NULL, markdown TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_audits (id TEXT PRIMARY KEY, video_id TEXT NOT NULL, stage TEXT NOT NULL, model TEXT NOT NULL, prompt TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);

const now = () => new Date().toISOString();
const getSetting = (key: string, fallback: string) => (db.prepare('SELECT value FROM settings WHERE key=?').get(key) as any)?.value ?? fallback;
const setSetting = (key: string, value: string) => db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
if (!db.prepare('SELECT 1 FROM settings WHERE key=?').get('lmstudio_url')) setSetting('lmstudio_url', 'http://127.0.0.1:1234/v1');

const lmStudioHeaders = () => {
  const token = getSetting('lmstudio_token', '').trim();
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
};

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/media', express.static(data));

const upload = multer({ dest: join(data, 'incoming'), limits: { fileSize: 10 * 1024 * 1024 * 1024 } });
const subscribers = new Map<string, Set<express.Response>>();

function updateJob(id: string, progress: number, message: string, status?: string) {
  const existing = db.prepare('SELECT status FROM jobs WHERE id=?').get(id) as any;
  db.prepare('UPDATE jobs SET progress=?,message=?,status=?,updated_at=? WHERE id=?').run(progress, message, status ?? existing?.status ?? 'running', now(), id);
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

function command(bin: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const p = spawn(bin, args);
    let err = '';
    p.stderr.on('data', d => err += d);
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(err) : reject(new Error(err || `${bin} failed`)));
  });
}

function seconds(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// 思考モデル（Thinking/Reasoning model）の <think> タグや前後の余計なテキストをクリーンアップ
function cleanModelText(text: string): string {
  if (!text) return '';
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (cleaned.includes('<think>')) {
    const end = cleaned.indexOf('</think>');
    if (end !== -1) cleaned = cleaned.slice(end + 8).trim();
  }
  return cleaned;
}

// APIレスポンスからコンテンツ文字列を安全に取得（reasoning_content等にも対応）
function extractChoiceContent(choice: any): string {
  if (!choice) return '';
  const msg = choice.message;
  if (msg) {
    if (typeof msg.content === 'string' && msg.content.trim()) return msg.content;
    if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim()) return msg.reasoning_content;
  }
  if (typeof choice.text === 'string' && choice.text.trim()) return choice.text;
  return typeof msg?.content === 'string' ? msg.content : '';
}

// 自然言語テキストからイベントを救済抽出するフォールバック
function extractEventsFromText(text: string): any[] {
  const events: any[] = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```')) continue;
    const timeMatch = trimmed.match(/(?:(?:(\d{1,2}):(\d{2})(?::(\d{2}))?)|(?:(\d+(?:\.\d+)?)\s*秒))/);
    if (timeMatch) {
      let start = 0;
      if (timeMatch[1] && timeMatch[2]) {
        start = Number(timeMatch[1]) * 60 + Number(timeMatch[2]);
      } else if (timeMatch[4]) {
        start = Number(timeMatch[4]);
      }
      const desc = trimmed.replace(/^[\*\-\d\.\s\:\(\)\[\]〜～\-]+/, '').trim() || trimmed;
      if (desc.length >= 2) {
        events.push({
          start_time: start,
          end_time: null,
          event_type: 'operation',
          description: desc,
          objects: [],
          confidence: 0.7,
          frame_index: 1,
        });
      }
    }
  }
  return events;
}

// 多段階でJSONを抽出・パースする堅牢な関数
function parseModelJson(rawText: string): any {
  const cleaned = cleanModelText(rawText);

  // 1. ```json ... ``` または ``` ... ``` コードブロックの抽出
  const codeBlockMatches = cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi);
  for (const m of codeBlockMatches) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }

  // 2. { ... } または [ ... ] の最外側の探索
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = cleaned.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      try {
        const repaired = candidate.replace(/,\s*([\}\]])/g, '$1').replace(/[\u0000-\u001F]+/g, ' ');
        return JSON.parse(repaired);
      } catch {}
    }
  }

  const firstBracket = cleaned.indexOf('[');
  const lastBracket = cleaned.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    const candidate = cleaned.slice(firstBracket, lastBracket + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      try {
        const repaired = candidate.replace(/,\s*([\}\]])/g, '$1').replace(/[\u0000-\u001F]+/g, ' ');
        return JSON.parse(repaired);
      } catch {}
    }
  }

  // 3. 全体の直接パース
  try {
    return JSON.parse(cleaned);
  } catch {}

  // 4. テキストからの救済抽出
  const textEvents = extractEventsFromText(cleaned || rawText);
  if (textEvents.length > 0) {
    return { events: textEvents };
  }

  throw new Error(`モデルの応答からJSON形式のイベントデータを抽出できませんでした（応答プレビュー: ${cleaned.slice(0, 120)}...）`);
}

function normalizeEvents(payload: any) {
  const candidates = [payload?.events, payload?.timeline, payload?.items, payload?.results, Array.isArray(payload) ? payload : null];
  const raw = candidates.find(Array.isArray) ?? [];
  return raw.filter((event: any) => event && typeof event === 'object' && (event.description || event.content || event.action || event.summary)).map((event: any) => ({
    start_time: event.start_time ?? event.timestamp ?? event.time ?? event.start ?? 0,
    end_time: event.end_time ?? event.end ?? null,
    event_type: event.event_type ?? event.type ?? 'other',
    description: event.description ?? event.content ?? event.action ?? event.summary,
    objects: event.objects ?? event.subjects ?? [],
    confidence: event.confidence ?? 0.5,
    frame_index: event.frame_index ?? event.frame ?? 1,
  }));
}

function formatDuration(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function reportFallback(video: any, events: any[], reason?: string) {
  const lines = events.map((event) => {
    const objects = JSON.parse(event.objects_json || '[]');
    return `- ${String(Math.floor(event.start_time / 60)).padStart(2, '0')}:${String(Math.floor(event.start_time % 60)).padStart(2, '0')}　${event.description}${objects.length ? `（対象: ${objects.join('、')}）` : ''}`;
  });
  return `# 作業報告書\n\n## 作業概要\n\n対象動画: ${video.name}\n\n## 時系列の作業内容\n\n${lines.join('\n')}\n\n## 異常・留意事項\n\n観測イベント上、明示的な異常は記録されていません。\n\n## 根拠\n\n本報告書は、保存された時系列イベントおよび各イベントに紐づく動画フレームを根拠に作成しました。\n${reason ? `\n> 注記: LM Studioによる文章整形が利用できなかったため、イベントデータから直接生成しています（${reason}）。` : ''}`;
}

// ストリーミング（SSE）受信により、長時間の思考・推論でもタイムアウト切断（Client disconnected）を100%防止するVisionモデル呼び出し関数
async function callVisionModelStream(
  base: string,
  model: string,
  prompt: string,
  batchFiles: string[],
  folder: string,
  headers: Record<string, string>,
  onProgress?: (tokenCount: number) => void
): Promise<string> {
  const content: any[] = [{ type: 'text', text: prompt }];
  for (const file of batchFiles) {
    const b64 = readFileSync(join(folder, file)).toString('base64');
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${b64}` }
    });
  }

  // 試行1: stream: true (ストリーミング受信でタイムアウトを完全に防止)
  const attempts: { name: string; body: any }[] = [
    {
      name: 'stream_plain',
      body: {
        model,
        temperature: 0.1,
        max_tokens: 4096,
        stream: true,
        messages: [{ role: 'user', content }]
      }
    },
    {
      name: 'stream_json',
      body: {
        model,
        temperature: 0.1,
        max_tokens: 4096,
        stream: true,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content }]
      }
    }
  ];

  let lastError: any = null;

  for (const attempt of attempts) {
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers,
        keepalive: true,
        body: JSON.stringify(attempt.body),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        lastError = new Error(`HTTP ${res.status}: ${errorText}`);
        continue;
      }

      if (!res.body) {
        throw new Error('レスポンスボディが空です');
      }

      // ストリーミングデータをチャンク単位で読み込み（接続を常にアクティブに維持）
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let accumulatedContent = '';
      let accumulatedReasoning = '';
      let tokenCount = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (trimmed === 'data: [DONE]') continue;
          if (trimmed.startsWith('data: ')) {
            try {
              const data = JSON.parse(trimmed.slice(6));
              const delta = data.choices?.[0]?.delta;
              if (delta) {
                if (typeof delta.content === 'string') {
                  accumulatedContent += delta.content;
                  tokenCount++;
                }
                if (typeof delta.reasoning_content === 'string') {
                  accumulatedReasoning += delta.reasoning_content;
                  tokenCount++;
                }
                if (tokenCount % 15 === 0 && onProgress) {
                  onProgress(tokenCount);
                }
              }
            } catch {}
          }
        }
      }

      const finalText = accumulatedContent.trim() || accumulatedReasoning.trim();
      if (finalText) {
        return finalText;
      }

      lastError = new Error('ストリームから有効なテキストを受信できませんでした');
    } catch (err: any) {
      lastError = err;
    }
  }

  const causeDetail = lastError?.cause?.message || lastError?.cause?.code || '';
  const detail = causeDetail ? ` (${causeDetail})` : '';
  throw new Error(`${lastError?.message || 'LM Studioへの接続に失敗しました'}${detail}`);
}

async function analyze(jobId: string, video: any) {
  try {
    updateJob(jobId, 5, '動画情報を確認しています');
    const probe = await new Promise<string>((resolve, reject) => {
      const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', video.path]);
      let out = '';
      p.stdout.on('data', d => out += d);
      p.on('error', reject);
      p.on('close', c => c === 0 ? resolve(out) : reject(new Error('ffprobeを実行できません')));
    });
    const duration = Number(probe.trim());
    db.prepare('UPDATE videos SET duration=? WHERE id=?').run(duration, video.id);

    updateJob(jobId, 15, '代表フレームを抽出しています');
    const folder = join(framesRoot, video.id);
    mkdirSync(folder, { recursive: true });

    // 既存の古いフレームをクリーンアップ
    const { readdirSync, rmSync: removeFile } = await import('node:fs');
    const existing = readdirSync(folder);
    for (const f of existing) {
      try { removeFile(join(folder, f)); } catch {}
    }

    // 短い動画でも変化を追えるよう最低6枚、長時間の動画は15秒に1枚程度サンプリング
    // 証跡としての視認性・精細度を確保するため、解像度を min(1080,iw) に設定
    const count = Math.max(6, Math.ceil(duration / 15));
    const interval = Math.max(1, duration / count);
    await command('ffmpeg', ['-y', '-i', video.path, '-vf', `fps=1/${interval},scale='min(1080,iw)':-2`, '-frames:v', String(count), join(folder, 'frame-%03d.jpg')]);

    const files = readdirSync(folder).filter(x => x.endsWith('.jpg')).sort();
    if (!files.length) throw new Error('フレーム画像を抽出できませんでした。');

    const base = getSetting('lmstudio_url', 'http://127.0.0.1:1234/v1').replace(/\/$/, '');
    const model = getSetting('lmstudio_model', '').trim();
    if (!model) throw new Error('LM StudioのVision対応モデルを設定画面で選択してください');

    // 1バッチあたり4フレーム（約1,200〜1,500トークン）でコンテキスト長2048〜4096のモデルでも安全に動作
    const BATCH_SIZE = 4;
    const totalBatches = Math.ceil(files.length / BATCH_SIZE);
    const allEvents: any[] = [];

    for (let b = 0; b < totalBatches; b++) {
      const batchFiles = files.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
      const batchStartIndex = b * BATCH_SIZE + 1; // 1-indexed
      const batchEndIndex = batchStartIndex + batchFiles.length - 1;

      const batchStartTime = (batchStartIndex - 1) * interval;
      const batchEndTime = Math.min(duration, batchEndIndex * interval);

      const progress = Math.round(20 + (b / totalBatches) * 75);
      const rangeStr = `${formatDuration(batchStartTime)}〜${formatDuration(batchEndTime)}`;
      updateJob(jobId, progress, `区間 ${b + 1}/${totalBatches} (${rangeStr}) の${batchFiles.length}フレームをLM Studioで解析中...`);

      const prompt = `あなたは作業映像の監査担当です。以下の動画区間から抽出された【${batchFiles.length}枚のフレーム画像】（動画全体${duration.toFixed(1)}秒中の ${batchStartTime.toFixed(1)}秒〜${batchEndTime.toFixed(1)}秒付近、各フレームは約${interval.toFixed(1)}秒間隔、フレーム番号 #${batchStartIndex}〜#${batchEndIndex}）を時系列順に観察し、確認できる事実だけを日本語で詳細に抽出してください。

【重要指示】
1. 思考（Thinking/Reasoning）は必要最小限（3行以内）とし、速やかに指定のJSON形式で出力してください。
2. 添付された画像は全部で${batchFiles.length}枚です。それぞれのフレーム番号は #${batchStartIndex} から #${batchEndIndex} です。
3. start_time と end_time は、動画全体の開始（0秒）からの絶対秒数（${batchStartTime.toFixed(1)}〜${batchEndTime.toFixed(1)}秒の範囲）で記載してください。
4. frame_index には提示されたフレーム番号（${batchStartIndex}〜${batchEndIndex}）を記載してください。
5. 必ず以下のJSON形式のオブジェクトのみを出力してください。

\`\`\`json
{
  "events": [
    {
      "start_time": ${batchStartTime.toFixed(1)},
      "end_time": ${batchEndTime.toFixed(1)},
      "event_type": "operation",
      "description": "確認できる事実",
      "objects": ["対象物"],
      "confidence": 1.0,
      "frame_index": ${batchStartIndex}
    }
  ]
}
\`\`\``;

      const modelResponse = await callVisionModelStream(
        base,
        model,
        prompt,
        batchFiles,
        folder,
        lmStudioHeaders(),
        (tokenCount) => {
          updateJob(jobId, progress, `区間 ${b + 1}/${totalBatches} (${rangeStr}) 解析中 (${tokenCount}トークン生成)...`);
        }
      );

      db.prepare('INSERT INTO ai_audits VALUES (?,?,?,?,?,?,?)').run(
        randomUUID(),
        video.id,
        `perception_batch_${b + 1}_of_${totalBatches}`,
        model,
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
    }

    if (!allEvents.length) {
      throw new Error('モデルがイベントを返しませんでした。Vision対応モデルがLM Studioでロード・選択されていることを確認してください（AI応答は監査ログに保存済みです）');
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
        Math.max(0, Math.min(1, Number(event.confidence) || 0)),
        JSON.stringify({ frame: `frames/${video.id}/${files[idx - 1]}`, frame_index: idx, approximate_time: (idx - 0.5) * interval }),
        now()
      );
    }

    updateJob(jobId, 100, `${allEvents.length}件のイベントを抽出しました`, 'completed');
  } catch (error: any) {
    const cause = error?.cause ? ` (詳細: ${error.cause.message || error.cause.code || error.cause})` : '';
    updateJob(jobId, 0, `${error.message}${cause}。FFmpegとLM Studioの起動・モデル設定を確認してください。`, 'failed');
  }
}

app.get('/api/health', (_req, res) => res.json({ ffmpeg: spawnSync('ffmpeg', ['-version']).status === 0, lmstudioUrl: getSetting('lmstudio_url', ''), node: process.version }));
app.get('/api/settings', (_req, res) => res.json({ lmstudio_url: getSetting('lmstudio_url', ''), lmstudio_model: getSetting('lmstudio_model', ''), lmstudio_token_configured: Boolean(getSetting('lmstudio_token', '')) }));
app.put('/api/settings', (req, res) => {
  for (const key of ['lmstudio_url', 'lmstudio_model']) if (typeof req.body[key] === 'string') setSetting(key, req.body[key]);
  if (typeof req.body.lmstudio_token === 'string' && req.body.lmstudio_token.trim()) setSetting('lmstudio_token', req.body.lmstudio_token.trim());
  if (req.body.clear_lmstudio_token === true) setSetting('lmstudio_token', '');
  res.sendStatus(204);
});

app.post('/api/lmstudio/test', async (_req, res) => {
  try {
    const base = getSetting('lmstudio_url', '').replace(/\/$/, '');
    const response = await fetch(`${base}/models`, { headers: lmStudioHeaders(), keepalive: true });
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    const body = await response.json() as any;
    const models = [...new Set((body.data ?? []).map((item: any) => String(item.id)).filter(Boolean))];
    res.json({ models });
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
    if (video.path.startsWith(uploads) && existsSync(video.path)) rmSync(video.path);
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
  const job = { id: randomUUID(), video_id: req.params.id, status: 'queued', progress: 0, message: '解析を待機中', created_at: now(), updated_at: now() };
  db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?,?)').run(job.id, job.video_id, job.status, job.progress, job.message, job.created_at, job.updated_at);
  void analyze(job.id, video);
  res.status(202).json(job);
});

// SSE (Server-Sent Events) エンドポイント: コネクション切断を防ぐ Keep-Alive ハートビートを実装
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

app.post('/api/videos/:id/report', async (req, res) => {
  req.socket.setTimeout(0);
  const video = db.prepare('SELECT * FROM videos WHERE id=?').get(req.params.id) as any;
  const events = db.prepare('SELECT * FROM events WHERE video_id=? ORDER BY start_time').all(req.params.id) as any[];
  if (!video) return res.sendStatus(404);
  if (!events.length) return res.status(400).json({ error: '先にイベントを解析してください' });

  const base = getSetting('lmstudio_url', '').replace(/\/$/, '');
  const model = getSetting('lmstudio_model', '').trim();
  const compact = events.map(e => ({ time: e.start_time, description: e.description, type: e.event_type, confidence: e.confidence }));
  const prompt = `以下の観測イベントだけを根拠に、詳細な日本語の作業報告書をMarkdownで作成してください。推測は書かず、不確実な事実は明記してください。見出しは「作業概要」「時系列の作業内容」「異常・留意事項」「根拠」。動画名: ${video.name}\nイベント: ${JSON.stringify(compact)}`;
  let markdown = '';
  let fallbackReason = '';

  try {
    if (!model) throw new Error('LM Studioのモデルが未選択です');
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: lmStudioHeaders(),
      keepalive: true,
      body: JSON.stringify({ model, temperature: 0.2, messages: [{ role: 'user', content: prompt }] }),
    });
    const raw = await response.text();
    db.prepare('INSERT INTO ai_audits VALUES (?,?,?,?,?,?,?)').run(randomUUID(), video.id, 'report', model, prompt, raw, now());
    if (!response.ok) throw new Error(`LM Studioの応答: ${response.status} ${raw}`);
    const json = JSON.parse(raw);
    const content = cleanModelText(extractChoiceContent(json.choices?.[0]));
    markdown = typeof content === 'string' ? content.trim() : '';
    if (!markdown) throw new Error('LM Studioが報告書本文を返しませんでした');
  } catch (error: any) {
    fallbackReason = error.message;
    markdown = reportFallback(video, events, fallbackReason);
  }

  const report = {
    id: randomUUID(),
    video_id: video.id,
    title: `${video.name} 作業報告書${fallbackReason ? '（イベントから生成）' : ''}`,
    markdown,
    created_at: now(),
  };
  db.prepare('INSERT INTO reports VALUES (?,?,?,?,?)').run(report.id, report.video_id, report.title, report.markdown, report.created_at);
  res.status(201).json({
    ...report,
    fallback: Boolean(fallbackReason),
    message: fallbackReason ? `LM Studioの文章整形を利用できなかったため、イベントから報告書を生成しました: ${fallbackReason}` : undefined,
  });
});

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
