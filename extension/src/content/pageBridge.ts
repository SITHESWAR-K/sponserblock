import { ChapterItem, ExtractedVideoData, TranscriptCue } from '../types.js';

interface YouTubePlayerElement extends HTMLElement {
  getPlayerResponse?: () => any;
  getVideoData?: () => any;
  getDuration?: () => number;
  loadModule?: (moduleName: string) => void;
}

declare global {
  interface Window {
    ytInitialPlayerResponse?: any;
    ytInitialData?: any;
    ytcfg?: {
      get?: (key: string) => any;
      data_?: Record<string, any>;
    };
    __AI_SB_BRIDGE_INITIALIZED__?: boolean;
  }
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)));
}

export function parseJson3Events(events: any[]): TranscriptCue[] {
  if (!Array.isArray(events)) return [];
  const raw: Array<{ start: number; duration?: number; text: string }> = [];

  for (const ev of events) {
    if (typeof ev?.tStartMs !== 'number' || !Array.isArray(ev.segs)) continue;
    const text = ev.segs
      .map((s: any) => (typeof s?.utf8 === 'string' ? s.utf8 : ''))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text || /^[♪♫\s\[\]()]+$/.test(text)) continue;

    raw.push({
      start: Math.round((ev.tStartMs / 1000) * 100) / 100,
      duration:
        typeof ev.dDurationMs === 'number' && ev.dDurationMs > 0
          ? Math.round((ev.dDurationMs / 1000) * 100) / 100
          : undefined,
      text,
    });
  }

  return raw.map((cue, idx) => {
    const next = raw[idx + 1];
    const end =
      next && next.start > cue.start
        ? cue.duration
          ? Math.min(cue.start + cue.duration, next.start)
          : next.start
        : cue.start + (cue.duration ?? 3.0);
    return {
      start: cue.start,
      end: Math.round(Math.max(end, cue.start + 0.5) * 100) / 100,
      duration: cue.duration,
      text: cue.text,
    };
  });
}

export function parseXmlTimedText(xmlText: string): TranscriptCue[] {
  if (!xmlText || typeof xmlText !== 'string') return [];

  try {
    if (typeof DOMParser !== 'undefined') {
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlText, 'text/xml');
      const nodes = Array.from(doc.querySelectorAll('text, p'));
      const cues: TranscriptCue[] = [];

      for (const node of nodes) {
        const startAttr = node.getAttribute('start') ?? node.getAttribute('t');
        const durAttr = node.getAttribute('dur') ?? node.getAttribute('d');
        if (!startAttr) continue;

        const isMs = node.tagName.toLowerCase() === 'p';
        const start = isMs ? Number(startAttr) / 1000 : Number(startAttr);
        const duration = durAttr
          ? isMs
            ? Number(durAttr) / 1000
            : Number(durAttr)
          : 3.0;
        const text = decodeHtmlEntities(node.textContent || '')
          .replace(/\s+/g, ' ')
          .trim();

        if (!Number.isNaN(start) && text && !/^[♪♫\s\[\]()]+$/.test(text)) {
          cues.push({
            start: Math.round(start * 100) / 100,
            end: Math.round((start + duration) * 100) / 100,
            duration: Math.round(duration * 100) / 100,
            text,
          });
        }
      }

      if (cues.length > 0) {
        return cues;
      }
    }
  } catch {
    // Fall back to regex parser below
  }

  // Regex fallback for <text start="..." dur="...">...</text> and <p t="..." d="...">...</p>
  const cues: TranscriptCue[] = [];
  const tagRegex = /<(text|p)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(xmlText)) !== null) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    const body = match[3].replace(/<[^>]+>/g, ' ');
    const startMatch = attrs.match(/\b(?:start|t)=["']([^"']+)["']/i);
    if (!startMatch) continue;
    const durMatch = attrs.match(/\b(?:dur|d)=["']([^"']+)["']/i);

    const isMs = tag === 'p';
    const start = isMs ? Number(startMatch[1]) / 1000 : Number(startMatch[1]);
    const duration = durMatch
      ? isMs
        ? Number(durMatch[1]) / 1000
        : Number(durMatch[1])
      : 3.0;
    const text = decodeHtmlEntities(body).replace(/\s+/g, ' ').trim();

    if (!Number.isNaN(start) && text && !/^[♪♫\s\[\]()]+$/.test(text)) {
      cues.push({
        start: Math.round(start * 100) / 100,
        end: Math.round((start + duration) * 100) / 100,
        duration: Math.round(duration * 100) / 100,
        text,
      });
    }
  }

  return cues;
}

/**
 * Parses YouTube Innertube `/youtubei/v1/get_transcript` response JSON into TranscriptCue[].
 * Handles both `transcriptSegmentRenderer` and `transcriptCueRenderer` structures.
 */
export function parseInnertubeTranscript(data: any): TranscriptCue[] {
  if (!data || typeof data !== 'object') return [];
  const rawCues: TranscriptCue[] = [];

  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;

    if (node.transcriptSegmentRenderer) {
      const seg = node.transcriptSegmentRenderer;
      const startMs = Number(seg.startMs);
      const endMs = Number(seg.endMs);
      const textFromRuns = Array.isArray(seg.snippet?.runs)
        ? seg.snippet.runs.map((r: any) => (typeof r?.text === 'string' ? r.text : '')).join('')
        : typeof seg.snippet?.simpleText === 'string'
        ? seg.snippet.simpleText
        : '';
      const text = decodeHtmlEntities(textFromRuns).replace(/\s+/g, ' ').trim();

      if (!Number.isNaN(startMs) && text && !/^[♪♫\s\[\]()]+$/.test(text)) {
        const start = Math.round((startMs / 1000) * 100) / 100;
        const end =
          !Number.isNaN(endMs) && endMs > startMs
            ? Math.round((endMs / 1000) * 100) / 100
            : Math.round((start + 3.0) * 100) / 100;
        rawCues.push({
          start,
          end: Math.max(end, Math.round((start + 0.5) * 100) / 100),
          duration: Math.round(Math.max(0.5, end - start) * 100) / 100,
          text,
        });
      }
      return;
    }

    if (node.transcriptCueRenderer) {
      const cue = node.transcriptCueRenderer;
      const startMs = Number(cue.startOffsetMs);
      const durMs = Number(cue.durationMs || 3000);
      const textFromCue =
        typeof cue.cue?.simpleText === 'string'
          ? cue.cue.simpleText
          : Array.isArray(cue.cue?.runs)
          ? cue.cue.runs.map((r: any) => (typeof r?.text === 'string' ? r.text : '')).join('')
          : '';
      const text = decodeHtmlEntities(textFromCue).replace(/\s+/g, ' ').trim();

      if (!Number.isNaN(startMs) && text && !/^[♪♫\s\[\]()]+$/.test(text)) {
        const start = Math.round((startMs / 1000) * 100) / 100;
        const duration = Math.round(Math.max(0.5, durMs / 1000) * 100) / 100;
        rawCues.push({
          start,
          end: Math.round((start + duration) * 100) / 100,
          duration,
          text,
        });
      }
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) visit(item);
    } else {
      for (const key of Object.keys(node)) {
        visit(node[key]);
      }
    }
  };

  visit(data);
  rawCues.sort((a, b) => a.start - b.start);
  return rawCues;
}

/**
 * Extracts `getTranscriptEndpoint.params` from `ytInitialData` object or raw watch page HTML.
 */
export function extractTranscriptParams(source: any): string | null {
  if (!source) return null;

  if (typeof source === 'string') {
    const match = source.match(
      /"getTranscriptEndpoint"\s*:\s*\{[^}]*?"params"\s*:\s*"([^"]+)"/
    );
    return match?.[1] || null;
  }

  if (typeof source === 'object') {
    let found: string | null = null;
    const visit = (node: any) => {
      if (found || !node || typeof node !== 'object') return;
      if (
        typeof node.getTranscriptEndpoint?.params === 'string' &&
        node.getTranscriptEndpoint.params.length > 0
      ) {
        found = node.getTranscriptEndpoint.params;
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
      } else {
        for (const key of Object.keys(node)) {
          visit(node[key]);
        }
      }
    };
    visit(source);
    return found;
  }

  return null;
}

/**
 * Synthesizes base64-encoded protobuf `params` for `/youtubei/v1/get_transcript`
 * when YouTube Shorts or lazy-loaded engagement panels omit `getTranscriptEndpoint` from initial HTML.
 */
export function buildFallbackTranscriptParams(videoId: string): string | null {
  if (!videoId || typeof videoId !== 'string' || videoId.length < 5 || videoId.length > 64) {
    return null;
  }
  try {
    const inner = `\x0a${String.fromCharCode(videoId.length)}${videoId}`;
    const outer = `\x0a${String.fromCharCode(inner.length)}${inner}`;
    if (typeof btoa === 'function') {
      return btoa(outer);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Verifies that a `ytInitialData` object belongs to `targetVideoId` and is not stale
 * from a previous video or browse page during YouTube SPA navigation.
 */
export function doesInitialDataMatchVideo(
  initialData: any,
  targetVideoId?: string,
  requireExplicitEndpoint = false
): boolean {
  if (!initialData || typeof initialData !== 'object') return false;
  if (initialData?.contents?.twoColumnBrowseResultsRenderer) {
    return false;
  }
  if (!targetVideoId) {
    return !requireExplicitEndpoint;
  }

  const endpointVid =
    initialData?.currentVideoEndpoint?.watchEndpoint?.videoId ||
    initialData?.playerOverlays?.playerOverlayRenderer?.videoDetails
      ?.playerOverlayVideoDetailsRenderer?.videoId;

  if (typeof endpointVid === 'string' && endpointVid.length > 0) {
    return endpointVid === targetVideoId;
  }

  return !requireExplicitEndpoint;
}

/**
 * Layer 1 Transcript Extractor: Calls YouTube's Innertube `/youtubei/v1/get_transcript` API.
 * Does not require a Proof-of-Origin (`pot`) token.
 */
export async function fetchInnertubeTranscript(videoId: string): Promise<TranscriptCue[]> {
  try {
    let params: string | null = null;
    let clientVersion =
      window.ytcfg?.get?.('INNERTUBE_CLIENT_VERSION') ||
      window.ytcfg?.data_?.INNERTUBE_CLIENT_VERSION ||
      '2.20250312.04.00';

    // Check window.ytInitialData ONLY if it explicitly matches the current videoId
    if (
      window.ytInitialData &&
      doesInitialDataMatchVideo(window.ytInitialData, videoId, true)
    ) {
      params = extractTranscriptParams(window.ytInitialData);
    }

    // If not in window.ytInitialData (or stale from SPA navigation), fetch watch page HTML
    if (!params) {
      const watchRes = await fetch(
        `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
        { credentials: 'same-origin' }
      );
      if (watchRes.ok) {
        const html = await watchRes.text();
        params = extractTranscriptParams(html) || buildFallbackTranscriptParams(videoId);
        const verMatch = html.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/);
        if (verMatch?.[1]) {
          clientVersion = verMatch[1];
        }
      }
    }

    if (!params) return [];

    const res = await fetch(
      'https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false',
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          context: {
            client: {
              hl: 'en',
              gl: 'US',
              clientName: 'WEB',
              clientVersion,
            },
          },
          params,
        }),
      }
    );

    if (!res.ok) return [];
    const data = await res.json();
    return parseInnertubeTranscript(data);
  } catch {
    return [];
  }
}

export function parseChaptersFromDescription(
  description: string,
  duration: number
): ChapterItem[] {
  if (!description) return [];
  const lines = description.split(/\r?\n/);
  const timeRegex = /(?:^|\s)(\d{1,2}:)?(\d{1,2}):(\d{2})(?:\s|$)/;
  const rawChapters: Array<{ title: string; startTime: number }> = [];

  for (const line of lines) {
    const match = line.match(timeRegex);
    if (!match) continue;
    const hours = match[1] ? parseInt(match[1].replace(':', ''), 10) : 0;
    const mins = parseInt(match[2], 10);
    const secs = parseInt(match[3], 10);
    const startTime = hours * 3600 + mins * 60 + secs;

    const title = line
      .replace(match[0], ' ')
      .replace(/^[\s\-–—:|()\[\]]+|[\s\-–—:|()\[\]]+$/g, '')
      .trim();

    if (title.length >= 2) {
      rawChapters.push({ title, startTime });
    }
  }

  rawChapters.sort((a, b) => a.startTime - b.startTime);
  return rawChapters.map((ch, idx) => ({
    title: ch.title,
    startTime: ch.startTime,
    endTime: rawChapters[idx + 1]?.startTime ?? (duration > ch.startTime ? duration : undefined),
  }));
}

export async function resolvePlayerResponse(
  targetVideoId: string,
  maxPollAttempts = 6,
  pollIntervalMs = 250
): Promise<any> {
  for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
    const player = document.getElementById('movie_player') as YouTubePlayerElement | null;
    if (player && typeof player.getPlayerResponse === 'function') {
      const resp = player.getPlayerResponse();
      if (resp?.videoDetails?.videoId === targetVideoId) {
        const hasCaptions =
          Array.isArray(resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks) &&
          resp.captions.playerCaptionsTracklistRenderer.captionTracks.length > 0;
        if (hasCaptions || attempt >= 1) {
          return resp;
        }
      }
    }

    if (window.ytInitialPlayerResponse?.videoDetails?.videoId === targetVideoId) {
      return window.ytInitialPlayerResponse;
    }

    if (attempt < maxPollAttempts - 1 && pollIntervalMs > 0) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  // Fallback: fetch watch page HTML and parse ytInitialPlayerResponse
  try {
    const watchRes = await fetch(
      `https://www.youtube.com/watch?v=${encodeURIComponent(targetVideoId)}`,
      { credentials: 'same-origin' }
    );
    const html = await watchRes.text();
    const marker = 'ytInitialPlayerResponse = ';
    const startIdx = html.indexOf(marker);
    if (startIdx !== -1) {
      const jsonStart = html.indexOf('{', startIdx);
      let depth = 0;
      let inStr = false;
      let escaped = false;
      for (let i = jsonStart; i < html.length; i++) {
        const ch = html[i];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === '"') {
          inStr = !inStr;
          continue;
        }
        if (!inStr) {
          if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) {
              const parsed = JSON.parse(html.slice(jsonStart, i + 1));
              if (!parsed?.videoDetails?.videoId || parsed.videoDetails.videoId === targetVideoId) {
                return parsed;
              }
              break;
            }
          }
        }
      }
    }
  } catch {
    // Ignore fetch fallback errors
  }

  // Never return a stale playerResponse belonging to a different videoId
  const player = document.getElementById('movie_player') as YouTubePlayerElement | null;
  const currentResp = player?.getPlayerResponse?.();
  if (currentResp?.videoDetails?.videoId === targetVideoId) {
    return currentResp;
  }
  if (window.ytInitialPlayerResponse?.videoDetails?.videoId === targetVideoId) {
    return window.ytInitialPlayerResponse;
  }

  return null;
}

/**
 * Builds prioritized timedtext candidate URLs:
 * 1. Reuses signed `/api/timedtext` URLs (containing Proof-of-Origin `&pot=`) from PerformanceResourceTiming.
 * 2. When a track is non-English (`!languageCode.startsWith('en')`, e.g., Tamil `ta`, Hindi `hi`),
 *    prioritizes `&tlang=en` (YouTube's server-side English translation with identical timestamps)
 *    before falling back to the native-language track.
 */
export function buildTimedTextUrlsForTracks(
  captionTracks: any[],
  videoId?: string,
  signedResourceUrls: string[] = []
): string[] {
  const candidates: string[] = [];
  const addCandidate = (url: string) => {
    if (url && !candidates.includes(url)) {
      candidates.push(url);
    }
  };

  const toJson3 = (url: string) =>
    url.includes('fmt=') ? url.replace(/fmt=[^&]+/, 'fmt=json3') : `${url}&fmt=json3`;

  const withTlangEn = (url: string) =>
    url.includes('tlang=') ? url.replace(/tlang=[^&]+/, 'tlang=en') : `${url}&tlang=en`;

  // Extract any valid Proof-of-Origin token (&pot=...) from observed player timedtext requests
  let discoveredPot: string | null = null;
  for (const resUrl of signedResourceUrls) {
    if (!resUrl.includes('/api/timedtext')) continue;
    if (videoId && !resUrl.includes(`v=${videoId}`) && !resUrl.includes(`docid=${videoId}`)) {
      continue;
    }
    const potMatch = resUrl.match(/[?&]pot=([^&]+)/);
    if (potMatch?.[1]) {
      discoveredPot = potMatch[1];
    }

    const json3Signed = toJson3(resUrl);
    const langMatch = resUrl.match(/[?&]lang=([^&]+)/);
    const isNonEnglish = langMatch?.[1] && !langMatch[1].toLowerCase().startsWith('en');
    if (isNonEnglish) {
      addCandidate(withTlangEn(json3Signed));
    }
    addCandidate(json3Signed);
  }

  if (Array.isArray(captionTracks) && captionTracks.length > 0) {
    // Prefer manual English, then auto-generated English, then manual regional, then ASR regional
    const sortedTracks = [...captionTracks].sort((a, b) => {
      const aEn = String(a?.languageCode || '').toLowerCase().startsWith('en') ? 1 : 0;
      const bEn = String(b?.languageCode || '').toLowerCase().startsWith('en') ? 1 : 0;
      if (aEn !== bEn) return bEn - aEn;
      const aManual = a?.kind === 'asr' ? 0 : 1;
      const bManual = b?.kind === 'asr' ? 0 : 1;
      return bManual - aManual;
    });

    for (const track of sortedTracks.slice(0, 2)) {
      if (!track?.baseUrl) continue;
      let baseUrl = String(track.baseUrl);
      if (discoveredPot && !baseUrl.includes('pot=')) {
        baseUrl += `&pot=${discoveredPot}&c=WEB`;
      }
      const json3Url = toJson3(baseUrl);
      const langCode = String(track.languageCode || '').toLowerCase();
      const isNonEnglish = langCode.length > 0 && !langCode.startsWith('en');

      if (isNonEnglish) {
        // Request English auto-translation first for regional tracks (Tamil, Hindi, etc.), then native fallback
        addCandidate(withTlangEn(json3Url));
        addCandidate(withTlangEn(baseUrl));
      }

      addCandidate(json3Url);
      if (json3Url !== baseUrl) {
        addCandidate(baseUrl);
      }
    }
  }

  return candidates;
}

export async function fetchTranscriptFromTracks(
  captionTracks: any[],
  videoId?: string
): Promise<TranscriptCue[]> {
  let signedResourceUrls: string[] = [];
  try {
    if (typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function') {
      signedResourceUrls = performance
        .getEntriesByType('resource')
        .map((e: any) => String(e?.name || ''))
        .filter((name) => name.includes('/api/timedtext'));
    }
  } catch {
    // Ignore if performance API is unavailable
  }

  const candidateUrls = buildTimedTextUrlsForTracks(
    captionTracks,
    videoId,
    signedResourceUrls
  );

  for (const url of candidateUrls) {
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) continue;
      const rawText = await res.text();
      if (!rawText || !rawText.trim()) continue;

      if (rawText.trim().startsWith('{')) {
        try {
          const json = JSON.parse(rawText);
          const cues = parseJson3Events(json?.events || []);
          if (cues.length > 0) return cues;
        } catch {
          // Fall through to XML timedtext parser
        }
      }

      const xmlCues = parseXmlTimedText(rawText);
      if (xmlCues.length > 0) return xmlCues;
    } catch {
      // Try next candidate URL
    }
  }

  return [];
}

/**
 * Extracts full video description from playerResponse, ytInitialData, or DOM expander,
 * and checks whether YouTube's official `paidContentOverlayRenderer` flag is present.
 */
export function extractFullDescriptionAndMetadata(
  playerResponse: any,
  ytInitialData?: any,
  targetVideoId?: string
): { description: string; hasPaidPromotion: boolean } {
  const candidates: string[] = [];
  const effectiveVideoId = targetVideoId || playerResponse?.videoDetails?.videoId;

  const shortDesc = playerResponse?.videoDetails?.shortDescription;
  if (typeof shortDesc === 'string' && shortDesc.trim()) {
    candidates.push(shortDesc.trim());
  }

  const microDesc =
    playerResponse?.microformat?.playerMicroformatRenderer?.description?.simpleText;
  if (typeof microDesc === 'string' && microDesc.trim()) {
    candidates.push(microDesc.trim());
  }

  let hasPaidPromotion = Boolean(
    playerResponse?.paidContentOverlay?.paidContentOverlayRenderer
  );

  // Only traverse ytInitialData if it belongs to the target video
  if (
    ytInitialData &&
    typeof ytInitialData === 'object' &&
    doesInitialDataMatchVideo(ytInitialData, effectiveVideoId, Boolean(targetVideoId))
  ) {
    const visit = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (node.paidContentOverlayRenderer || node.paidPromotionOverlayRenderer) {
        hasPaidPromotion = true;
      }
      if (
        typeof node.attributedDescriptionBodyText?.content === 'string' &&
        node.attributedDescriptionBodyText.content.trim().length > 0
      ) {
        candidates.push(node.attributedDescriptionBodyText.content.trim());
      }
      if (
        node.videoSecondaryInfoRenderer?.description?.runs &&
        Array.isArray(node.videoSecondaryInfoRenderer.description.runs)
      ) {
        const text = node.videoSecondaryInfoRenderer.description.runs
          .map((r: any) => (typeof r?.text === 'string' ? r.text : ''))
          .join('')
          .trim();
        if (text) candidates.push(text);
      }
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
      } else {
        for (const key of Object.keys(node)) {
          visit(node[key]);
        }
      }
    };
    visit(ytInitialData);
  }

  if (typeof document !== 'undefined') {
    const domDesc =
      document.querySelector('#description-inline-expander')?.textContent?.trim() ||
      document.querySelector('ytd-watch-metadata #description')?.textContent?.trim();
    if (domDesc) {
      candidates.push(domDesc);
    }
    if (document.querySelector('.ytp-paid-content-overlay-link')) {
      hasPaidPromotion = true;
    }
  }

  // Pick the most complete description string
  candidates.sort((a, b) => b.length - a.length);
  let description = candidates[0] || '';

  // Prepend at the top so extractDescriptionHints (capped at 20 lines) never drops it on link-heavy descriptions
  if (hasPaidPromotion && !description.includes('[YouTube Paid Promotion Flag')) {
    description = `[YouTube Paid Promotion Flag: Creator marked this video as including paid promotion]\n${description}`.trim();
  }

  return { description, hasPaidPromotion };
}

export async function extractVideoData(videoId: string): Promise<ExtractedVideoData> {
  const playerResponse = await resolvePlayerResponse(videoId);
  const details = playerResponse?.videoDetails || {};
  const title =
    details.title ||
    document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent?.trim() ||
    document.title.replace(/ - YouTube$/, '');
  const channelName =
    details.author ||
    document.querySelector('#owner #channel-name a')?.textContent?.trim() ||
    'Unknown';
  const videoEl = document.querySelector('video.html5-main-video') as HTMLVideoElement | null;
  const playerEl = document.getElementById('movie_player') as YouTubePlayerElement | null;

  // Nudge YouTube player captions module so timedtext resource URLs with pot tokens are warmed up
  try {
    playerEl?.loadModule?.('captions');
  } catch {
    // Ignore if unavailable
  }

  const isAdShowing = Boolean(
    playerEl &&
      (playerEl.classList.contains('ad-showing') ||
        playerEl.classList.contains('ad-interrupting'))
  );
  const duration =
    Number(details.lengthSeconds) ||
    (!isAdShowing && videoEl && !Number.isNaN(videoEl.duration) ? Math.round(videoEl.duration) : 0);

  const { description, hasPaidPromotion } = extractFullDescriptionAndMetadata(
    playerResponse,
    window.ytInitialData,
    videoId
  );

  const captionTracks =
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

  // Layer 2 & 3: Try timedtext tracks first (including signed pot URLs and &tlang=en auto-translation for regional audio)
  let transcript = await fetchTranscriptFromTracks(captionTracks, videoId);

  // Layer 1 fallback: If timedtext returned empty (e.g. blocked by missing pot token), fetch via Innertube /youtubei/v1/get_transcript
  if (transcript.length === 0) {
    transcript = await fetchInnertubeTranscript(videoId);
  }

  const chapters = parseChaptersFromDescription(description, duration);

  return {
    videoId,
    title,
    channelName,
    duration,
    description,
    chapters,
    transcript,
    hasPaidPromotion,
  };
}

// Listen for extraction requests from ISOLATED contentScript (guarded against duplicate injection)
if (typeof window !== 'undefined' && !window.__AI_SB_BRIDGE_INITIALIZED__) {
  window.__AI_SB_BRIDGE_INITIALIZED__ = true;
  window.addEventListener('message', async (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.type !== 'AI_SB_EXTRACT_VIDEO_DATA') return;

    const { videoId, requestId } = data;
    try {
      const extracted = await extractVideoData(videoId);
      window.postMessage(
        {
          type: 'AI_SB_VIDEO_DATA_RESULT',
          requestId,
          success: true,
          payload: extracted,
        },
        '*'
      );
    } catch (err: any) {
      window.postMessage(
        {
          type: 'AI_SB_VIDEO_DATA_RESULT',
          requestId,
          success: false,
          error: err?.message || 'Failed to extract YouTube player data',
        },
        '*'
      );
    }
  });
}
