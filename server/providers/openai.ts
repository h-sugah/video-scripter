import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AIProvider, ProviderConfig, VisionBatchParams, TextGenerationParams } from './types.js';
import { validateProviderUrl } from './validator.js';
import { createFetchTimeout, combineSignals, CONNECT_TEST_TIMEOUT_MS, RESPONSE_START_TIMEOUT_MS } from './utils.js';

export class OpenAIProvider implements AIProvider {
  readonly id = 'openai' as const;
  readonly name = 'OpenAI (ChatGPT)';
  readonly capabilities = {
    video_input: false,
    image_input: true,
    structured_output: true,
    streaming: true,
  };
  readonly defaultBaseUrl = 'https://api.openai.com/v1';
  readonly defaultModel = 'gpt-5.6-luna';
  readonly popularModels = [
    'gpt-5.6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
  ];

  private getValidatedBaseUrl(baseUrl?: string): string {
    const raw = baseUrl || this.defaultBaseUrl;
    const val = validateProviderUrl('openai', raw);
    if (!val.valid || !val.normalizedUrl) {
      throw new Error(`OpenAI URL検証エラー: ${val.error}`);
    }
    return val.normalizedUrl;
  }

  private getHeaders(config: ProviderConfig): Record<string, string> {
    const token = config.token?.trim() || '';
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async testConnection(config: ProviderConfig): Promise<{ models: string[] }> {
    const base = this.getValidatedBaseUrl(config.baseUrl);
    const token = config.token?.trim();
    if (!token) throw new Error('OpenAI APIキーを入力してください');

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

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`OpenAI 認証/接続エラー (${res.status}): ${err.error?.message || res.statusText}`);
    }

    const data = (await res.json()) as any;
    const allModels: string[] = (data.data || []).map((m: any) => String(m.id)).filter(Boolean);
    // GPT/O系モデルを優先表示
    const filtered = allModels.filter(m => m.startsWith('gpt-') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('chatgpt-'));
    return { models: filtered.length ? filtered.sort() : allModels.sort() };
  }

  async analyzeVisionBatch(params: VisionBatchParams): Promise<string> {
    const { config, prompt, batchFiles, folder, onProgress, signal } = params;
    const base = this.getValidatedBaseUrl(config.baseUrl);
    const token = config.token?.trim();
    if (!token) throw new Error('OpenAI APIキーが設定されていません');
    const model = config.model?.trim() || this.defaultModel;

    const content: any[] = [{ type: 'text', text: prompt }];
    for (const file of batchFiles) {
      const b64 = readFileSync(join(folder, file)).toString('base64');
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:image/jpeg;base64,${b64}`,
          detail: 'high',
        },
      });
    }

    const fetchTimeout = createFetchTimeout(RESPONSE_START_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(config),
        keepalive: true,
        redirect: 'error',
        signal: combineSignals(signal, fetchTimeout.signal),
        body: JSON.stringify({
          model,
          temperature: 0.1,
          max_tokens: 4096,
          stream: true,
          messages: [{ role: 'user', content }],
        }),
      });
    } finally {
      fetchTimeout.clear();
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`OpenAI エラー (${res.status}): ${err.error?.message || res.statusText}`);
    }

    if (!res.body) throw new Error('OpenAIからのレスポンスボディが空です');

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
        if (trimmed === 'data: [DONE]') continue;
        if (trimmed.startsWith('data: ')) {
          try {
            const data = JSON.parse(trimmed.slice(6));
            const delta = data.choices?.[0]?.delta;
            if (delta?.content) {
              accumulatedContent += delta.content;
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
    throw new Error('OpenAIから有効なテキストを受信できませんでした');
  }

  async generateText(params: TextGenerationParams): Promise<string> {
    const { config, prompt, onProgress, signal } = params;
    const base = this.getValidatedBaseUrl(config.baseUrl);
    const token = config.token?.trim();
    if (!token) throw new Error('OpenAI APIキーが設定されていません');
    const model = config.model?.trim() || this.defaultModel;

    const fetchTimeout = createFetchTimeout(RESPONSE_START_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(config),
        keepalive: true,
        redirect: 'error',
        signal: combineSignals(signal, fetchTimeout.signal),
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: 4096,
          stream: true,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
    } finally {
      fetchTimeout.clear();
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`OpenAI エラー (${res.status}): ${err.error?.message || res.statusText}`);
    }

    if (!res.body) throw new Error('OpenAIからのレスポンスボディが空です');

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
        if (trimmed === 'data: [DONE]') continue;
        if (trimmed.startsWith('data: ')) {
          try {
            const data = JSON.parse(trimmed.slice(6));
            const delta = data.choices?.[0]?.delta;
            if (delta?.content) {
              accumulatedContent += delta.content;
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
    throw new Error('OpenAIから有効なテキストを受信できませんでした');
  }
}
