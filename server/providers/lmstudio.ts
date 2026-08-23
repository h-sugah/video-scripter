import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Readable, PassThrough } from 'node:stream';
import type { AIProvider, ProviderConfig, VisionBatchParams, TextGenerationParams } from './types.js';
import { cleanModelText } from './utils.js';

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

async function executeViaCurlExe(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<LMResponse> {
  const method = options.method || 'GET';
  const headers = options.headers || {};
  const body = options.body;

  const args = ['-s', '-N', '-i', '-X', method];
  for (const [k, v] of Object.entries(headers)) {
    args.push('-H', `${k}: ${v}`);
  }
  if (body !== undefined) {
    args.push('--data-binary', '@-');
  }
  args.push(url);

  const proc = spawn('curl.exe', args);

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
        reject(new Error(`LM Studioへの接続に失敗しました (終了コード: ${code})`));
      }
    });
  });
}

async function fetchLM(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<LMResponse> {
  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers,
      body: options.body,
      keepalive: true,
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
    // WSL環境下でWindowsホストの127.0.0.1上のLM Studioへ接続する場合、Node.js fetchはECONNREFUSEDとなるためcurl.exeへフォールバック
    if (canUseCurlExe()) {
      try {
        return await executeViaCurlExe(url, options);
      } catch (curlErr: any) {
        throw new Error(`LM Studio接続エラー: ${curlErr.message || err.message} (LM Studioが起動していること、およびLocal Serverが開始されていることを確認してください)`);
      }
    }
    throw new Error(`LM Studio接続エラー: ${err.message} (127.0.0.1:1234 に接続できません。LM StudioでLocal Serverが起動しているか確認してください)`);
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

  private getHeaders(config: ProviderConfig): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = config.token?.trim();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  async testConnection(config: ProviderConfig): Promise<{ models: string[] }> {
    const base = (config.baseUrl || this.defaultBaseUrl).replace(/\/$/, '');
    const res = await fetchLM(`${base}/models`, {
      headers: this.getHeaders(config),
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
    const { config, prompt, batchFiles, folder, onProgress } = params;
    const base = (config.baseUrl || this.defaultBaseUrl).replace(/\/$/, '');
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

    const attempts: { name: string; body: any }[] = [
      {
        name: 'stream_plain',
        body: {
          model,
          temperature: 0.1,
          max_tokens: 4096,
          stream: true,
          messages: [{ role: 'user', content }],
        },
      },
      {
        name: 'stream_json',
        body: {
          model,
          temperature: 0.1,
          max_tokens: 4096,
          stream: true,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content }],
        },
      },
    ];

    let lastError: any = null;

    for (const attempt of attempts) {
      try {
        const res = await fetchLM(`${base}/chat/completions`, {
          method: 'POST',
          headers: this.getHeaders(config),
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

  async generateText(params: TextGenerationParams): Promise<string> {
    const { config, prompt, onProgress } = params;
    const base = (config.baseUrl || this.defaultBaseUrl).replace(/\/$/, '');
    const model = config.model?.trim();
    if (!model) throw new Error('LM Studioのモデルが指定されていません');

    const res = await fetchLM(`${base}/chat/completions`, {
      method: 'POST',
      headers: this.getHeaders(config),
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 4096,
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
              if (tokenCount % 10 === 0 && onProgress) {
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
    throw new Error('LM Studioから有効なテキストを受信できませんでした');
  }
}

