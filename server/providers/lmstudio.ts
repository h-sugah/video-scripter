import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Readable, PassThrough } from 'node:stream';
import type { AIProvider, ProviderConfig, VisionBatchParams, TextGenerationParams } from './types.js';
import { cleanModelText, createFetchTimeout, combineSignals, CONNECT_TEST_TIMEOUT_MS, RESPONSE_START_TIMEOUT_MS } from './utils.js';
import { validateProviderUrl } from './validator.js';

// LM Studioはユーザーのローカル環境(消費者向けGPU/CPU)でモデルを動かすため、大型モデル
// (例: Qwen3.8-27B)では画像を含むプロンプトのprefillに時間がかかり、最初のトークンが
// 返るまでの時間がクラウドAPIより大幅に長くなることがある。共通のRESPONSE_START_TIMEOUT_MS
// (30秒)は元より、その3倍(90秒)でも実際にタイムアウトする事例が確認されたため、
// 実測に基づき5分(300秒)まで引き上げる。接続テスト(testConnection)は/modelsを
// 呼ぶだけで生成を伴わないため、CONNECT_TEST_TIMEOUT_MSのまま変更しない。
export const LMSTUDIO_RESPONSE_START_TIMEOUT_MS = 300_000;

let hasCheckedCurlExe: boolean | null = null;
function canUseCurlExe(): boolean {
  if (hasCheckedCurlExe !== null) return hasCheckedCurlExe;
  if (process.platform === 'win32') {
    hasCheckedCurlExe = false;
    return false;
  }
  try {
    const res = spawnSync('curl.exe', ['--version']);
    hasCheckedCurlExe = res.status === 0;
  } catch {
    hasCheckedCurlExe = false;
  }
  return hasCheckedCurlExe;
}

interface LMResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<any>;
  body: ReadableStream<Uint8Array> | null;
}

async function executeViaCurlExe(url: string, options: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {}): Promise<LMResponse> {
  const method = options.method || 'GET';
  const headers = options.headers || {};
  const body = options.body;
  const signal = options.signal;

  if (signal?.aborted) throw new DOMException('中断されました', 'AbortError');

  // SSRF対策: プロトコルを http,https のみに限定し、リダイレクト追従を無効化
  //
  // 既知の残存リスク: Authorizationヘッダー(LM Studioトークン設定時)をcurl.exeの
  // コマンドライン引数(-H)として渡しているため、同一Windowsホスト上の他プロセス/他ユーザーが
  // タスクマネージャー等でコマンドライン全体を閲覧できた場合、トークンが露出し得る(WSL環境限定)。
  // 対策として「-K <設定ファイル>」でヘッダーをargv外に逃がす方式を検討したが、
  // WSL側で生成した一時ファイルのパス(/tmp/...)はWindowsネイティブバイナリのcurl.exeから
  // そのままでは読めず(WSLNIC/UNCパス変換が必要)、この環境では動作を検証できなかったため見送った。
  // WSL環境で実際に動作確認できる場合は、設定ファイル経由への変更を検討すること。
  const args = ['-s', '-N', '-i', '--proto', '=http,https', '--max-redirs', '0', '-X', method];
  for (const [k, v] of Object.entries(headers)) {
    args.push('-H', `${k}: ${v}`);
  }
  if (body !== undefined) {
    args.push('--data-binary', '@-');
  }
  args.push('--', url);

  const proc = spawn('curl.exe', args);

  if (signal) {
    const onAbort = () => {
      try { proc.kill(); } catch {}
    };
    signal.addEventListener('abort', onAbort, { once: true });
    proc.on('close', () => signal.removeEventListener('abort', onAbort));
  }

  if (body !== undefined) {
    proc.stdin.write(body);
    proc.stdin.end();
  }

  return new Promise((resolve, reject) => {
    let headerBuffer = Buffer.alloc(0);
    let isHeaderDone = false;
    let statusCode = 200;
    let statusText = 'OK';

    const onData = (chunk: Buffer) => {
      if (!isHeaderDone) {
        headerBuffer = Buffer.concat([headerBuffer, chunk]);
        const headerEndIndex = headerBuffer.indexOf(Buffer.from('\r\n\r\n'));
        if (headerEndIndex !== -1) {
          isHeaderDone = true;
          proc.stdout.removeListener('data', onData);

          const headerSection = headerBuffer.slice(0, headerEndIndex).toString('latin1');
          const firstLine = headerSection.split('\r\n')[0] || '';
          const match = firstLine.match(/HTTP\/\d(?:\.\d)?\s+(\d+)\s*(.*)/i);
          if (match) {
            statusCode = parseInt(match[1], 10);
            statusText = match[2] || (statusCode === 200 ? 'OK' : 'Error');
          }

          const remaining = headerBuffer.slice(headerEndIndex + 4);
          const passThrough = new PassThrough();
          if (remaining.length > 0) {
            passThrough.write(remaining);
          }
          proc.stdout.pipe(passThrough);

          const webStream = Readable.toWeb(passThrough) as ReadableStream<Uint8Array>;

          const getText = async (): Promise<string> => {
            const chunks: Uint8Array[] = [];
            const reader = webStream.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) chunks.push(value);
            }
            return Buffer.concat(chunks).toString('utf8');
          };

          resolve({
            ok: statusCode >= 200 && statusCode < 300,
            status: statusCode,
            statusText,
            text: getText,
            async json() {
              const txt = await getText();
              return JSON.parse(txt);
            },
            body: webStream,
          });
        }
      }
    };

    proc.stdout.on('data', onData);
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (!isHeaderDone) {
        if (signal?.aborted) {
          reject(new DOMException('中断されました', 'AbortError'));
        } else {
          reject(new Error(`LM Studioへの接続に失敗しました (終了コード: ${code})`));
        }
      }
    });
  });
}

async function fetchLM(url: string, options: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<LMResponse> {
  // LM Studioが無応答のまま無期限にハングしないよう、応答開始(ヘッダー受信)までにタイムアウトを設ける。
  // ヘッダー受信後(=fetchLMが返った後)のストリーム読み取りはユーザーのキャンセルsignalのみで制御する。
  const fetchTimeout = createFetchTimeout(options.timeoutMs ?? RESPONSE_START_TIMEOUT_MS);
  const combinedSignal = combineSignals(options.signal, fetchTimeout.signal);
  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers,
      body: options.body,
      keepalive: true,
      redirect: 'error',
      signal: combinedSignal,
    });
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      async text() {
        return res.text();
      },
      async json() {
        return res.json();
      },
      body: res.body,
    };
  } catch (err: any) {
    if (options.signal?.aborted) {
      throw new DOMException('中断されました', 'AbortError');
    }
    if (fetchTimeout.signal.aborted) {
      throw new Error(`LM Studioへの接続がタイムアウトしました。LM StudioでLocal Serverが起動しているか確認してください。`);
    }
    // WSL環境下でWindowsホストの127.0.0.1上のLM Studioへ接続する場合、Node.js fetchはECONNREFUSEDとなるためcurl.exeへフォールバック
    if (canUseCurlExe()) {
      try {
        return await executeViaCurlExe(url, { ...options, signal: combinedSignal });
      } catch (curlErr: any) {
        if (fetchTimeout.signal.aborted) {
          throw new Error('LM Studioへの接続がタイムアウトしました。LM StudioでLocal Serverが起動しているか確認してください。');
        }
        throw new Error(`LM Studio接続エラー: ${curlErr.message || err.message} (LM Studioが起動していること、およびLocal Serverが開始されていることを確認してください)`);
      }
    }
    throw new Error(`LM Studio接続エラー: ${err.message} (127.0.0.1:1234 に接続できません。LM StudioでLocal Serverが起動しているか確認してください)`);
  } finally {
    fetchTimeout.clear();
  }
}

export class LMStudioProvider implements AIProvider {
  readonly id = 'lmstudio' as const;
  readonly name = 'LM Studio';
  readonly capabilities = {
    video_input: false,
    image_input: true,
    structured_output: true,
    streaming: true,
  };
  readonly defaultBaseUrl = 'http://127.0.0.1:1234/v1';
  readonly defaultModel = 'gemma-4-e4b';
  readonly popularModels = [
    'gemma-4-e4b',
    'qwen3.5-9b',
  ];

  private getValidatedBaseUrl(baseUrl?: string): string {
    const raw = baseUrl || this.defaultBaseUrl;
    const val = validateProviderUrl('lmstudio', raw);
    if (!val.valid || !val.normalizedUrl) {
      throw new Error(`LM Studio URL検証エラー: ${val.error}`);
    }
    return val.normalizedUrl;
  }

  private getHeaders(config: ProviderConfig): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = config.token?.trim();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  async testConnection(config: ProviderConfig): Promise<{ models: string[] }> {
    const base = this.getValidatedBaseUrl(config.baseUrl);
    const res = await fetchLM(`${base}/models`, {
      headers: this.getHeaders(config),
      timeoutMs: CONNECT_TEST_TIMEOUT_MS,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${txt}`);
    }
    const body = (await res.json()) as any;
    const models = [...new Set((body.data ?? []).map((item: any) => String(item.id)).filter(Boolean))] as string[];
    return { models };
  }

  async analyzeVisionBatch(params: VisionBatchParams): Promise<string> {
    const { config, prompt, batchFiles, folder, onProgress, signal } = params;
    const base = this.getValidatedBaseUrl(config.baseUrl);
    const model = config.model?.trim();
    if (!model) throw new Error('LM Studioのモデルが指定されていません');

    const content: any[] = [{ type: 'text', text: prompt }];
    for (const file of batchFiles) {
      const b64 = readFileSync(join(folder, file)).toString('base64');
      content.push({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${b64}` },
      });
    }

    // VISION_MAX_TOKENS: 4096だと、饒舌なモデル(例: Gemma-4-12B)が4枚分のイベントを
    // 説明する過程でJSON出力の途中(閉じ括弧の前)に達してしまい、不完全なJSONとなって
    // 後段のparseModelJsonが解析に失敗するケースが確認された。8192へ引き上げて余裕を持たせる。
    const VISION_MAX_TOKENS = 8192;
    const attempts: { name: string; body: any }[] = [
      {
        name: 'stream_plain',
        body: {
          model,
          temperature: 0.1,
          max_tokens: VISION_MAX_TOKENS,
          stream: true,
          messages: [{ role: 'user', content }],
        },
      },
      {
        // 注意: response_format.typeに'json_object'を指定すると、LM Studioのバックエンドに
        // よっては「'response_format.type' must be 'json_schema' or 'text'」という
        // HTTP 400で拒否される(例: Qwen3.8-27B)。OpenAI互換APIの新しいstructured outputs
        // 仕様に厳密に従うバックエンド向けに、'json_schema'を使う。strict:falseとして
        // JSON Schemaはあくまで「ガイド」として扱わせ、バックエンドによる厳格な
        // additionalProperties/required制約での追加拒否を避ける。
        name: 'stream_json_schema',
        body: {
          model,
          temperature: 0.1,
          max_tokens: VISION_MAX_TOKENS,
          stream: true,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'video_events',
              strict: false,
              schema: {
                type: 'object',
                properties: {
                  events: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        start_time: { type: 'number' },
                        end_time: { type: ['number', 'null'] },
                        event_type: { type: 'string' },
                        description: { type: 'string' },
                        objects: { type: 'array', items: { type: 'string' } },
                        confidence: { type: 'number' },
                        frame_index: { type: 'integer' },
                      },
                      required: ['start_time', 'description'],
                    },
                  },
                },
                required: ['events'],
              },
            },
          },
          messages: [{ role: 'user', content }],
        },
      },
    ];

    // 各試行(attempt)の失敗理由をすべて保持する。最後の試行の失敗理由だけを見せると、
    // 実際に原因を特定すべき最初の試行のエラーが握りつぶされてしまうため。
    const attemptErrors: string[] = [];

    for (const attempt of attempts) {
      try {
        const res = await fetchLM(`${base}/chat/completions`, {
          method: 'POST',
          headers: this.getHeaders(config),
          body: JSON.stringify(attempt.body),
          signal,
          timeoutMs: LMSTUDIO_RESPONSE_START_TIMEOUT_MS,
        });

        if (!res.ok) {
          const errorText = await res.text().catch(() => '');
          attemptErrors.push(`[${attempt.name}] HTTP ${res.status}: ${errorText}`);
          continue;
        }

        if (!res.body) {
          throw new Error('レスポンスボディが空です');
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let accumulatedContent = '';
        let accumulatedReasoning = '';
        let tokenCount = 0;
        let finishReason = '';

        while (true) {
          if (signal?.aborted) {
            await reader.cancel();
            throw new DOMException('中断されました', 'AbortError');
          }
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
                const choice = data.choices?.[0];
                if (choice?.finish_reason) finishReason = choice.finish_reason;
                const delta = choice?.delta;
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

        // finish_reason:'length' は max_tokens 上限に達して応答が途中で打ち切られたことを示す。
        // この場合、たとえテキストが取得できていてもJSONとして不完全な可能性が高いため、
        // 「JSON抽出失敗」という分かりにくい下流エラーに落とさず、ここで原因を明示して
        // 次の試行へ進む(いずれの試行も同じ上限のため、最終的にはこの明確な理由で失敗を報告する)。
        if (finishReason === 'length') {
          attemptErrors.push(
            `[${attempt.name}] 応答がトークン上限(max_tokens=${VISION_MAX_TOKENS})に達し、出力が途中で切れました。1バッチのフレーム枚数を減らすか、より簡潔な出力をするモデルの利用を検討してください。`
          );
          continue;
        }

        const finalText = accumulatedContent.trim() || accumulatedReasoning.trim();
        if (finalText) {
          return finalText;
        }

        attemptErrors.push(`[${attempt.name}] ストリームから有効なテキストを受信できませんでした`);
      } catch (err: any) {
        if (err?.name === 'AbortError') throw err;
        const causeDetail = err?.cause?.message || err?.cause?.code || '';
        attemptErrors.push(`[${attempt.name}] ${err?.message || String(err)}${causeDetail ? ` (${causeDetail})` : ''}`);
      }
    }

    throw new Error(`LM Studioでの解析に失敗しました: ${attemptErrors.join(' / ') || '不明なエラー'}`);
  }

  async generateText(params: TextGenerationParams): Promise<string> {
    const { config, prompt, onProgress, signal } = params;
    const base = this.getValidatedBaseUrl(config.baseUrl);
    const model = config.model?.trim();
    if (!model) throw new Error('LM Studioのモデルが指定されていません');

    const REPORT_MAX_TOKENS = 8192;
    const res = await fetchLM(`${base}/chat/completions`, {
      method: 'POST',
      headers: this.getHeaders(config),
      signal,
      timeoutMs: LMSTUDIO_RESPONSE_START_TIMEOUT_MS,
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: REPORT_MAX_TOKENS,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      throw new Error(`LM Studio HTTP ${res.status}: ${errorText}`);
    }

    if (!res.body) throw new Error('レスポンスボディが空です');

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let accumulatedContent = '';
    let accumulatedReasoning = '';
    let tokenCount = 0;
    let finishReason = '';

    while (true) {
      if (signal?.aborted) {
        await reader.cancel();
        throw new DOMException('中断されました', 'AbortError');
      }
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
            const choice = data.choices?.[0];
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            const delta = choice?.delta;
            if (delta) {
              if (typeof delta.content === 'string') {
                accumulatedContent += delta.content;
                tokenCount++;
              }
              if (typeof delta.reasoning_content === 'string') {
                accumulatedReasoning += delta.reasoning_content;
                tokenCount++;
              }
              if (tokenCount % 10 === 0 && onProgress) {
                onProgress(tokenCount);
              }
            }
          } catch {}
        }
      }
    }

    if (finishReason === 'length') {
      throw new Error(`応答がトークン上限(max_tokens=${REPORT_MAX_TOKENS})に達し、報告書の生成が途中で切れました。観測イベント数を絞るか、より簡潔な出力をするモデルの利用を検討してください。`);
    }

    const finalText = accumulatedContent.trim() || accumulatedReasoning.trim();
    if (finalText) {
      return finalText;
    }
    throw new Error('LM Studioから有効なテキストを受信できませんでした');
  }
}

