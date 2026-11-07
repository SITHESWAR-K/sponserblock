import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  parseJson3Events,
  parseXmlTimedText,
  parseChaptersFromDescription,
  resolvePlayerResponse,
  parseInnertubeTranscript,
  extractTranscriptParams,
  buildFallbackTranscriptParams,
  fetchInnertubeTranscript,
  buildTimedTextUrlsForTracks,
  extractFullDescriptionAndMetadata,
} from '../../extension/src/content/pageBridge.js';
import {
  PlayerOverlayController,
  formatTime,
} from '../../extension/src/content/playerOverlay.js';
import {
  extractVideoIdFromTabUrl,
  renderVideoStatus,
} from '../../extension/src/popup/popup.js';
import { initContentScript } from '../../extension/src/content/contentScript.js';
import { DEFAULT_SETTINGS } from '../../extension/src/types.js';

// Minimal DOM shim for testing YouTube #movie_player, .ytp-progress-bar, and <video class="html5-main-video">
class MockElement {
  public tagName: string;
  public id = '';
  public className = '';
  public title = '';
  public textContent = '';
  public style: Record<string, string> = {};
  public children: MockElement[] = [];
  public parentElement: MockElement | null = null;
  public duration = 0;
  public currentTime = 0;
  public paused = false;
  public seeking = false;
  public getPlayerResponse?: () => any;
  private listeners = new Map<string, Set<Function>>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  public classList = {
    contains: (cls: string) =>
      this.className.split(/\s+/).filter(Boolean).includes(cls),
    add: (cls: string) => {
      const set = new Set(this.className.split(/\s+/).filter(Boolean));
      set.add(cls);
      this.className = Array.from(set).join(' ');
    },
    remove: (cls: string) => {
      this.className = this.className
        .split(/\s+/)
        .filter((c) => c && c !== cls)
        .join(' ');
    },
  };

  public appendChild(child: MockElement): MockElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  public remove(): void {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter(
        (c) => c !== this
      );
      this.parentElement = null;
    }
  }

  public addEventListener(type: string, fn: Function): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(fn);
  }

  public removeEventListener(type: string, fn: Function): void {
    this.listeners.get(type)?.delete(fn);
  }

  public dispatchEvent(type: string, eventObj: any = { stopPropagation: () => {} }): void {
    const fns = this.listeners.get(type);
    if (!fns) return;
    for (const fn of Array.from(fns)) {
      fn(eventObj);
    }
  }

  public matches(selector: string): boolean {
    if (selector.startsWith('#')) {
      return this.id === selector.slice(1);
    }
    if (selector.startsWith('.')) {
      const classes = selector.slice(1).split('.');
      return classes.every((c) => this.classList.contains(c));
    }
    if (selector.includes('.')) {
      const [tag, ...classes] = selector.split('.');
      return (
        this.tagName === tag.toUpperCase() &&
        classes.every((c) => this.classList.contains(c))
      );
    }
    return this.tagName === selector.toUpperCase();
  }

  public querySelectorAll(selector: string): MockElement[] {
    const results: MockElement[] = [];
    const visit = (node: MockElement) => {
      for (const child of node.children) {
        if (child.matches(selector)) {
          results.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return results;
  }

  public querySelector(selector: string): MockElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }
}

describe('Chrome Extension pageBridge & PlayerOverlayController tests', () => {
  let root: MockElement;
  let moviePlayer: MockElement;
  let progressBar: MockElement;
  let videoEl: MockElement;

  beforeEach(() => {
    root = new MockElement('body');
    moviePlayer = new MockElement('div');
    moviePlayer.id = 'movie_player';

    progressBar = new MockElement('div');
    progressBar.className = 'ytp-progress-bar';

    videoEl = new MockElement('video');
    videoEl.className = 'html5-main-video';
    videoEl.duration = 200;
    videoEl.currentTime = 0;

    moviePlayer.appendChild(progressBar);
    moviePlayer.appendChild(videoEl);
    root.appendChild(moviePlayer);

    (globalThis as any).window = globalThis;
    (globalThis as any).document = {
      createElement: (tag: string) => new MockElement(tag),
      getElementById: (id: string) => root.querySelector(`#${id}`),
      querySelector: (sel: string) => root.querySelector(sel),
      querySelectorAll: (sel: string) => root.querySelectorAll(sel),
    };
  });

  describe('pageBridge helpers', () => {
    it('parses XML timedtext with HTML entities and both <text> and <p> tags', () => {
      const xml = `<?xml version="1.0" encoding="utf-8" ?>
      <transcript>
        <text start="12.5" dur="4.2">Today&#39;s video is sponsored by Surfshark &amp; Co.</text>
        <p t="16700" d="5300">Use code &quot;LINUX&quot; at checkout.</p>
      </transcript>`;

      const cues = parseXmlTimedText(xml);
      expect(cues).toHaveLength(2);
      expect(cues[0]).toEqual({
        start: 12.5,
        end: 16.7,
        duration: 4.2,
        text: "Today's video is sponsored by Surfshark & Co.",
      });
      expect(cues[1]).toEqual({
        start: 16.7,
        end: 22,
        duration: 5.3,
        text: 'Use code "LINUX" at checkout.',
      });
    });

    it('parses chapters from YouTube video description', () => {
      const desc = `
0:00 Intro
1:15 Sponsor - NordVPN
2:30 Main Benchmarks
      `;
      const chapters = parseChaptersFromDescription(desc, 600);
      expect(chapters).toHaveLength(3);
      expect(chapters[1]).toEqual({
        title: 'Sponsor - NordVPN',
        startTime: 75,
        endTime: 150,
      });
    });

    it('resolvePlayerResponse never returns a stale playerResponse from a previous videoId on SPA navigation', async () => {
      // Simulate #movie_player still holding old video "vid_OLD" when navigating to "vid_NEW"
      moviePlayer.getPlayerResponse = () => ({
        videoDetails: { videoId: 'vid_OLD', title: 'Old Video' },
      });
      (globalThis as any).window.ytInitialPlayerResponse = {
        videoDetails: { videoId: 'vid_OLD', title: 'Old Video' },
      };
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network offline'));

      const resp = await resolvePlayerResponse('vid_NEW', 2, 5);
      expect(resp).toBeNull();
    });

    it('parseInnertubeTranscript parses nested transcriptSegmentRenderer and transcriptCueRenderer items', () => {
      const mockInnertubeResponse = {
        actions: [
          {
            updateEngagementPanelAction: {
              content: {
                transcriptRenderer: {
                  content: {
                    transcriptSearchPanelRenderer: {
                      body: {
                        transcriptSegmentListRenderer: {
                          initialSegments: [
                            {
                              transcriptSegmentRenderer: {
                                startMs: '0',
                                endMs: '18500',
                                snippet: {
                                  runs: [
                                    { text: 'Welcome to A2D Channel — ' },
                                    { text: 'Microsoft 60,000 Jobs Out analysis.' },
                                  ],
                                },
                              },
                            },
                            {
                              transcriptSegmentRenderer: {
                                startMs: '18500',
                                endMs: '62000',
                                snippet: {
                                  runs: [
                                    {
                                      text: 'Before we start, this video is sponsored by Odoo ERP &amp; CRM.',
                                    },
                                  ],
                                },
                              },
                            },
                            {
                              transcriptCueRenderer: {
                                startOffsetMs: '62000',
                                durationMs: '15000',
                                cue: {
                                  simpleText: 'Check the link in the description below!',
                                },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      };

      const cues = parseInnertubeTranscript(mockInnertubeResponse);
      expect(cues).toHaveLength(3);
      expect(cues[0]).toEqual({
        start: 0,
        end: 18.5,
        duration: 18.5,
        text: 'Welcome to A2D Channel — Microsoft 60,000 Jobs Out analysis.',
      });
      expect(cues[1]).toEqual({
        start: 18.5,
        end: 62,
        duration: 43.5,
        text: 'Before we start, this video is sponsored by Odoo ERP & CRM.',
      });
      expect(cues[2]).toEqual({
        start: 62,
        end: 77,
        duration: 15,
        text: 'Check the link in the description below!',
      });
    });

    it('extractTranscriptParams and fetchInnertubeTranscript extract params from ytInitialData and fetch Innertube transcript', async () => {
      (globalThis as any).window.ytInitialData = {
        currentVideoEndpoint: { watchEndpoint: { videoId: 'a2d_ms_60k' } },
        engagementPanels: [
          {
            engagementPanelSectionListRenderer: {
              content: {
                continuationItemRenderer: {
                  continuationEndpoint: {
                    getTranscriptEndpoint: {
                      params: 'CgthMmRfbXNfNjBrEgAuto==',
                    },
                  },
                },
              },
            },
          },
        ],
      };

      expect(extractTranscriptParams((globalThis as any).window.ytInitialData)).toBe(
        'CgthMmRfbXNfNjBrEgAuto=='
      );

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            actions: [
              {
                transcriptSegmentRenderer: {
                  startMs: '12000',
                  endMs: '48000',
                  snippet: { runs: [{ text: 'Sponsored by Skillshare.' }] },
                },
              },
            ],
          }),
          { status: 200 }
        )
      );

      const cues = await fetchInnertubeTranscript('a2d_ms_60k');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0]).toContain('/youtubei/v1/get_transcript');
      expect(cues).toHaveLength(1);
      expect(cues[0].text).toBe('Sponsored by Skillshare.');
    });

    it('buildTimedTextUrlsForTracks reuses &pot= tokens and prioritizes &tlang=en for non-English (Tamil ta) tracks', () => {
      const tamilTracks = [
        {
          baseUrl: 'https://www.youtube.com/api/timedtext?v=a2d_vid_1&lang=ta&kind=asr',
          languageCode: 'ta',
          kind: 'asr',
        },
      ];
      const signedResourceUrls = [
        'https://www.youtube.com/api/timedtext?v=a2d_vid_1&lang=ta&kind=asr&pot=Mls123TokenXYZ&fmt=srv3',
      ];

      const urls = buildTimedTextUrlsForTracks(
        tamilTracks,
        'a2d_vid_1',
        signedResourceUrls
      );

      expect(urls.length).toBeGreaterThanOrEqual(2);
      // First candidate must include both &pot=Mls123TokenXYZ and &tlang=en and fmt=json3
      expect(urls[0]).toContain('pot=Mls123TokenXYZ');
      expect(urls[0]).toContain('tlang=en');
      expect(urls[0]).toContain('fmt=json3');
      // Native Tamil fallback without tlang=en must also be present
      expect(urls.some((u) => !u.includes('tlang=en') && u.includes('lang=ta'))).toBe(true);
    });

    it('extractFullDescriptionAndMetadata extracts full description from ytInitialData and detects paidPromotionOverlayRenderer', () => {
      const playerResponse = {
        videoDetails: {
          shortDescription: 'Short truncated text...',
        },
      };
      const ytInitialData = {
        contents: {
          twoColumnWatchNextResults: {
            results: {
              results: {
                contents: [
                  {
                    videoSecondaryInfoRenderer: {
                      attributedDescriptionBodyText: {
                        content:
                          'Full expanded description! Check out our sponsor https://odoo.com/r/a2d and use code A2D for 20% off.',
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        playerOverlays: {
          playerOverlayRenderer: {
            paidContentOverlay: {
              paidPromotionOverlayRenderer: {
                text: { simpleText: 'Includes paid promotion' },
              },
            },
          },
        },
      };

      const meta = extractFullDescriptionAndMetadata(playerResponse, ytInitialData);
      expect(meta.hasPaidPromotion).toBe(true);
      expect(meta.description).toContain('https://odoo.com/r/a2d');
      expect(meta.description).toContain('[YouTube Paid Promotion Flag');
    });

    it('extractVideoIdFromTabUrl parses /watch?v= and /shorts/ URLs and initContentScript is idempotent', () => {
      expect(
        extractVideoIdFromTabUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12s')
      ).toBe('dQw4w9WgXcQ');
      expect(
        extractVideoIdFromTabUrl('https://www.youtube.com/shorts/abcDEF12345')
      ).toBe('abcDEF12345');
      expect(extractVideoIdFromTabUrl('https://www.youtube.com/feed/subscriptions')).toBeNull();

      // Test contentScript idempotency guard (window.__AI_SB_CS_INITIALIZED__)
      delete (globalThis as any).window.__AI_SB_CS_INITIALIZED__;
      (globalThis as any).window.location = {
        href: 'https://www.youtube.com/',
      };
      (globalThis as any).window.addEventListener = vi.fn();

      const firstInit = initContentScript();
      const secondInit = initContentScript();

      expect(firstInit).toBe(true);
      expect(secondInit).toBe(false);
      expect((globalThis as any).window.__AI_SB_CS_INITIALIZED__).toBe(true);
    });

    it('ignores stale ytInitialData from a previous video across SPA navigation in extractFullDescriptionAndMetadata and fetchInnertubeTranscript', async () => {
      const staleYtInitialData = {
        currentVideoEndpoint: { watchEndpoint: { videoId: 'vid_OLD' } },
        contents: {
          twoColumnWatchNextResults: {
            attributedDescriptionBodyText: {
              content:
                'Very long stale description from vid_OLD with sponsor link https://old-sponsor.com/deal that must not leak into vid_NEW!',
            },
          },
        },
        playerOverlays: {
          paidPromotionOverlayRenderer: {
            text: { simpleText: 'Includes paid promotion' },
          },
        },
      };

      const newPlayerResponse = {
        videoDetails: {
          videoId: 'vid_NEW',
          shortDescription: 'Clean short description for vid_NEW.',
        },
      };

      const meta = extractFullDescriptionAndMetadata(
        newPlayerResponse,
        staleYtInitialData,
        'vid_NEW'
      );
      expect(meta.hasPaidPromotion).toBe(false);
      expect(meta.description).toBe('Clean short description for vid_NEW.');
      expect(meta.description).not.toContain('old-sponsor.com');

      // Also verify extractTranscriptParams handles clickTrackingParams before params, and Shorts fallback params
      const htmlWithClickTracking =
        '{"getTranscriptEndpoint":{"clickTrackingParams":"CAEQ8I","params":"CgthMmRfbXNfNjBrEgAuto=="}}';
      expect(extractTranscriptParams(htmlWithClickTracking)).toBe(
        'CgthMmRfbXNfNjBrEgAuto=='
      );
      expect(buildFallbackTranscriptParams('dQw4w9WgXcQ')).toBe('Cg0KC2RRdzR3OVdnWGNR');
    });

    it('renderVideoStatus treats status="idle" with a known videoId as "Checking" instead of falsely showing "Groq AI Ready"', () => {
      const badgeEl = new MockElement('span');
      badgeEl.id = 'status-badge';
      const metaEl = new MockElement('p');
      metaEl.id = 'video-meta';
      const listEl = new MockElement('div');
      listEl.id = 'segments-list';
      root.appendChild(badgeEl);
      root.appendChild(metaEl);
      root.appendChild(listEl);

      renderVideoStatus(1, {
        videoId: 'a2d_ms_60k',
        status: 'idle',
        source: null,
        segments: [],
      });

      expect(badgeEl.textContent).toBe('Checking');
      expect(badgeEl.className).toContain('badge-analyzing');
      expect(metaEl.textContent).toContain('Checking cache & captions for video a2d_ms_60k');

      renderVideoStatus(1, {
        videoId: 'a2d_ms_60k',
        status: 'ready',
        source: 'groq_ai',
        segments: [],
        cueCount: 0,
      });

      expect(badgeEl.textContent).toBe('Groq AI Ready');
      expect(metaEl.textContent).toContain('No captions found on this video');
    });
  });

  describe('PlayerOverlayController DOM behavior', () => {
    it('renders progress bar markers, auto-skips high-confidence segments, and handles Undo & Report', () => {
      const onUndo = vi.fn();
      const onManual = vi.fn();
      const onAutoSkip = vi.fn();

      const controller = new PlayerOverlayController({
        settings: { ...DEFAULT_SETTINGS },
        onUndoSegment: onUndo,
        onManualSkipSegment: onManual,
        onAutoSkipRecorded: onAutoSkip,
      });

      const segment = {
        id: 'seg-1',
        videoId: 'vid-1',
        startTime: 20,
        endTime: 60,
        sponsorName: 'Surfshark',
        category: 'sponsor' as const,
        confidence: 0.95,
      };

      controller.setSegments([segment], 200);

      // Verify marker rendered on .ytp-progress-bar at 10% left, 20% width
      const markers = progressBar.querySelectorAll('.ai-sb-segment-marker');
      expect(markers).toHaveLength(1);
      expect(markers[0].style.left).toBe('10%');
      expect(markers[0].style.width).toBe('20%');

      // Simulate playback entering sponsor segment at 21s
      videoEl.currentTime = 21;
      videoEl.dispatchEvent('timeupdate');

      expect(videoEl.currentTime).toBe(60);
      expect(onAutoSkip).toHaveBeenCalledWith(segment);

      // Verify toast is displayed with Undo & Report button
      const toasts = moviePlayer.querySelectorAll('.ai-sb-toast');
      expect(toasts).toHaveLength(1);
      const buttons = toasts[0].querySelectorAll('.ai-sb-toast-btn');
      expect(buttons).toHaveLength(1);

      // Click Undo & Report -> should rewind to 20s and call onUndo
      buttons[0].dispatchEvent('click');
      expect(videoEl.currentTime).toBe(20);
      expect(onUndo).toHaveBeenCalledWith(segment);
    });

    it('does NOT auto-skip or overwrite duration while a YouTube ad (.ad-showing) is playing', () => {
      const onAutoSkip = vi.fn();
      const controller = new PlayerOverlayController({
        settings: { ...DEFAULT_SETTINGS },
        onUndoSegment: () => {},
        onManualSkipSegment: () => {},
        onAutoSkipRecorded: onAutoSkip,
      });

      controller.setSegments(
        [
          {
            id: 'seg-ad-test',
            startTime: 5,
            endTime: 35,
            sponsorName: 'Squarespace',
            category: 'sponsor',
            confidence: 0.95,
          },
        ],
        300
      );

      // Simulate a 15-second YouTube pre-roll ad interrupting #movie_player
      moviePlayer.classList.add('ad-showing');
      videoEl.duration = 15;
      videoEl.dispatchEvent('loadedmetadata');

      // Marker should still be positioned relative to 300s main video, NOT 15s ad
      const markers = progressBar.querySelectorAll('.ai-sb-segment-marker');
      expect(markers[0].style.width).toBe('10%');

      // Playback at 6s during the ad must NOT trigger a sponsor skip
      videoEl.currentTime = 6;
      videoEl.dispatchEvent('timeupdate');
      expect(videoEl.currentTime).toBe(6);
      expect(onAutoSkip).not.toHaveBeenCalled();

      // Once ad finishes (.ad-showing removed), playback at 6s DOES skip to 35s
      moviePlayer.classList.remove('ad-showing');
      videoEl.dispatchEvent('timeupdate');
      expect(videoEl.currentTime).toBe(35);
      expect(onAutoSkip).toHaveBeenCalledTimes(1);
    });

    it('resets videoDuration across SPA navigation so cached videos use their own duration', () => {
      const controller = new PlayerOverlayController({
        settings: { ...DEFAULT_SETTINGS },
        onUndoSegment: () => {},
        onManualSkipSegment: () => {},
        onAutoSkipRecorded: () => {},
      });

      // Video 1 has duration 600s
      controller.setSegments(
        [{ startTime: 60, endTime: 120, sponsorName: 'A', category: 'sponsor', confidence: 0.9 }],
        600
      );
      expect(progressBar.querySelectorAll('.ai-sb-segment-marker')[0].style.left).toBe('10%');

      // Navigate to Video 2 (videoEl.duration is 200s, setSegments called without explicit duration)
      controller.resetForNewVideo();
      videoEl.duration = 200;
      controller.setSegments([
        { startTime: 50, endTime: 100, sponsorName: 'B', category: 'sponsor', confidence: 0.9 },
      ]);

      // 50s / 200s = 25% (not 50s / 600s = 8.33%)
      expect(progressBar.querySelectorAll('.ai-sb-segment-marker')[0].style.left).toBe('25%');
    });
  });
});
