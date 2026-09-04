import type { AIProvider, ProviderId, ProviderConfig } from './types.js';
import { LMStudioProvider } from './lmstudio.js';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { GoogleGeminiProvider } from './google.js';

export * from './types.js';
export * from './utils.js';
export * from './validator.js';

const providers: Record<ProviderId, AIProvider> = {
  lmstudio: new LMStudioProvider(),
  openai: new OpenAIProvider(),
  anthropic: new AnthropicProvider(),
  google: new GoogleGeminiProvider(),
};

export function getProvider(id: ProviderId): AIProvider {
  const p = providers[id];
  if (!p) throw new Error(`未対応のAIプロバイダーです: ${id}`);
  return p;
}

export function getAllProviders(): AIProvider[] {
  return Object.values(providers);
}

export function getProviderMetaList() {
  return Object.values(providers).map(p => ({
    id: p.id,
    name: p.name,
    capabilities: p.capabilities,
    defaultBaseUrl: p.defaultBaseUrl,
    defaultModel: p.defaultModel,
    popularModels: p.popularModels,
  }));
}
