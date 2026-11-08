import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseJson3ToCues,
  estimateTokens,
  compactTranscript,
  shrinkUserPromptForRetry,
  extractDescriptionHints,
  extractBrandKeywordsFromDescription,
  detectSponsorFromChapters,
  extractJsonFromModelOutput,
  validateAndNormalizeSegments,
  callGroqWithRetry,
  YouTubeJson3Event,
} from '../src/services/groqAnalyzer.js';

describe('groqAnalyzer unit tests', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parseJson3ToCues', () => {
    it('returns empty array for empty or invalid input', () => {
      expect(parseJson3ToCues([])).toEqual([]);
      expect(parseJson3ToCues(null as any)).toEqual([]);
    });

    it('parses YouTube json3 events and filters out music-only cues', () => {
      const events: YouTubeJson3Event[] = [
        { tStartMs: 0, dDurationMs: 2500, segs: [{ utf8: '♪ ♪' }] },
        {
          tStartMs: 2500,
          dDurationMs: 4000,
          segs: [{ utf8: 'Hello ' }, { utf8: 'everyone!' }],
        },
        {
          tStartMs: 6500,
          dDurationMs: 5000,
          segs: [{ utf8: 'This video is sponsored by NordVPN.' }],
        },
      ];

      const cues = parseJson3ToCues(events);
      expect(cues).toHaveLength(2);
      expect(cues[0]).toEqual({
        start: 2.5,
        end: 6.5,
        duration: 4,
        text: 'Hello everyone!',
      });
      expect(cues[1]).toEqual({
        start: 6.5,
        end: 11.5,
        duration: 5,
        text: 'This video is sponsored by NordVPN.',
      });
    });
  });

  describe('compactTranscript', () => {
    it('returns empty string for empty cues', () => {
      expect(compactTranscript([])).toBe('');
    });

    it('merges normal cues within windowSeconds and splits immediately on sponsor transition keywords', () => {
      const cues = [
        { start: 0, end: 2.5, text: 'Welcome back to the channel.' },
        { start: 2.5, end: 5.0, text: 'Today we are building a mechanical keyboard.' },
        { start: 5.0, end: 9.0, text: 'Before we start, this video is sponsored by Squarespace.' },
        { start: 9.0, end: 13.0, text: 'Squarespace lets you build websites fast.' },
        { start: 13.0, end: 16.0, text: 'Now let us get back to the video.' },
      ];

      const compacted = compactTranscript(cues, 6);
      const lines = compacted.split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(3);
      expect(lines[0]).toContain('[0.0 - 5.0] Welcome back to the channel. Today we are building a mechanical keyboard.');
      expect(lines[1]).toContain('[5.0 -');
      expect(lines[1]).toContain('sponsored by Squarespace');
      expect(lines[lines.length - 1]).toContain('[13.0 - 16.0] Now let us get back to the video.');
    });

    it('preserves late-video sponsor transition windows on very long videos (>2 hours) without mid-line truncation', () => {
      const cues = [];
      // Generate 250 blocks of normal technical discussion across 2.5 hours
      for (let i = 0; i < 250; i++) {
        const start = i * 36;
        cues.push({
          start,
          end: start + 35,
          text: `In section ${i} we discuss distributed consensus protocols and state machine replication across nodes.`,
        });
      }

      // Inject a late-video sponsor segment at 90 minutes (5400s, index 150)
      cues[150] = {
        start: 5400,
        end: 5420,
        text: "Today's video is sponsored by Ground News, the platform that compares media bias.",
      };
      cues[151] = {
        start: 5420,
        end: 5460,
        text: 'Go to ground.news/systems and use code SYSTEMS for 40% off the Vantage plan.',
      };
      cues[152] = {
        start: 5460,
        end: 5480,
        text: 'Now back to the video and our Raft leader election walkthrough.',
      };

      const maxChars = 2500;
      const compacted = compactTranscript(cues, 6, maxChars);

      expect(compacted.length).toBeLessThanOrEqual(maxChars);
      // Must preserve the late-video sponsor read at 5400s - 5480s
      expect(compacted).toContain('sponsored by Ground News');
      expect(compacted).toContain('ground.news/systems');
      expect(compacted).toContain('Now back to the video');

      // Every line must be a complete [start - end] line (no mid-line slicing)
      for (const line of compacted.split('\n')) {
        expect(line).toMatch(/^\[\d+\.\d+ - \d+\.\d+\] .+/);
      }
    });

    it('stays strictly under the 3,800-token and 11,000-char budget on huge ASCII and non-ASCII (Tamil) transcripts', () => {
      const tamilCues = [];
      for (let i = 0; i < 300; i++) {
        const start = i * 10;
        tamilCues.push({
          start,
          end: start + 9.5,
          text: `பகுதி ${i}: இந்த காணொளியில் கணினி கட்டமைப்பு மற்றும் மென்பொருள் பொறியியல் பற்றி விரிவாக பார்க்கப் போகிறோம்.`,
        });
      }

      // Inject a native Tamil sponsor transition mid-video
      tamilCues[140] = {
        start: 1400,
        end: 1415,
        text: 'இந்த வீடியோ ஸ்பான்சர் Odoo ERP, கீழே டிஸ்கிரிப்ஷன் லிங்க் இருக்கு கூப்பன் கோட் A2D பயன்படுத்தவும்.',
      };
      tamilCues[141] = {
        start: 1415,
        end: 1430,
        text: 'இப்போது வீடியோக்குள்ள போகலாம் வாங்க.',
      };

      const compactedTamil = compactTranscript(tamilCues);
      expect(compactedTamil.length).toBeLessThanOrEqual(11000);
      expect(estimateTokens(compactedTamil)).toBeLessThanOrEqual(3800);
      expect(compactedTamil).toContain('ஸ்பான்சர் Odoo ERP');
      expect(compactedTamil).toContain('வீடியோக்குள்ள');
    });

    it('does not starve a late-video Tamil sponsor segment when multiple early blocks match transition keywords', () => {
      const tamilCues = [];
      for (let i = 0; i < 200; i++) {
        const start = i * 10;
        tamilCues.push({
          start,
          end: start + 9.5,
          text: `பகுதி ${i}: இந்த காணொளியில் கணினி கட்டமைப்பு மற்றும் மென்பொருள் பொறியியல் பற்றி விரிவாக பார்க்கப் போகிறோம்.`,
        });
      }

      // 3 early false-positive transition matches whose [-2, +8] windows (33 Tamil blocks > 5,000 tokens)
      // would exhaust the 3,800-token budget if added greedily before later core transition blocks
      tamilCues[3].text = 'வணக்கம் நண்பர்களே இப்போது வீடியோக்குள்ள போகலாம் வாங்க.';
      tamilCues[20].text = 'கீழே டிஸ்கிரிப்ஷன் லிங்க் இருக்கு அதில் பழைய காணொளியை பார்க்கலாம்.';
      tamilCues[40].text = 'இன்று ஆஃபர் மற்றும் டிஸ்கவுண்ட் விலையில் கிடைக்கும் மடிக்கணினிகள் பற்றி பேசுவோம்.';

      // Actual sponsor segment late in the video at index 150
      tamilCues[150].text = 'இந்த வீடியோ ஸ்பான்சர் NordVPN, கூப்பன் கோட் TAMIL2026 பயன்படுத்தவும்.';
      tamilCues[151].text = 'NordVPN மூலம் உங்கள் இணைய பாதுகாப்பை உறுதி செய்யுங்கள்.';
      tamilCues[152].text = 'சரி வாங்க மீண்டும் வீடியோக்குள்ள போகலாம்.';

      const compacted = compactTranscript(tamilCues);
      expect(estimateTokens(compacted)).toBeLessThanOrEqual(3800);
      expect(compacted).toContain('ஸ்பான்சர் NordVPN');
      expect(compacted).toContain('NordVPN மூலம் உங்கள் இணைய பாதுகாப்பை');
    });
  });

  describe('extractDescriptionHints', () => {
    it('extracts URLs and discount code lines while ignoring plain filler text', () => {
      const description = `
In this video we explore Linux kernel scheduling.
Get 83% off Surfshark VPN + 3 months free: https://surfshark.deals/linux (Use promo code LINUX)
Timestamps:
0:00 Intro
2:15 Kernel Architecture
Follow me on Mastodon
`;
      const hints = extractDescriptionHints(description);
      expect(hints).toHaveLength(1);
      expect(hints[0]).toContain('https://surfshark.deals/linux');
    });

    it('returns empty array for empty description', () => {
      expect(extractDescriptionHints('')).toEqual([]);
      expect(extractDescriptionHints(undefined)).toEqual([]);
    });
  });

  describe('detectSponsorFromChapters', () => {
    it('extracts explicit sponsor chapters', () => {
      const chapters = [
        { title: 'Intro', startTime: 0 },
        { title: 'Sponsor: Brilliant.org', startTime: 45 },
        { title: 'Main Topic', startTime: 110 },
      ];

      const segments = detectSponsorFromChapters(chapters, 300);
      expect(segments).toHaveLength(1);
      expect(segments[0].startTime).toBe(45);
      expect(segments[0].endTime).toBe(110);
      expect(segments[0].sponsorName).toBe('Brilliant.org');
      expect(segments[0].source).toBe('chapters');
    });
    it('extracts brand keywords from description and detects chapters matching description brands', () => {
      const desc = `
        Check out our sponsor https://surfshark.deals/tech and https://factor75.com/blurry50
        Follow me on https://twitter.com/tech and https://youtube.com/@tech
      `;
      const brands = extractBrandKeywordsFromDescription(desc);
      expect(brands).toContain('surfshark');
      expect(brands).toContain('factor');
      expect(brands).not.toContain('twitter');
      expect(brands).not.toContain('youtube');

      const chapters = [
        { title: 'Intro', startTime: 0 },
        { title: 'Surfshark', startTime: 60 },
        { title: 'Benchmarks', startTime: 125 },
      ];
      const segments = detectSponsorFromChapters(chapters, 400, desc);
      expect(segments).toHaveLength(1);
      expect(segments[0].startTime).toBe(60);
      expect(segments[0].endTime).toBe(125);
      expect(segments[0].sponsorName).toBe('Surfshark');
    });
  });

  describe('extractJsonFromModelOutput', () => {
    it('strips <think> tags and markdown fences before parsing JSON', () => {
      const raw = `<think>
The user wants sponsor segments. Looking at [15.2 - 98.4], Surfshark is promoted.
</think>
\`\`\`json
{
  "hasSponsors": true,
  "segments": [
    {
      "startTime": 15.2,
      "endTime": 98.4,
      "sponsorName": "Surfshark",
      "category": "sponsor",
      "confidence": 0.96,
      "reason": "Sponsor read"
    }
  ]
}
\`\`\``;
      const parsed = extractJsonFromModelOutput(raw);
      expect(parsed.hasSponsors).toBe(true);
      expect(parsed.segments).toHaveLength(1);
      expect(parsed.segments[0].sponsorName).toBe('Surfshark');
    });
  });

  describe('validateAndNormalizeSegments', () => {
    it('clamps timestamps to [0, duration], filters <5s segments, and merges overlapping segments', () => {
      const raw = [
        {
          startTime: -5,
          endTime: 2, // 2s after clamping to 0 -> too short (<5s), should be dropped
          sponsorName: 'ShortGlitch',
          confidence: 0.9,
        },
        {
          startTime: 30,
          endTime: 60,
          sponsorName: 'NordVPN',
          category: 'sponsor',
          confidence: 0.92,
          reason: 'Part 1',
        },
        {
          startTime: 59,
          endTime: 85,
          sponsorName: 'NordVPN',
          category: 'sponsor',
          confidence: 0.95,
          reason: 'Part 2',
        },
        {
          startTime: 250,
          endTime: 340, // exceeds duration 300 -> clamped to 300
          sponsorName: 'Merch Store',
          category: 'selfpromo',
          confidence: 0.88,
          reason: 'Outro merch plug',
        },
      ];

      const normalized = validateAndNormalizeSegments(raw, 300);
      expect(normalized).toHaveLength(2);
      expect(normalized[0].startTime).toBe(30);
      expect(normalized[0].endTime).toBe(85);
      expect(normalized[0].confidence).toBe(0.95);
      expect(normalized[1].startTime).toBe(250);
      expect(normalized[1].endTime).toBe(300);
      expect(normalized[1].category).toBe('selfpromo');
    });
  });

  describe('callGroqWithRetry', () => {
    it('retries with exponential backoff on HTTP 503 over-capacity errors and succeeds', async () => {
      let calls = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        calls++;
        if (calls < 3) {
          return new Response(
            JSON.stringify({
              error: {
                message: 'qwen/qwen3.8-27b is currently over capacity. Please try again.',
              },
            }),
            { status: 503 }
          );
        }
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '{"hasSponsors":true,"segments":[]}',
                },
              },
            ],
          }),
          { status: 200 }
        );
      });

      const res = await callGroqWithRetry({
        apiKey: 'test-key',
        primaryModel: 'qwen/qwen3.8-27b',
        systemPrompt: 'sys',
        userPrompt: 'usr',
        maxRetries: 3,
        baseDelayMs: 10,
      });

      expect(calls).toBe(3);
      expect(res.usedModel).toBe('qwen/qwen3.8-27b');
      expect(res.content).toContain('"hasSponsors":true');
    });

    it('immediately fails over from nvidia/nemotron-3.5-super-vl-120b-a12b to openai/gpt-oss-120b on HTTP 404 model_not_found without wasting retries', async () => {
      const requestedModels: string[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body || '{}'));
        requestedModels.push(body.model);

        if (body.model === 'nvidia/nemotron-3.5-super-vl-120b-a12b') {
          return new Response(
            JSON.stringify({
              error: {
                message: 'The model `nvidia/nemotron-3.5-super-vl-120b-a12b` is temporarily unavailable.',
                code: 'model_not_found',
              },
            }),
            { status: 404 }
          );
        }

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '{"hasSponsors":true,"segments":[{"startTime":45,"endTime":105,"sponsorName":"Skillshare","category":"sponsor","confidence":0.94,"reason":"Sponsor read"}]}',
                },
              },
            ],
          }),
          { status: 200 }
        );
      });

      const res = await callGroqWithRetry({
        apiKey: 'test-key',
        primaryModel: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
        systemPrompt: 'sys',
        userPrompt: 'usr',
        maxRetries: 3,
        baseDelayMs: 5,
      });

      expect(requestedModels).toEqual([
        'nvidia/nemotron-3.5-super-vl-120b-a12b',
        'openai/gpt-oss-120b',
      ]);
      expect(res.actualModel).toBe('openai/gpt-oss-120b');
      expect(res.usedModel).toBe('nvidia/nemotron-3.5-super-vl-120b-a12b');
      expect(res.content).toContain('Skillshare');
    });

    it('throws immediately on HTTP 401 unauthorized without failing over', async () => {
      let calls = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        calls++;
        return new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
          status: 401,
        });
      });

      await expect(
        callGroqWithRetry({
          apiKey: 'bad-key',
          primaryModel: 'qwen/qwen3.8-27b',
          systemPrompt: 'sys',
          userPrompt: 'usr',
          baseDelayMs: 5,
        })
      ).rejects.toThrow(/401/);
      expect(calls).toBe(1);
    });

    it('splits and preserves Tamil / Tanglish and &tlang=en auto-translated regional sponsor transitions in compactTranscript', () => {
      const cues = [
        { start: 0, end: 15, text: 'Vanakkam soldiers, today Microsoft 60,000 jobs out pathi paakapoorom.' },
        {
          start: 15,
          end: 42,
          text: 'Indha videova sponsor pannadhu Odoo ERP software, keela description la link iruku check out pannunga.',
        },
        {
          start: 42,
          end: 70,
          text: 'Use coupon code A2D2026 for 30% off your first year subscription.',
        },
        { start: 70, end: 110, text: 'Ipovae main topic kulla polam.' },
      ];

      const compacted = compactTranscript(cues, 6);
      expect(compacted).toContain('[15.0 -');
      expect(compacted).toContain('Indha videova sponsor pannadhu Odoo ERP');
      expect(compacted).toContain('coupon code A2D2026');

      // Also test &tlang=en auto-translated phrasing ("Before going into the video...", "The link is in the description...", "Now let's go into the video")
      const translatedCues = [
        { start: 0, end: 18, text: 'Today we are discussing the 60,000 tech layoffs.' },
        {
          start: 18,
          end: 48,
          text: 'Before going into the video, let us see how Odoo helps manage your business.',
        },
        {
          start: 48,
          end: 72,
          text: 'The link is in the description below, click the link to register for free.',
        },
        {
          start: 72,
          end: 105,
          text: "Now let's go into the video and check the numbers.",
        },
      ];
      const translatedCompacted = compactTranscript(translatedCues, 6);
      expect(translatedCompacted).toContain('[18.0 - 48.0] Before going into the video');
      expect(translatedCompacted).toContain('[48.0 - 72.0] The link is in the description below');
      expect(translatedCompacted).toContain("[72.0 - 105.0] Now let's go into the video");
    });

    it('automatically shrinks userPrompt and retries primaryModel on HTTP 413 Request too large (ITPM limit) before failing over', async () => {
      const requestedCalls: Array<{ model: string; userPrompt: string }> = [];

      const lines = ['Video ID: test123\nTimestamped Transcript ([start_sec - end_sec] text):'];
      for (let i = 0; i < 180; i++) {
        lines.push(`[${i * 10}.0 - ${(i + 1) * 10}.0] Regular technical discussion about distributed systems and cloud infrastructure part ${i}.`);
      }
      lines[90] = '[900.0 - 945.0] This video is sponsored by Surfshark VPN, use promo code CLOUD83 in the description.';
      lines[91] = '[945.0 - 960.0] Now let us get back to the video.';
      const oversizedPrompt = lines.join('\n');

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body || '{}'));
        const userMessage = body.messages?.[1]?.content || '';
        requestedCalls.push({ model: body.model, userPrompt: userMessage });

        if (requestedCalls.length === 1) {
          return new Response(
            JSON.stringify({
              error: {
                message:
                  'Request too large for model `qwen/qwen3.8-27b` in organization `org_01kc` service tier `on_demand` on input tokens per minute (ITPM): Limit 7000, Requested 12045, please reduce your message size and try again.',
              },
            }),
            { status: 413 }
          );
        }

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '{"hasSponsors":true,"segments":[{"startTime":900,"endTime":945,"sponsorName":"Surfshark","category":"sponsor","confidence":0.95,"reason":"Sponsor read"}]}',
                },
              },
            ],
          }),
          { status: 200 }
        );
      });

      const res = await callGroqWithRetry({
        apiKey: 'test-key',
        primaryModel: 'qwen/qwen3.8-27b',
        systemPrompt: 'sys',
        userPrompt: oversizedPrompt,
        baseDelayMs: 5,
      });

      expect(requestedCalls).toHaveLength(2);
      // Must retry primaryModel first after shrinking the prompt
      expect(requestedCalls[0].model).toBe('qwen/qwen3.8-27b');
      expect(requestedCalls[1].model).toBe('qwen/qwen3.8-27b');
      expect(requestedCalls[1].userPrompt.length).toBeLessThan(requestedCalls[0].userPrompt.length);
      expect(requestedCalls[1].userPrompt.length).toBeLessThanOrEqual(5500);
      expect(estimateTokens(requestedCalls[1].userPrompt)).toBeLessThanOrEqual(2000);
      // Must still preserve the sponsor transition window inside the shrunk prompt
      expect(requestedCalls[1].userPrompt).toContain('sponsored by Surfshark VPN');
      expect(res.actualModel).toBe('qwen/qwen3.8-27b');
      expect(res.content).toContain('Surfshark');
    });

    it('bounds non-ASCII metadata headers in shrinkUserPromptForRetry so transcript sponsor lines are not starved', () => {
      const tamilMetadata = Array.from(
        { length: 12 },
        (_, i) => `- சிறப்பு சலுகை மற்றும் தள்ளுபடி இணைப்பு எண் ${i}: https://example.com/tamil-${i}`
      ).join('\n');

      const transcriptLines = [];
      for (let i = 0; i < 40; i++) {
        transcriptLines.push(
          `[${i * 10}.0 - ${(i + 1) * 10}.0] சாதாரண தொழில்நுட்ப உரையாடல் பகுதி ${i} தொடர்கிறது.`
        );
      }
      transcriptLines[25] =
        '[250.0 - 265.0] இந்த வீடியோ ஸ்பான்சர் Skillshare, கீழே டிஸ்கிரிப்ஷன் லிங்க் இருக்கு.';

      const rawPrompt = `Video ID: tamil_meta_01
Title: தமிழ் தொழில்நுட்ப காணொளி
Description Links & Promo Hints:
${tamilMetadata}

Timestamped Transcript ([start_sec - end_sec] text):
${transcriptLines.join('\n')}`;

      const shrunk = shrinkUserPromptForRetry(rawPrompt, 3000, 1200);
      expect(shrunk.length).toBeLessThanOrEqual(3000);
      expect(estimateTokens(shrunk)).toBeLessThanOrEqual(1200);
      expect(shrunk).toContain('Timestamped Transcript ([start_sec - end_sec] text):');
      expect(shrunk).toContain('ஸ்பான்சர் Skillshare');
    });
  });
});

