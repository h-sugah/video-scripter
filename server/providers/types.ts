export type ProviderId = 'lmstudio' | 'openai' | 'anthropic' | 'google';

export interface ProviderCapability {
  video_input: boolean;
  image_input: boolean;
  audio_input?: boolean;
  structured_output?: boolean;
  streaming: boolean;
}

export interface ProviderConfig {
  id: ProviderId;
  name: string;
  baseUrl: string;
  token?: string;
  model: string;
}

export interface VisionBatchParams {
  config: ProviderConfig;
  prompt: string;
  batchFiles: string[];
  folder: string;
  onProgress?: (tokenCount: number) => void;
}

export interface VideoDirectParams {
  config: ProviderConfig;
  prompt: string;
  videoPath: string;
  videoName: string;
  mimeType: string;
  duration?: number;
  onProgress?: (message: string) => void;
}

export interface TextGenerationParams {
  config: ProviderConfig;
  prompt: string;
  onProgress?: (tokenCount: number) => void;
}

export interface AIProvider {
  readonly id: ProviderId;
  readonly name: string;
  readonly capabilities: ProviderCapability;
  readonly defaultBaseUrl: string;
  readonly defaultModel: string;
  readonly popularModels: string[];

  testConnection(config: ProviderConfig): Promise<{ models: string[] }>;
  analyzeVisionBatch(params: VisionBatchParams): Promise<string>;
  analyzeVideoDirect?(params: VideoDirectParams): Promise<string>;
  generateText(params: TextGenerationParams): Promise<string>;
}
