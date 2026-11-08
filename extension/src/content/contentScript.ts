import {
  DEFAULT_SETTINGS,
  ExtractedVideoData,
  ExtensionSettings,
  SponsorSegment,
} from '../types.js';
import { PlayerOverlayController } from './playerOverlay.js';

declare global {
  interface Window {
    __AI_SB_CS_INITIALIZED__?: boolean;
  }
}

export interface VideoStatusState {
  videoId: string | null;
  status: 'idle' | 'loading' | 'analyzing' | 'ready' | 'error';
  source: string | null;
  segments: SponsorSegment[];
  cueCount?: number;
  hasPaidPromotion?: boolean;
  error?: string;
}

let currentVideoId: string | null = null;
let currentVideoStatus: VideoStatusState = {
  videoId: null,
  status: 'idle',
  source: null,
  segments: [],
};

let currentSettings: ExtensionSettings = { ...DEFAULT_SETTINGS };

function setVideoStatus(next: VideoStatusState): void {
  currentVideoStatus = next;
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      const p = chrome.runtime.sendMessage({
        type: 'VIDEO_STATUS_CHANGED',
        state: currentVideoStatus,
      });
      if (p && typeof (p as Promise<any>).catch === 'function') {
        (p as Promise<any>).catch(() => {});
      }
    }
  } catch {
    // Ignore when popup is closed
  }
}

const pendingBridgeRequests = new Map<
  string,
  {
    resolve: (data: ExtractedVideoData) => void;
    reject: (err: Error) => void;
  }
>();

function onBridgeWindowMessage(event: MessageEvent): void {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.type !== 'AI_SB_VIDEO_DATA_RESULT') return;

  const pending = pendingBridgeRequests.get(data.requestId);
  if (!pending) return;
  pendingBridgeRequests.delete(data.requestId);

  if (data.success && data.payload) {
    pending.resolve(data.payload as ExtractedVideoData);
  } else {
    pending.reject(new Error(data.error || 'Failed to extract captions from page'));
  }
}

function requestVideoDataFromMainWorld(videoId: string): Promise<ExtractedVideoData> {
  return new Promise((resolve, reject) => {
    const requestId = `${videoId}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const timer = window.setTimeout(() => {
      if (pendingBridgeRequests.has(requestId)) {
        pendingBridgeRequests.delete(requestId);
        reject(new Error('Timed out waiting for YouTube player bridge'));
      }
    }, 12000);

    pendingBridgeRequests.set(requestId, {
      resolve: (data) => {
        clearTimeout(timer);
        resolve(data);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });

    window.postMessage(
      {
        type: 'AI_SB_EXTRACT_VIDEO_DATA',
        videoId,
        requestId,
      },
      '*'
    );
  });
}

const overlay = new PlayerOverlayController({
  settings: currentSettings,
  onAutoSkipRecorded: (segment) => {
    const savedSec = Math.max(0, Math.round(segment.endTime - segment.startTime));
    chrome.runtime.sendMessage({
      type: 'RECORD_SKIP_STATS',
      savedSeconds: savedSec,
      segment,
    });
  },
  onManualSkipSegment: (segment) => {
    const savedSec = Math.max(0, Math.round(segment.endTime - segment.startTime));
    chrome.runtime.sendMessage({
      type: 'RECORD_SKIP_STATS',
      savedSeconds: savedSec,
      segment,
    });
    if (segment.id) {
      chrome.runtime.sendMessage({
        type: 'VOTE_SEGMENT',
        segmentId: segment.id,
        vote: 'upvote',
      });
    }
  },
  onUndoSegment: (segment) => {
    if (segment.id) {
      chrome.runtime.sendMessage({
        type: 'VOTE_SEGMENT',
        segmentId: segment.id,
        vote: 'downvote',
      });
    }
  },
});

export function extractVideoIdFromUrl(urlStr: string): string | null {
  try {
    const url = new URL(urlStr);
    if (url.pathname === '/watch') {
      return url.searchParams.get('v');
    }
    const shortsMatch = url.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]{5,})/);
    if (shortsMatch) {
      return shortsMatch[1];
    }
    return null;
  } catch {
    return null;
  }
}

async function loadSettings(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      resolve();
      return;
    }
    chrome.storage.local.get(['settings'], (res) => {
      if (res?.settings) {
        currentSettings = { ...DEFAULT_SETTINGS, ...res.settings };
        overlay.updateSettings(currentSettings);
      }
      resolve();
    });
  });
}

let activeProcessSeq = 0;

async function processVideo(videoId: string, forceRefresh = false): Promise<void> {
  const seq = ++activeProcessSeq;
  overlay.resetForNewVideo();
  setVideoStatus({
    videoId,
    status: 'loading',
    source: null,
    segments: [],
  });

  try {
    if (!forceRefresh) {
      const domHasPaidPromo =
        typeof document !== 'undefined' &&
        Boolean(document.querySelector('.ytp-paid-content-overlay-link'));

      // Step 1: Parallel fast lookup (Supabase + SponsorBlock) in background serviceWorker
      const lookupRes = await chrome.runtime.sendMessage({
        type: 'LOOKUP_VIDEO_SEGMENTS',
        videoId,
        hasPaidPromotion: domHasPaidPromo,
      });

      if (seq !== activeProcessSeq || currentVideoId !== videoId) return;

      if (lookupRes && !lookupRes.needsAnalysis) {
        setVideoStatus({
          videoId,
          status: 'ready',
          source: lookupRes.source || 'supabase',
          segments: lookupRes.segments || [],
        });
        overlay.setSegments(lookupRes.segments || [], lookupRes.duration);
        return;
      }
    }

    // Step 2: Cache miss (brand-new video) -> Extract captions from YouTube player & run NVIDIA Nemotron / Groq AI
    setVideoStatus({
      ...currentVideoStatus,
      videoId,
      status: 'analyzing',
    });
    overlay.showStatusPill('🧠 AI Scanning Captions (Nemotron 3.5 120B)...');

    // Wait briefly for YouTube player DOM & ytInitialPlayerResponse to settle on SPA navigation
    await new Promise((r) => setTimeout(r, 600));
    if (seq !== activeProcessSeq || currentVideoId !== videoId) return;

    const extractedData = await requestVideoDataFromMainWorld(videoId);
    if (seq !== activeProcessSeq || currentVideoId !== videoId) return;

    const cueCount = Array.isArray(extractedData.transcript)
      ? extractedData.transcript.length
      : 0;

    const analyzeRes = await chrome.runtime.sendMessage({
      type: 'ANALYZE_VIDEO_CAPTIONS',
      payload: {
        ...extractedData,
        forceRefresh,
      },
    });

    if (seq !== activeProcessSeq || currentVideoId !== videoId) return;
    overlay.hideStatusPill();

    if (analyzeRes?.error) {
      setVideoStatus({
        videoId,
        status: 'error',
        source: null,
        segments: [],
        cueCount,
        hasPaidPromotion: extractedData.hasPaidPromotion,
        error: analyzeRes.error,
      });
      return;
    }

    const segments: SponsorSegment[] = analyzeRes?.segments || [];
    setVideoStatus({
      videoId,
      status: 'ready',
      source: analyzeRes?.source || 'groq_ai',
      segments,
      cueCount,
      hasPaidPromotion: extractedData.hasPaidPromotion,
    });

    overlay.setSegments(segments, extractedData.duration);
  } catch (err: any) {
    if (seq !== activeProcessSeq || currentVideoId !== videoId) return;
    overlay.hideStatusPill();
    setVideoStatus({
      videoId,
      status: 'error',
      source: null,
      segments: [],
      error: err?.message || 'Unexpected error processing video',
    });
  }
}

function handleNavigation(): void {
  const newVideoId = extractVideoIdFromUrl(window.location.href);
  if (!newVideoId) {
    activeProcessSeq++;
    currentVideoId = null;
    overlay.resetForNewVideo();
    setVideoStatus({
      videoId: null,
      status: 'idle',
      source: null,
      segments: [],
    });
    return;
  }

  if (newVideoId !== currentVideoId || currentVideoStatus.status === 'idle') {
    currentVideoId = newVideoId;
    processVideo(newVideoId, false);
  }
}

export function initContentScript(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.__AI_SB_CS_INITIALIZED__) {
    // Already initialized: ensure current URL is synchronized
    handleNavigation();
    return false;
  }
  window.__AI_SB_CS_INITIALIZED__ = true;

  // Listen for responses from pageBridge.ts (MAIN world)
  window.addEventListener('message', onBridgeWindowMessage);

  // Listen for messages from extension popup
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message.type !== 'string') return false;

      if (message.type === 'GET_CURRENT_VIDEO_STATUS') {
        const urlVid = extractVideoIdFromUrl(window.location.href);
        if (urlVid !== currentVideoId || (urlVid && currentVideoStatus.status === 'idle')) {
          handleNavigation();
        }
        sendResponse(currentVideoStatus);
        return false;
      }

      if (message.type === 'SEEK_TO_TIME' && typeof message.time === 'number') {
        const video = document.querySelector('video.html5-main-video') as HTMLVideoElement | null;
        if (video) {
          video.currentTime = message.time;
        }
        sendResponse({ ok: true });
        return false;
      }

      if (message.type === 'SETTINGS_UPDATED' && message.settings) {
        currentSettings = { ...DEFAULT_SETTINGS, ...message.settings };
        overlay.updateSettings(currentSettings);
        sendResponse({ ok: true });
        return false;
      }

      if (message.type === 'FORCE_REANALYZE') {
        const targetVideoId =
          extractVideoIdFromUrl(window.location.href) ||
          (typeof message.videoId === 'string' ? message.videoId : null) ||
          currentVideoId;
        if (targetVideoId) {
          currentVideoId = targetVideoId;
          processVideo(targetVideoId, true).then(() => {
            sendResponse(currentVideoStatus);
          });
          return true;
        }
        sendResponse({ error: 'No active YouTube video' });
        return false;
      }

      return false;
    });
  }

  (async () => {
    await loadSettings();
    handleNavigation();

    window.addEventListener('yt-navigate-finish', handleNavigation);
    window.addEventListener('popstate', handleNavigation);

    // Periodic fallback check for SPA URL transitions
    let lastHref = window.location.href;
    setInterval(() => {
      if (window.location.href !== lastHref) {
        lastHref = window.location.href;
        handleNavigation();
      }
    }, 1500);
  })();

  return true;
}

if (typeof window !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime?.id) {
  initContentScript();
}
