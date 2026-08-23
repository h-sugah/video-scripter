export type ProfileId = 'operation' | 'seminar_education' | 'situation' | 'custom' | 'meeting';

export interface ProfileDefinition {
  id: ProfileId;
  name: string;
  description: string;
  icon: string;
  targetEventsDescription: string;
  defaultCustomPerceptionPrompt?: string;
  defaultCustomReportPrompt?: string;
}

export interface BuildPerceptionPromptParams {
  profileId: ProfileId;
  duration: number;
  batchCount: number;
  batchStartIndex: number;
  batchEndIndex: number;
  batchStartTime: number;
  batchEndTime: number;
  interval: number;
  customPrompt?: string;
}

export interface BuildDirectVideoPromptParams {
  profileId: ProfileId;
  videoName: string;
  duration: number;
  customPrompt?: string;
}

export interface BuildReportPromptParams {
  profileId: ProfileId;
  videoName: string;
  duration: number;
  events: Array<{
    time: number;
    description: string;
    type: string;
    confidence: number;
    objects?: string[];
  }>;
  customPrompt?: string;
}
