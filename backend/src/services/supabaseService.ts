import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import {
  AnalyzeVideoInput,
  analyzeWithGroq,
  DetectedSegment,
} from './groqAnalyzer.js';

dotenv.config();

export interface VideoSegmentsResponse {
  videoId: string;
  analyzed: boolean;
  hasSponsors: boolean;
  source: string | null;
  analyzedAt: string | null;
  duration?: number | null;
  segments: DetectedSegment[];
  cached?: boolean;
  model?: string;
}

let supabaseClient: SupabaseClient | null = null;

// In-memory lock to deduplicate simultaneous analysis requests for the same brand-new videoId
const inFlightAnalyses = new Map<string, Promise<VideoSegmentsResponse>>();

export function getSupabaseClient(): SupabaseClient {
  if (supabaseClient) {
    return supabaseClient;
  }

  const supabaseUrl =
    process.env.SUPABASE_URL || 'https://yayhcowmesmjccjelmuf.supabase.co';
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    '';

  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY in environment'
    );
  }

  supabaseClient = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  });

  return supabaseClient;
}

/**
 * Looks up a video and its active (non-hidden) sponsor segments from Supabase.
 */
export async function getVideoSegments(
  videoId: string
): Promise<VideoSegmentsResponse> {
  const supabase = getSupabaseClient();

  const { data: video, error: videoError } = await supabase
    .from('videos')
    .select('*')
    .eq('video_id', videoId)
    .maybeSingle();

  if (videoError) {
    throw new Error(`Supabase video lookup failed: ${videoError.message}`);
  }

  if (!video) {
    return {
      videoId,
      analyzed: false,
      hasSponsors: false,
      source: null,
      analyzedAt: null,
      duration: null,
      segments: [],
    };
  }

  const { data: rows, error: segError } = await supabase
    .from('sponsor_segments')
    .select('*')
    .eq('video_id', videoId)
    .eq('is_hidden', false)
    .order('start_time', { ascending: true });

  if (segError) {
    throw new Error(`Supabase segment lookup failed: ${segError.message}`);
  }

  const segments: DetectedSegment[] = (rows || []).map((row: any) => ({
    id: row.id,
    videoId: row.video_id,
    startTime: Number(row.start_time),
    endTime: Number(row.end_time),
    sponsorName: row.sponsor_name || 'Sponsor',
    category: row.category || 'sponsor',
    confidence: Number(row.confidence ?? 0.9),
    reason: row.reason || '',
    source: video.source || 'groq_ai',
    upvotes: Number(row.upvotes ?? 0),
    downvotes: Number(row.downvotes ?? 0),
  }));

  return {
    videoId,
    analyzed: true,
    hasSponsors: Boolean(video.has_sponsors && segments.length > 0),
    source: video.source || 'groq_ai',
    analyzedAt: video.analyzed_at || null,
    duration: video.duration !== null && video.duration !== undefined ? Number(video.duration) : null,
    segments,
    cached: true,
  };
}

/**
 * Persists video analysis results (both positive and negative has_sponsors) to Supabase.
 */
export async function saveVideoAnalysis(params: {
  videoId: string;
  title?: string;
  channelName?: string;
  duration?: number;
  hasSponsors: boolean;
  source: 'groq_ai' | 'sponsorblock' | 'chapters' | 'manual';
  segments: DetectedSegment[];
}): Promise<VideoSegmentsResponse> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.rpc('save_video_analysis', {
    p_video_id: params.videoId,
    p_title: params.title ?? null,
    p_channel_name: params.channelName ?? null,
    p_duration: params.duration ?? null,
    p_has_sponsors: params.hasSponsors,
    p_source: params.source,
    p_segments: params.segments,
  });

  if (error) {
    throw new Error(`Supabase save_video_analysis RPC failed: ${error.message}`);
  }

  const savedSegments: DetectedSegment[] = Array.isArray(data?.segments)
    ? data.segments.map((s: any) => ({
        id: s.id,
        videoId: s.videoId || params.videoId,
        startTime: Number(s.startTime),
        endTime: Number(s.endTime),
        sponsorName: s.sponsorName || 'Sponsor',
        category: s.category || 'sponsor',
        confidence: Number(s.confidence ?? 0.9),
        reason: s.reason || '',
        source: params.source,
        upvotes: Number(s.upvotes ?? 0),
        downvotes: Number(s.downvotes ?? 0),
      }))
    : [];

  return {
    videoId: params.videoId,
    analyzed: true,
    hasSponsors: savedSegments.length > 0,
    source: params.source,
    analyzedAt: new Date().toISOString(),
    duration: params.duration ?? null,
    segments: savedSegments,
    cached: false,
  };
}

/**
 * Deduplicated analyze pipeline: checks Supabase cache first, coalesces concurrent requests
 * for the same videoId, runs Groq (`qwen/qwen3.8-27b`), and stores results in Supabase.
 */
export async function getOrAnalyzeVideo(
  input: AnalyzeVideoInput,
  forceRefresh = false
): Promise<VideoSegmentsResponse> {
  const videoId = input.videoId?.trim();
  if (!videoId || videoId.length < 5 || videoId.length > 32) {
    throw new Error('Invalid videoId: must be between 5 and 32 characters');
  }

  if (!forceRefresh) {
    const existing = await getVideoSegments(videoId);
    // If cached as clean (hasSponsors=false) but YouTube explicitly flagged paid promotion, re-analyze
    if (existing.analyzed && (existing.hasSponsors || !input.hasPaidPromotion)) {
      return existing;
    }
  }

  const existingPromise = inFlightAnalyses.get(videoId);
  if (existingPromise) {
    return existingPromise;
  }

  const analysisPromise = (async (): Promise<VideoSegmentsResponse> => {
    try {
      const result = await analyzeWithGroq({
        ...input,
        videoId,
      });

      // Do not poison Supabase cache as "analyzed & clean" if no transcript and no sponsor chapters existed
      if (result.hasTranscript === false && result.segments.length === 0) {
        return {
          videoId,
          analyzed: false,
          hasSponsors: false,
          source: null,
          analyzedAt: null,
          duration: input.duration ?? null,
          segments: [],
          cached: false,
          model: result.model,
        };
      }

      const saved = await saveVideoAnalysis({
        videoId,
        title: input.title,
        channelName: input.channelName,
        duration: input.duration,
        hasSponsors: result.hasSponsors,
        source: result.source,
        segments: result.segments,
      });

      return {
        ...saved,
        model: result.model,
      };
    } finally {
      inFlightAnalyses.delete(videoId);
    }
  })();

  inFlightAnalyses.set(videoId, analysisPromise);
  return analysisPromise;
}

/**
 * Records a community upvote or downvote (Undo/Bad Skip) on a segment in Supabase.
 */
export async function voteOnSegment(
  segmentId: string,
  vote: 'upvote' | 'downvote'
): Promise<{
  id: string;
  videoId: string;
  upvotes: number;
  downvotes: number;
  isHidden: boolean;
}> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.rpc('vote_segment', {
    p_segment_id: segmentId,
    p_vote: vote,
  });

  if (error) {
    throw new Error(`Supabase vote_segment failed: ${error.message}`);
  }

  return {
    id: data.id,
    videoId: data.videoId,
    upvotes: Number(data.upvotes),
    downvotes: Number(data.downvotes),
    isHidden: Boolean(data.isHidden),
  };
}
