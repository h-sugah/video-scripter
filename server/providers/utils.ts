// 外部AIプロバイダーへのfetchに接続/応答待ちタイムアウトを追加するためのヘルパー。
// ヘッダー受信(fetchの解決)までのみを対象とし、それ以降のストリーム読み取りは対象外とする
// (ユーザーによるジョブキャンセル用signalのみで制御を続ける)。
// これにより「プロバイダーが無応答のまま無期限にハングする」ケースを防ぎつつ、
// 正当に長時間かかるストリーミング生成そのものは妨げない。
export function createFetchTimeout(timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('接続がタイムアウトしました', 'TimeoutError')), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

// ユーザーのキャンセル用signal(任意)とタイムアウト用signalを合成する。
// どちらか一方でも発火すればfetchが中断される。
export function combineSignals(userSignal: AbortSignal | undefined, timeoutSignal: AbortSignal): AbortSignal {
  return userSignal ? AbortSignal.any([userSignal, timeoutSignal]) : timeoutSignal;
}

// 接続テスト(testConnection)用の短いタイムアウト
export const CONNECT_TEST_TIMEOUT_MS = 20_000;
// 生成系リクエストの応答開始(ヘッダー受信)待ちタイムアウト
export const RESPONSE_START_TIMEOUT_MS = 30_000;

// 思考モデル（Thinking/Reasoning model）の <think> タグや前後の余計なテキストをクリーンアップ
export function cleanModelText(text: string): string {
  if (!text) return '';
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (cleaned.includes('<think>')) {
    const end = cleaned.indexOf('</think>');
    if (end !== -1) cleaned = cleaned.slice(end + 8).trim();
  }
  return cleaned;
}

// 自然言語テキストからイベントを救済抽出するフォールバック
export function extractEventsFromText(text: string): any[] {
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
export function parseModelJson(rawText: string): any {
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

export function normalizeEvents(payload: any) {
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
