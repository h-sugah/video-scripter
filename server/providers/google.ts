import { readFileSync, statSync, openAsBlob } from 'node:fs';
import { join } from 'node:path';
import type {
  AIProvider,
  ProviderConfig,
  VisionBatchParams,
  VideoDirectParams,
  TextGenerationParams,
} from './types.js';
import { validateProviderUrl, validateGoogleUploadUrl } from './validator.js';
import { createFetchTimeout, combineSignals, CONNECT_TEST_TIMEOUT_MS, RESPONSE_START_TIMEOUT_MS } from './utils.js';

// 注意: このファイルはGemini APIキーをURLクエリパラメータ(?key=...)で送信している(Google側のREST API仕様上の要求)。
// URLに秘密情報が乗るため、将来HTTPアクセスログ・デバッグログ・プロキシログ等を追加する際は、
// このファイルが送信するリクエストURLをそのまま記録しないよう注意すること
// (現状このファイル・呼び出し元にconsole.log等でURLを出力する箇所は無い)。
export class GoogleGeminiProvider implements AIProvider {
  readonly id = 'google' as const;
  readonly name = 'Google (Gemini)';
  readonly capabilities = {
    video_input: true,
    image_input: true,
    structured_output: true,
    streaming: true,
  };
  readonly defaultBaseUrl = 'https://generativelanguage.googleapis.com';
  readonly defaultModel = 'gemini-3.6-flash';
  readonly popularModels = [
    'gemini-3.6-flash',
    'gemini-3.6-pro',
  ];

  private getValidatedBaseUrl(baseUrl?: string): string {
    const raw = baseUrl || this.defaultBaseUrl;
    const val = validateProviderUrl('google', raw);
    if (!val.valid || !val.normalizedUrl) {
      throw new Error(`Gemini URL検証エラー: ${val.error}`);
    }
    return val.normalizedUrl;
  }

  private getCleanModel(modelName: string): string {
    return (modelName || this.defaultModel).replace(/^models\//, '').trim();
  }

  async testConnection(config: ProviderConfig): Promise<{ models: string[] }> {
    const base = this.getValidatedBaseUrl(config.baseUrl);
    const token = config.token?.trim();
    if (!token) throw new Error('Google Gemini APIキーを入力してください');

    const fetchTimeout = createFetchTimeout(CONNECT_TEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${base}/v1beta/models?key=${encodeURIComponent(token)}`, {
        keepalive: true,
        redirect: 'error',
        signal: fetchTimeout.signal,
      });
    } finally {
      fetchTimeout.clear();
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Gemini 認証/接続エラー (${res.status}): ${err.error?.message || res.statusText}`);
    }

    const data = (await res.json()) as any;
    const allModels: string[] = (data.models || [])
      .filter((m: any) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
      .map((m: any) => String(m.name || '').replace(/^models\//, ''))
      .filter((name: string) => name.startsWith('gemini-'));

    return { models: allModels.length ? allModels.sort() : this.popularModels };
  }

  async analyzeVisionBatch(params: VisionBatchParams): Promise<string> {
    const { config, prompt, batchFiles, folder, onProgress, signal } = params;
    const base = this.getValidatedBaseUrl(config.baseUrl);
    const token = config.token?.trim();
    if (!token) throw new Error('Google Gemini APIキーが設定されていません');
    const model = this.getCleanModel(config.model);

    const parts: any[] = [{ text: prompt }];
    for (const file of batchFiles) {
      const b64 = readFileSync(join(folder, file)).toString('base64');
      parts.push({
        inline_data: {
          mime_type: 'image/jpeg',
          data: b64,
        },
      });
    }

    const url = `${base}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?key=${encodeURIComponent(token)}&alt=sse`;
    const fetchTimeout = createFetchTimeout(RESPONSE_START_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        redirect: 'error',
        signal: combineSignals(signal, fetchTimeout.signal),
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 8192,
          },
        }),
      });
    } finally {
      fetchTimeout.clear();
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Gemini エラー (${res.status}): ${err.error?.message || res.statusText}`);
    }

    return this.consumeGeminiStream(res, onProgress, signal);
  }

  async analyzeVideoDirect(params: VideoDirectParams): Promise<string> {
    const { config, prompt, videoPath, videoName, mimeType, onProgress, signal } = params;
    const base = this.getValidatedBaseUrl(config.baseUrl);
    const token = config.token?.trim();
    if (!token) throw new Error('Google Gemini APIキーが設定されていません');
    const model = this.getCleanModel(config.model);

    if (signal?.aborted) throw new DOMException('中断されました', 'AbortError');
    onProgress?.('Gemini File API に動画をアップロード中...');
    const fileStats = statSync(videoPath);
    const fileSize = fileStats.size;

    // 1. Resumable Upload セッション開始
    const uploadInitUrl = `${base}/upload/v1beta/files?key=${encodeURIComponent(token)}`;
    const initFetchTimeout = createFetchTimeout(RESPONSE_START_TIMEOUT_MS);
    let initRes: Response;
    try {
      initRes = await fetch(uploadInitUrl, {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': String(fileSize),
          'X-Goog-Upload-Header-Content-Type': mimeType || 'video/mp4',
          'Content-Type': 'application/json',
        },
        redirect: 'error',
        signal: combineSignals(signal, initFetchTimeout.signal),
        body: JSON.stringify({
          file: {
            display_name: videoName,
          },
        }),
      });
    } finally {
      initFetchTimeout.clear();
    }

    if (!initRes.ok) {
      const err = await initRes.json().catch(() => ({}));
      throw new Error(`Gemini アップロード初期化エラー (${initRes.status}): ${err.error?.message || initRes.statusText}`);
    }

    const rawUploadUrl = initRes.headers.get('x-goog-upload-url');
    if (!rawUploadUrl) {
      throw new Error('Gemini アップロード用URLを取得できませんでした');
    }

    const uploadUrlVal = validateGoogleUploadUrl(rawUploadUrl);
    if (!uploadUrlVal.valid || !uploadUrlVal.normalizedUrl) {
      throw new Error(`Gemini アップロードURL検証エラー: ${uploadUrlVal.error}`);
    }
    const uploadUrl = uploadUrlVal.normalizedUrl;

    // 2. 実データのアップロード (openAsBlobでストリーミング送信 — 巨大ファイルをメモリへ全量読み込まない)
    // 注意: このfetchは動画本体(最大10GB)の送信が完了するまで解決しないため、
    // 他の呼び出しと違って接続タイムアウトを付与しない(低速回線での大容量アップロードを妨げないため)。
    // 中断はユーザーのキャンセル操作(signal)でのみ行う。
    const videoBlob = await openAsBlob(videoPath, { type: mimeType || 'video/mp4' });
    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Length': String(fileSize),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      redirect: 'error',
      signal,
      body: videoBlob,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.json().catch(() => ({}));
      throw new Error(`Gemini 動画アップロード失敗 (${uploadRes.status}): ${err.error?.message || uploadRes.statusText}`);
    }

    const uploadData = (await uploadRes.json()) as any;
    const fileResource = uploadData.file;
    const fileName = fileResource?.name; // e.g. "files/1234abcd"
    const fileUri = fileResource?.uri;

    if (!fileName || !fileUri) {
      throw new Error('Gemini File リソースの作成に失敗しました');
    }

    try {
      // 3. 動画処理（PROCESSING -> ACTIVE）の待機
      let state = fileResource.state;
      let attempts = 0;
      while (state === 'PROCESSING' && attempts < 60) {
        if (signal?.aborted) throw new DOMException('中断されました', 'AbortError');
        onProgress?.(`Gemini側で動画を解析前処理中 (${attempts + 1}秒)...`);
        await new Promise(r => setTimeout(r, 2000));
        const checkFetchTimeout = createFetchTimeout(CONNECT_TEST_TIMEOUT_MS);
        let checkRes: Response;
        try {
          checkRes = await fetch(`${base}/v1beta/${fileName}?key=${encodeURIComponent(token)}`, {
            redirect: 'error',
            signal: combineSignals(signal, checkFetchTimeout.signal),
          });
        } finally {
          checkFetchTimeout.clear();
        }
        if (checkRes.ok) {
          const checkData = (await checkRes.json()) as any;
          state = checkData.state;
          if (state === 'FAILED') {
            throw new Error(`Gemini側での動画処理に失敗しました: ${checkData.error?.message || '不明なエラー'}`);
          }
        }
        attempts += 2;
      }

      if (state !== 'ACTIVE') {
        throw new Error('Geminiでの動画前処理がタイムアウトしました');
      }

      if (signal?.aborted) throw new DOMException('中断されました', 'AbortError');
      onProgress?.('Geminiで動画全体を直接解析中...');

      // 4. streamGenerateContent 呼び出し
      const streamUrl = `${base}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?key=${encodeURIComponent(token)}&alt=sse`;
      const generateFetchTimeout = createFetchTimeout(RESPONSE_START_TIMEOUT_MS);
      let generateRes: Response;
      try {
        generateRes = await fetch(streamUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
          redirect: 'error',
          signal: combineSignals(signal, generateFetchTimeout.signal),
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    file_data: {
                      file_uri: fileUri,
                      mime_type: mimeType || 'video/mp4',
                    },
                  },
                  { text: prompt },
                ],
              },
            ],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 8192,
            },
          }),
        });
      } finally {
        generateFetchTimeout.clear();
      }

      if (!generateRes.ok) {
        const err = await generateRes.json().catch(() => ({}));
        throw new Error(`Gemini 動画直接解析エラー (${generateRes.status}): ${err.error?.message || generateRes.statusText}`);
      }

      return await this.consumeGeminiStream(generateRes, () => {}, signal);
    } finally {
      // 5. 解析完了後（またはエラー・中断時）にGemini上の一時ファイルをクリーンアップ
      // ベストエフォートの後始末のため、応答が無くても長く待たせないよう短めのタイムアウトを付ける。
      const cleanupFetchTimeout = createFetchTimeout(CONNECT_TEST_TIMEOUT_MS);
      try {
        await fetch(`${base}/v1beta/${fileName}?key=${encodeURIComponent(token)}`, {
          method: 'DELETE',
          redirect: 'error',
          signal: cleanupFetchTimeout.signal,
        });
      } catch {} finally {
        cleanupFetchTimeout.clear();
      }
    }
  }

  async generateText(params: TextGenerationParams): Promise<string> {
    const { config, prompt, onProgress, signal } = params;
    const base = this.getValidatedBaseUrl(config.baseUrl);
    const token = config.token?.trim();
    if (!token) throw new Error('Google Gemini APIキーが設定されていません');
    const model = this.getCleanModel(config.model);

    const url = `${base}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?key=${encodeURIComponent(token)}&alt=sse`;
    const fetchTimeout = createFetchTimeout(RESPONSE_START_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        redirect: 'error',
        signal: combineSignals(signal, fetchTimeout.signal),
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 8192,
          },
        }),
      });
    } finally {
      fetchTimeout.clear();
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Gemini エラー (${res.status}): ${err.error?.message || res.statusText}`);
    }

    return this.consumeGeminiStream(res, onProgress, signal);
  }

  private async consumeGeminiStream(res: Response, onProgress?: (tokenCount: number) => void, signal?: AbortSignal): Promise<string> {
    if (!res.body) throw new Error('Geminiからのレスポンスボディが空です');

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let accumulatedContent = '';
    let tokenCount = 0;

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
        if (trimmed.startsWith('data: ')) {
          try {
            const data = JSON.parse(trimmed.slice(6));
            const candidate = data.candidates?.[0];
            const parts = candidate?.content?.parts;
            if (Array.isArray(parts)) {
              for (const part of parts) {
                if (part.text) {
                  accumulatedContent += part.text;
                  tokenCount++;
                  if (tokenCount % 12 === 0 && onProgress) {
                    onProgress(tokenCount);
                  }
                }
              }
            }
          } catch {}
        }
      }
    }

    const finalText = accumulatedContent.trim();
    if (finalText) return finalText;
    throw new Error('Geminiから有効なテキストを受信できませんでした');
  }
}
