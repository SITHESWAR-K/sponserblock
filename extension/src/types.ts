export interface SponsorSegment {
  id?: string;
  videoId?: string;
  startTime: number;
  endTime: number;
  sponsorName: string;
  category: 'sponsor' | 'selfpromo' | 'interaction';
  confidence: number;
  reason?: string;
  source?: 'groq_ai' | 'sponsorblock' | 'chapters' | 'manual';
  upvotes?: number;
  downvotes?: number;
}

export interface TranscriptCue {
  start: number;
  end?: number;
  duration?: number;
  text: string;
}

export interface ChapterItem {
  title: string;
  startTime: number;
  endTime?: number;
}

export interface ExtractedVideoData {
  videoId: string;
  title: string;
  channelName: string;
  duration: number;
  description: string;
  chapters: ChapterItem[];
  transcript: TranscriptCue[];
  hasPaidPromotion?: boolean;
}

export interface ExtensionSettings {
  autoSkipEnabled: boolean;
  sponsorBlockFallback: boolean;
  skipSelfPromo: boolean;
  backendUrl: string;
}

export interface ExtensionStats {
  sponsorsSkipped: number;
  timeSavedSeconds: number;
  videosAnalyzedByAi: number;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  autoSkipEnabled: true,
  sponsorBlockFallback: true,
  skipSelfPromo: true,
  backendUrl: 'https://yayhcowmesmjccjelmuf.supabase.co/functions/v1/analyze-video',
};

export const LOCAL_BACKEND_URL = 'http://localhost:3001';

export const DEFAULT_STATS: ExtensionStats = {
  sponsorsSkipped: 0,
  timeSavedSeconds: 0,
  videosAnalyzedByAi: 0,
};
