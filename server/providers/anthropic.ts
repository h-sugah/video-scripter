import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AIProvider, ProviderConfig, VisionBatchParams, TextGenerationParams } from './types.js';
import { validateProviderUrl } from './validator.js';
import { createFetchTimeout, combineSignals, CONNECT_TEST_TIMEOUT_MS, RESPONSE_START_TIMEOUT_MS } from './utils.js';

export class AnthropicProvider implements AIProvider {
  readonly id = 'anthropic' as const;
  readonly name = 'Anthropic (Claude)';
  readonly capabilities = {
    video_input: false,
    image_input: true,
    structured_output: false,
    streaming: true,
  };
  readonly defaultBaseUrl = 'https://api.anthropic.com/v1';
  readonly defaultModel = 'claude-sonnet-5';
  readonly popularModels = [
    'claude-sonnet-5',
    'claude-opus-4-8',
    'claude-fable-5',
  ];

  private getValidatedBaseUrl(baseUrl?: string): string {
    const raw = baseUrl || this.defaultBaseUrl;
    const val = validateProviderUrl('anthropic', raw);
    if (!val.valid || !val.normalizedUrl) {
      throw new Error(`Anthropic URL検証エラー: ${val.error}`);
    }
    return val.normalizedUrl;
  }

  private getHeaders(config: ProviderConfig): Record<string, string> {
    const token = config.token?.trim() || '';
    return {
      'Content-Type': 'application/json',
      'x-api-key': token,
      'anthropic-version': '2023-06-01',
    };
  }

  async testConnection(config: ProviderConfig): Promise<{ models: string[] }> {
    const base = this.getValidatedBaseUrl(config.baseUrl);
    const token = config.token?.trim();
    if (!token) throw new Error('Anthropic APIキーを入力してください');

    try {
      const fetchTimeout = createFetchTimeout(CONNECT_TEST_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(`${base}/models`, {
          headers: this.getHeaders(config),
          keepalive: true,
          redirect: 'error',
          signal: fetchTimeout.signal,
        });
      } finally {
        fetchTimeout.clear();
      }

      if (res.ok) {
        const data = (await res.json()) as any;
        const models: string[] = (data.data || []).map((m: any) => String(m.id)).filter(Boolean);
        if (models.length > 0) return { models: models.sort() };
      }
    } catch {}

    // /models が利用できない場合の簡易検証
    const fetchTimeout = createFetchTimeout(CONNECT_TEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${base}/messages`, {
        method: 'POST',
        headers: this.getHeaders(config),
        redirect: 'error',
        signal: fetchTimeout.signal,
        body: JSON.stringify({
          model: config.model?.trim() || this.defaultModel,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
    } finally {
      fetchTimeout.clear();
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Anthropic 認証/接続エラー (${res.status}): ${err.error?.message || res.statusText}`);
    }

    return { models: this.popularModels };
  }

  async analyzeVisionBatch(params: VisionBatchParams): Promise<string> {
    const { config, prompt, batchFiles, folder, onProgress, signal } = params;
    const base = this.getValidatedBaseUrl(config.baseUrl);
    const token = config.token?.trim();
    if (!token) throw new Error('Anthropic APIキーが設定されていません');
    const model = config.model?.trim() || this.defaultModel;

    const content: any[] = [];
    for (const file of batchFiles) {
      const b64 = readFileSync(join(folder, file)).toString('base64');
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: b64,
        },
      });
    }
    content.push({ type: 'text', text: prompt });

    const fetchTimeout = createFetchTimeout(RESPONSE_START_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${base}/messages`, {
        method: 'POST',
        headers: this.getHeaders(config),
        keepalive: true,
        redirect: 'error',
        signal: combineSignals(signal, fetchTimeout.signal),
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          temperature: 0.1,
          stream: true,
          messages: [{ role: 'user', content }],
        }),
      });
    } finally {
      fetchTimeout.clear();
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Anthropic エラー (${res.status}): ${err.error?.message || res.statusText}`);
    }

    if (!res.body) throw new Error('Anthropicからのレスポンスボディが空です');

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
            if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
              accumulatedContent += data.delta.text;
              tokenCount++;
              if (tokenCount % 15 === 0 && onProgress) {
                onProgress(tokenCount);
              }
            }
          } catch {}
        }
      }
    }

    const finalText = accumulatedContent.trim();
    if (finalText) return finalText;
    throw new Error('Anthropicから有効なテキストを受信できませんでした');
  }

  async generateText(params: TextGenerationParams): Promise<string> {
    const { config, prompt, onProgress, signal } = params;
    const base = this.getValidatedBaseUrl(config.baseUrl);
    const token = config.token?.trim();
    if (!token) throw new Error('Anthropic APIキーが設定されていません');
    const model = config.model?.trim() || this.defaultModel;

    const fetchTimeout = createFetchTimeout(RESPONSE_START_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${base}/messages`, {
        method: 'POST',
        headers: this.getHeaders(config),
        keepalive: true,
        redirect: 'error',
        signal: combineSignals(signal, fetchTimeout.signal),
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          temperature: 0.2,
          stream: true,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
    } finally {
      fetchTimeout.clear();
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Anthropic エラー (${res.status}): ${err.error?.message || res.statusText}`);
    }

    if (!res.body) throw new Error('Anthropicからのレスポンスボディが空です');

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
            if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
              accumulatedContent += data.delta.text;
              tokenCount++;
              if (tokenCount % 10 === 0 && onProgress) {
                onProgress(tokenCount);
              }
            }
          } catch {}
        }
      }
    }

    const finalText = accumulatedContent.trim();
    if (finalText) return finalText;
    throw new Error('Anthropicから有効なテキストを受信できませんでした');
  }
}
