import {
  DEFAULT_SETTINGS,
  DEFAULT_STATS,
  ExtensionSettings,
  ExtensionStats,
  SponsorSegment,
} from '../types.js';

const CLOUD_EDGE_URL =
  'https://yayhcowmesmjccjelmuf.supabase.co/functions/v1/analyze-video';

async function getSettings(): Promise<ExtensionSettings> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['settings'], (res) => {
      resolve({ ...DEFAULT_SETTINGS, ...(res?.settings || {}) });
    });
  });
}

async function getStats(): Promise<ExtensionStats> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['stats'], (res) => {
      resolve({ ...DEFAULT_STATS, ...(res?.stats || {}) });
    });
  });
}

async function updateStats(updater: (prev: ExtensionStats) => ExtensionStats): Promise<void> {
  const prev = await getStats();
  const next = updater(prev);
  return new Promise((resolve) => {
    chrome.storage.local.set({ stats: next }, () => resolve());
  });
}

/**
 * Calls the configured backend URL and automatically falls back to the deployed
 * Supabase Edge Function if a local dev server is unreachable.
 */
async function fetchBackendJson(path: string, init?: RequestInit): Promise<any> {
  const settings = await getSettings();
  const primaryBase = (settings.backendUrl || CLOUD_EDGE_URL).replace(/\/+$/, '');

  const tryFetch = async (baseUrl: string) => {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return res.json();
  };

  try {
    return await tryFetch(primaryBase);
  } catch (err) {
    if (primaryBase !== CLOUD_EDGE_URL) {
      return await tryFetch(CLOUD_EDGE_URL);
    }
    throw err;
  }
}

async function fetchSponsorBlockSegments(videoId: string): Promise<SponsorSegment[]> {
  try {
    const categories = encodeURIComponent(JSON.stringify(['sponsor', 'selfpromo']));
    const url = `https://sponsorblock.ajay.app/api/skipSegments?videoID=${encodeURIComponent(
      videoId
    )}&categories=${categories}`;

    const res = await fetch(url);
    if (!res.ok) {
      return [];
    }

    const data = await res.json();
    if (!Array.isArray(data)) return [];

    return data
      .filter(
        (item: any) =>
          Array.isArray(item?.segment) &&
          item.segment.length === 2 &&
          Number(item.segment[1]) - Number(item.segment[0]) >= 5
      )
      .map((item: any) => ({
        videoId,
        startTime: Math.round(Number(item.segment[0]) * 100) / 100,
        endTime: Math.round(Number(item.segment[1]) * 100) / 100,
        sponsorName:
          item.category === 'selfpromo' ? 'Self Promotion' : 'Sponsor (Community)',
        category: item.category === 'selfpromo' ? 'selfpromo' : 'sponsor',
        confidence: 0.98,
        reason: 'Crowdsourced from SponsorBlock',
        source: 'sponsorblock' as const,
      }));
  } catch {
    return [];
  }
}

async function handleLookupVideoSegments(videoId: string, hasPaidPromotion = false) {
  const settings = await getSettings();

  const [supabaseOutcome, sbOutcome] = await Promise.allSettled([
    fetchBackendJson(`/api/segments/${encodeURIComponent(videoId)}`, { method: 'GET' }),
    settings.sponsorBlockFallback
      ? fetchSponsorBlockSegments(videoId)
      : Promise.resolve([]),
  ]);

  const supabaseData =
    supabaseOutcome.status === 'fulfilled' ? supabaseOutcome.value : null;
  const sbSegments =
    sbOutcome.status === 'fulfilled' ? sbOutcome.value : [];

  // 1. If Supabase has already analyzed this video AND found segments, return them
  if (supabaseData?.analyzed && Array.isArray(supabaseData.segments) && supabaseData.segments.length > 0) {
    return {
      needsAnalysis: false,
      source: supabaseData.source || 'groq_ai',
      duration: typeof supabaseData.duration === 'number' ? supabaseData.duration : undefined,
      segments: supabaseData.segments,
    };
  }

  // 2. If SponsorBlock has segments, return them immediately and cache them in Supabase
  if (sbSegments.length > 0) {
    // Fire-and-forget sync to Supabase so future lookups hit Supabase directly
    if (!supabaseData?.analyzed) {
      fetchBackendJson('/api/segments/sync-sponsorblock', {
        method: 'POST',
        body: JSON.stringify({
          videoId,
          segments: sbSegments,
        }),
      }).catch(() => {});
    }

    return {
      needsAnalysis: false,
      source: 'sponsorblock',
      duration: typeof supabaseData?.duration === 'number' ? supabaseData.duration : undefined,
      segments: sbSegments,
    };
  }

  // 3. If Supabase already analyzed this video and confirmed it has NO sponsors, don't re-analyze
  //    UNLESS YouTube explicitly flagged paid promotion on this video (preventing false-negative lock-in)
  if (supabaseData?.analyzed && supabaseData.hasSponsors === false && !hasPaidPromotion) {
    return {
      needsAnalysis: false,
      source: supabaseData.source || 'groq_ai',
      duration: typeof supabaseData.duration === 'number' ? supabaseData.duration : undefined,
      segments: [],
    };
  }

  // 4. Cache miss on both Supabase and SponsorBlock -> trigger caption analysis
  return {
    needsAnalysis: true,
    segments: [],
  };
}

async function injectScriptsIntoTab(tabId: number): Promise<boolean> {
  if (!chrome.scripting) return false;
  try {
    await chrome.scripting
      .insertCSS({
        target: { tabId },
        files: ['playerOverlay.css'],
      })
      .catch(() => {});

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['pageBridge.js'],
      world: 'MAIN' as any,
    });

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['contentScript.js'],
      world: 'ISOLATED' as any,
    });
    return true;
  } catch {
    return false;
  }
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.tabs?.query({ url: ['*://*.youtube.com/*'] }, (tabs) => {
      for (const tab of tabs || []) {
        if (typeof tab.id === 'number') {
          injectScriptsIntoTab(tab.id).catch(() => {});
        }
      }
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'ENSURE_CONTENT_SCRIPT') {
    const tabId =
      typeof message.tabId === 'number'
        ? message.tabId
        : typeof sender?.tab?.id === 'number'
        ? sender.tab.id
        : undefined;
    if (tabId === undefined) {
      sendResponse({ injected: false, error: 'Missing tabId' });
      return false;
    }
    injectScriptsIntoTab(tabId)
      .then((injected) => sendResponse({ injected }))
      .catch((err) => sendResponse({ injected: false, error: err?.message }));
    return true;
  }

  if (message.type === 'LOOKUP_VIDEO_SEGMENTS') {
    handleLookupVideoSegments(message.videoId, Boolean(message.hasPaidPromotion))
      .then((res) => sendResponse(res))
      .catch((err) =>
        sendResponse({
          needsAnalysis: true,
          segments: [],
          error: err?.message,
        })
      );
    return true;
  }

  if (message.type === 'ANALYZE_VIDEO_CAPTIONS') {
    const payload = message.payload || {};
    fetchBackendJson('/api/analyze', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
      .then(async (res) => {
        await updateStats((prev) => ({
          ...prev,
          videosAnalyzedByAi: prev.videosAnalyzedByAi + 1,
        }));
        sendResponse(res);
      })
      .catch((err) => {
        sendResponse({
          error: err?.message || 'Groq AI analysis request failed',
          segments: [],
        });
      });
    return true;
  }

  if (message.type === 'VOTE_SEGMENT') {
    fetchBackendJson('/api/vote', {
      method: 'POST',
      body: JSON.stringify({
        segmentId: message.segmentId,
        vote: message.vote,
      }),
    })
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ error: err?.message }));
    return true;
  }

  if (message.type === 'RECORD_SKIP_STATS') {
    const saved = Math.max(0, Number(message.savedSeconds) || 0);
    updateStats((prev) => ({
      ...prev,
      sponsorsSkipped: prev.sponsorsSkipped + 1,
      timeSavedSeconds: prev.timeSavedSeconds + saved,
    })).then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});
