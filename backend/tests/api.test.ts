import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';

describe('Backend Express API & Live Groq + Supabase Integration', () => {
  const testVideoId = 'test_vid_cpu_01';
  const cleanVideoId = 'test_vid_clean_02';
  const sbVideoId = 'test_vid_sb_03';
  const noCaptionsVideoId = `test_nocap_${Date.now().toString(36).slice(-6)}`;

  it('GET /api/health returns ok and nvidia/nemotron-3.5-super-vl-120b-a12b model', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.model).toBe('nvidia/nemotron-3.5-super-vl-120b-a12b');
    expect(res.body.supabaseConfigured).toBe(true);
    expect(res.body.nvidiaConfigured).toBe(true);
    expect(res.body.groqConfigured).toBe(true);
  });

  it('GET /api/segments/:videoId rejects invalid short videoId', async () => {
    const res = await request(app).get('/api/segments/abc');
    expect(res.status).toBe(400);
  });

  it('POST /api/analyze does not poison Supabase cache when both transcript and chapters are empty', async () => {
    const res = await request(app).post('/api/analyze').send({
      videoId: noCaptionsVideoId,
      title: 'Brand New Upload Without Captions Yet',
      duration: 240,
      transcript: [],
      chapters: [],
    });
    expect(res.status).toBe(200);
    expect(res.body.analyzed).toBe(false);
    expect(res.body.hasSponsors).toBe(false);
    expect(res.body.segments).toEqual([]);

    // Confirm it was NOT saved as analyzed=true in Supabase
    const lookup = await request(app).get(`/api/segments/${noCaptionsVideoId}`);
    expect(lookup.status).toBe(200);
    expect(lookup.body.analyzed).toBe(false);
  });

  it('POST /api/analyze analyzes a brand-new video via Groq (qwen/qwen3.8-27b), persists to Supabase, and auto-hides on 3 downvotes', async () => {
    const payload = {
      videoId: testVideoId,
      title: 'How Modern CPUs Execute Instructions',
      channelName: 'SiliconLab',
      duration: 420,
      description:
        'Get 83% off Surfshark VPN + 3 months free at https://surfshark.deals/siliconlab with code SILICONLAB',
      transcript: [
        {
          start: 0,
          end: 18.5,
          text: 'Today we are exploring out-of-order execution inside modern desktop processors.',
        },
        {
          start: 18.5,
          end: 45.0,
          text: 'Before we dive into the silicon pipeline, this video is sponsored by Surfshark VPN.',
        },
        {
          start: 45.0,
          end: 78.0,
          text: 'Surfshark keeps your browsing private on public Wi-Fi and lets you access region-locked content anywhere. Go to surfshark.deals/siliconlab and enter code SILICONLAB for 83% off plus 3 months free.',
        },
        {
          start: 78.0,
          end: 120.0,
          text: 'Now back to the video. Let us examine how the instruction decoder works.',
        },
      ],
      forceRefresh: true,
    };

    const analyzeRes = await request(app).post('/api/analyze').send(payload);
    expect(analyzeRes.status).toBe(200);
    expect(analyzeRes.body.videoId).toBe(testVideoId);
    expect(analyzeRes.body.analyzed).toBe(true);
    expect(analyzeRes.body.hasSponsors).toBe(true);
    expect(analyzeRes.body.model).toBe('nvidia/nemotron-3.5-super-vl-120b-a12b');
    expect(analyzeRes.body.duration).toBe(420);
    expect(Array.isArray(analyzeRes.body.segments)).toBe(true);
    expect(analyzeRes.body.segments.length).toBeGreaterThanOrEqual(1);

    const seg = analyzeRes.body.segments[0];
    expect(seg.id).toBeDefined();
    expect(seg.startTime).toBeGreaterThanOrEqual(15);
    expect(seg.startTime).toBeLessThanOrEqual(25);
    expect(seg.endTime).toBeGreaterThanOrEqual(70);
    expect(seg.endTime).toBeLessThanOrEqual(85);
    expect(seg.sponsorName.toLowerCase()).toContain('surfshark');

    // Verify fast cache lookup from Supabase via GET /api/segments/:videoId
    const getRes = await request(app).get(`/api/segments/${testVideoId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.analyzed).toBe(true);
    expect(getRes.body.cached).toBe(true);
    expect(getRes.body.duration).toBe(420);
    expect(getRes.body.segments.length).toBeGreaterThanOrEqual(1);
    expect(getRes.body.segments[0].id).toBe(seg.id);

    // Verify POST /api/analyze without forceRefresh returns cached result immediately
    const cachedAnalyzeRes = await request(app).post('/api/analyze').send({
      videoId: testVideoId,
      transcript: payload.transcript,
      forceRefresh: false,
    });
    expect(cachedAnalyzeRes.status).toBe(200);
    expect(cachedAnalyzeRes.body.cached).toBe(true);
    expect(cachedAnalyzeRes.body.segments[0].id).toBe(seg.id);

    // Verify voting RPC via POST /api/vote (1 upvote, then 3 downvotes -> auto-hidden)
    const upRes = await request(app).post('/api/vote').send({
      segmentId: seg.id,
      vote: 'upvote',
    });
    expect(upRes.status).toBe(200);
    expect(upRes.body.upvotes).toBe(1);
    expect(upRes.body.isHidden).toBe(false);

    // 3 downvotes (3 >= 3 and 3 > 1*2) should auto-hide the segment
    await request(app).post('/api/vote').send({ segmentId: seg.id, vote: 'downvote' });
    await request(app).post('/api/vote').send({ segmentId: seg.id, vote: 'downvote' });
    const down3 = await request(app).post('/api/vote').send({
      segmentId: seg.id,
      vote: 'downvote',
    });
    expect(down3.status).toBe(200);
    expect(down3.body.downvotes).toBe(3);
    expect(down3.body.isHidden).toBe(true);
  }, 45000);

  it('POST /api/analyze caches clean videos (hasSponsors: false) so they are not re-analyzed', async () => {
    const cleanPayload = {
      videoId: cleanVideoId,
      title: 'Beethoven Moonlight Sonata Pure Piano Performance',
      channelName: 'ClassicalPiano',
      duration: 360,
      description: 'Recorded live in Vienna.',
      transcript: [
        { start: 0, end: 15, text: 'Welcome to this live performance of Beethoven Moonlight Sonata.' },
        { start: 15, end: 60, text: 'Composed in 1801, this piece remains one of the most iconic piano works.' },
      ],
      forceRefresh: true,
    };

    const res = await request(app).post('/api/analyze').send(cleanPayload);
    expect(res.status).toBe(200);
    expect(res.body.analyzed).toBe(true);
    expect(res.body.hasSponsors).toBe(false);
    expect(res.body.segments).toEqual([]);

    // Subsequent lookup should return analyzed: true, hasSponsors: false
    const lookup = await request(app).get(`/api/segments/${cleanVideoId}`);
    expect(lookup.status).toBe(200);
    expect(lookup.body.analyzed).toBe(true);
    expect(lookup.body.hasSponsors).toBe(false);
    expect(lookup.body.segments).toEqual([]);
  }, 35000);

  it('POST /api/segments/sync-sponsorblock persists crowdsourced segments to Supabase', async () => {
    const syncRes = await request(app).post('/api/segments/sync-sponsorblock').send({
      videoId: sbVideoId,
      title: 'SponsorBlock Synced Video',
      duration: 500,
      segments: [
        {
          startTime: 40,
          endTime: 95,
          sponsorName: 'Sponsor (Community)',
          category: 'sponsor',
          confidence: 0.98,
        },
      ],
    });

    expect(syncRes.status).toBe(200);
    expect(syncRes.body.analyzed).toBe(true);
    expect(syncRes.body.source).toBe('sponsorblock');
    expect(syncRes.body.segments).toHaveLength(1);
    expect(syncRes.body.segments[0].startTime).toBe(40);
    expect(syncRes.body.segments[0].endTime).toBe(95);
  });

  it(
    'Live Deployed Supabase Edge Function responds to GET /api/segments/:videoId',
    async () => {
      const edgeRes = await fetch(
        `https://yayhcowmesmjccjelmuf.supabase.co/functions/v1/analyze-video/api/segments/${sbVideoId}`
      );
      expect(edgeRes.ok).toBe(true);
      const data = (await edgeRes.json()) as any;
      expect(data.videoId).toBe(sbVideoId);
      expect(data.analyzed).toBe(true);
      expect(data.hasSponsors).toBe(true);
      expect(data.segments.length).toBe(1);
    },
    15000
  );
});
