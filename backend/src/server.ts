import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import {
  getOrAnalyzeVideo,
  getVideoSegments,
  saveVideoAnalysis,
  voteOnSegment,
} from './services/supabaseService.js';
import {
  DEFAULT_AI_MODEL,
  validateAndNormalizeSegments,
} from './services/groqAnalyzer.js';

dotenv.config();

export const app = express();

app.use(cors());
app.use(express.json({ limit: '5mb' }));

/**
 * GET /api/health
 */
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    model:
      process.env.NVIDIA_MODEL ||
      process.env.GROQ_MODEL ||
      DEFAULT_AI_MODEL,
    supabaseConfigured: Boolean(process.env.SUPABASE_URL),
    nvidiaConfigured: Boolean(process.env.NVIDIA_API_KEY),
    groqConfigured: Boolean(process.env.GROQ_API_KEY || process.env.NVIDIA_API_KEY),
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/segments/:videoId
 * Fast lookup of analyzed video & active sponsor segments in Supabase.
 */
app.get('/api/segments/:videoId', async (req: Request, res: Response) => {
  try {
    const videoId = String(req.params.videoId || '').trim();
    if (!videoId || videoId.length < 5 || videoId.length > 32) {
      res.status(400).json({ error: 'Invalid videoId parameter' });
      return;
    }

    const result = await getVideoSegments(videoId);
    res.json(result);
  } catch (err: any) {
    console.error('[GET /api/segments/:videoId] Error:', err);
    res.status(500).json({
      error: err?.message || 'Failed to fetch segments',
    });
  }
});

/**
 * POST /api/analyze
 * Runs Groq (qwen/qwen3.8-27b) caption analysis and persists results to Supabase.
 */
app.post('/api/analyze', async (req: Request, res: Response) => {
  try {
    const {
      videoId,
      title,
      channelName,
      duration,
      description,
      chapters,
      transcript,
      json3Events,
      hasPaidPromotion,
      forceRefresh,
    } = req.body || {};

    if (!videoId || typeof videoId !== 'string' || videoId.trim().length < 5) {
      res.status(400).json({ error: 'Missing or invalid videoId in request body' });
      return;
    }

    const result = await getOrAnalyzeVideo(
      {
        videoId: videoId.trim(),
        title,
        channelName,
        duration: typeof duration === 'number' ? duration : Number(duration) || undefined,
        description,
        chapters,
        transcript,
        json3Events,
        hasPaidPromotion: Boolean(hasPaidPromotion),
      },
      Boolean(forceRefresh)
    );

    res.json(result);
  } catch (err: any) {
    console.error('[POST /api/analyze] Error:', err);
    res.status(500).json({
      error: err?.message || 'Failed to analyze video',
    });
  }
});

/**
 * POST /api/segments/sync-sponsorblock
 * Persists segments discovered from SponsorBlock into Supabase when not yet cached.
 */
app.post('/api/segments/sync-sponsorblock', async (req: Request, res: Response) => {
  try {
    const { videoId, title, channelName, duration, segments } = req.body || {};
    if (!videoId || typeof videoId !== 'string' || videoId.trim().length < 5) {
      res.status(400).json({ error: 'Missing or invalid videoId' });
      return;
    }

    const normalized = validateAndNormalizeSegments(
      Array.isArray(segments) ? segments : [],
      typeof duration === 'number' ? duration : undefined
    ).map((s) => ({ ...s, source: 'sponsorblock' as const }));

    const saved = await saveVideoAnalysis({
      videoId: videoId.trim(),
      title,
      channelName,
      duration: typeof duration === 'number' ? duration : undefined,
      hasSponsors: normalized.length > 0,
      source: 'sponsorblock',
      segments: normalized,
    });

    res.json(saved);
  } catch (err: any) {
    console.error('[POST /api/segments/sync-sponsorblock] Error:', err);
    res.status(500).json({
      error: err?.message || 'Failed to sync SponsorBlock segments',
    });
  }
});

/**
 * POST /api/vote
 * Records a community upvote or downvote (Undo/Report) on a sponsor segment.
 */
app.post('/api/vote', async (req: Request, res: Response) => {
  try {
    const { segmentId, vote } = req.body || {};
    if (!segmentId || typeof segmentId !== 'string') {
      res.status(400).json({ error: 'Missing or invalid segmentId' });
      return;
    }
    if (vote !== 'upvote' && vote !== 'downvote') {
      res.status(400).json({ error: 'Invalid vote: must be "upvote" or "downvote"' });
      return;
    }

    const updated = await voteOnSegment(segmentId, vote);
    res.json(updated);
  } catch (err: any) {
    console.error('[POST /api/vote] Error:', err);
    res.status(500).json({
      error: err?.message || 'Failed to record vote',
    });
  }
});

const isMainModule =
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` ||
  process.argv[1]?.endsWith('server.ts') ||
  process.argv[1]?.endsWith('server.js');

if (isMainModule && process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.PORT) || 3001;
  app.listen(port, () => {
    console.log(
      `⚡ AI SponsorBlock Backend listening on http://localhost:${port} (Groq Model: ${
        process.env.GROQ_MODEL || 'qwen/qwen3.8-27b'
      })`
    );
  });
}
