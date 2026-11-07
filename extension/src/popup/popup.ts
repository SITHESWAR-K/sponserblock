import {
  DEFAULT_SETTINGS,
  DEFAULT_STATS,
  ExtensionSettings,
  ExtensionStats,
  LOCAL_BACKEND_URL,
  SponsorSegment,
} from '../types.js';
import { formatTime } from '../content/playerOverlay.js';

function formatSavedDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

export function extractVideoIdFromTabUrl(urlStr?: string): string | null {
  if (!urlStr) return null;
  try {
    const url = new URL(urlStr);
    if (!url.hostname.includes('youtube.com')) return null;
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

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs?.[0] || null);
    });
  });
}

async function ensureContentScriptsInjected(tabId: number): Promise<boolean> {
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'ENSURE_CONTENT_SCRIPT',
      tabId,
    });
    if (res?.injected) return true;
  } catch {
    // Fall back to direct scripting API call below
  }

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

function sendTabMessage(tabId: number, payload: any): Promise<any> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
      } else {
        resolve(response || null);
      }
    });
  });
}

export function renderVideoStatus(
  tabId: number | undefined,
  state: {
    videoId: string | null;
    status: string;
    source: string | null;
    segments: SponsorSegment[];
    cueCount?: number;
    hasPaidPromotion?: boolean;
    error?: string;
  }
) {
  const badgeEl = document.getElementById('status-badge')!;
  const metaEl = document.getElementById('video-meta')!;
  const listEl = document.getElementById('segments-list')!;
  listEl.innerHTML = '';

  if (!state || !state.videoId) {
    badgeEl.textContent = 'Idle';
    badgeEl.className = 'badge badge-idle';
    metaEl.textContent = 'Open a YouTube video to detect sponsors.';
    return;
  }

  if (
    state.status === 'analyzing' ||
    state.status === 'loading' ||
    state.status === 'idle'
  ) {
    badgeEl.textContent = state.status === 'analyzing' ? 'AI Scanning' : 'Checking';
    badgeEl.className = 'badge badge-analyzing';
    metaEl.textContent =
      state.status === 'analyzing'
        ? `Scanning captions with Groq AI for video ${state.videoId}...`
        : `Checking cache & captions for video ${state.videoId}...`;
    return;
  }

  if (state.status === 'error') {
    badgeEl.textContent = 'Error';
    badgeEl.className = 'badge badge-idle';
    metaEl.textContent = state.error || 'Could not analyze video.';
    return;
  }

  badgeEl.textContent =
    state.source === 'sponsorblock'
      ? 'SponsorBlock'
      : state.source === 'chapters'
      ? 'Chapters Ready'
      : 'Groq AI Ready';
  badgeEl.className = 'badge badge-ready';

  const segments = state.segments || [];
  const cueSuffix =
    typeof state.cueCount === 'number' && state.cueCount > 0
      ? ` (${state.cueCount} cues scanned)`
      : '';

  if (segments.length === 0) {
    if (state.cueCount === 0) {
      metaEl.textContent = `Video ${state.videoId}: No captions found on this video — click ↻ Re-scan after player loads.`;
    } else {
      metaEl.textContent = `Video ${state.videoId}: No sponsor segments detected${cueSuffix}.`;
    }
    return;
  }

  metaEl.textContent = `Video ${state.videoId}: ${segments.length} sponsor segment(s) active${cueSuffix}`;

  for (const seg of segments) {
    const row = document.createElement('div');
    row.className = 'segment-item';

    const info = document.createElement('div');
    info.className = 'segment-info';

    const name = document.createElement('div');
    name.className = 'segment-name';
    name.textContent = `${seg.sponsorName || 'Sponsor'} (${Math.round(
      (seg.confidence ?? 0.9) * 100
    )}%)`;

    const time = document.createElement('div');
    time.className = 'segment-time';
    time.textContent = `${formatTime(seg.startTime)} → ${formatTime(seg.endTime)}`;

    info.appendChild(name);
    info.appendChild(time);

    const jumpBtn = document.createElement('button');
    jumpBtn.className = 'btn-small';
    jumpBtn.textContent = 'Skip To End';
    jumpBtn.addEventListener('click', () => {
      if (tabId !== undefined) {
        chrome.tabs.sendMessage(tabId, {
          type: 'SEEK_TO_TIME',
          time: seg.endTime,
        });
      }
    });

    row.appendChild(info);
    row.appendChild(jumpBtn);
    listEl.appendChild(row);
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', async () => {
    const skippedEl = document.getElementById('stat-skipped')!;
    const savedEl = document.getElementById('stat-saved')!;
    const analyzedEl = document.getElementById('stat-analyzed')!;

    const toggleAutoSkip = document.getElementById('toggle-autoskip') as HTMLInputElement;
    const toggleSbFallback = document.getElementById('toggle-sb-fallback') as HTMLInputElement;
    const toggleSelfPromo = document.getElementById('toggle-selfpromo') as HTMLInputElement;
    const inputBackendUrl = document.getElementById('input-backend-url') as HTMLInputElement;
    const btnPresetCloud = document.getElementById('btn-preset-cloud')!;
    const btnPresetLocal = document.getElementById('btn-preset-local')!;
    const btnReanalyze = document.getElementById('btn-reanalyze')!;

    let currentActiveVideoId: string | null = null;
    let pollTimer: number | null = null;

    const updateStatsUi = (stats: ExtensionStats) => {
      skippedEl.textContent = String(stats.sponsorsSkipped);
      savedEl.textContent = formatSavedDuration(stats.timeSavedSeconds);
      analyzedEl.textContent = String(stats.videosAnalyzedByAi);
    };

    chrome.storage.local.get(['settings', 'stats'], (res) => {
      const settings: ExtensionSettings = { ...DEFAULT_SETTINGS, ...(res?.settings || {}) };
      const stats: ExtensionStats = { ...DEFAULT_STATS, ...(res?.stats || {}) };

      updateStatsUi(stats);

      toggleAutoSkip.checked = settings.autoSkipEnabled;
      toggleSbFallback.checked = settings.sponsorBlockFallback;
      toggleSelfPromo.checked = settings.skipSelfPromo;
      inputBackendUrl.value = settings.backendUrl;
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes.stats?.newValue) {
        updateStatsUi({ ...DEFAULT_STATS, ...changes.stats.newValue });
      }
    });

    const saveSettings = async () => {
      const nextSettings: ExtensionSettings = {
        autoSkipEnabled: toggleAutoSkip.checked,
        sponsorBlockFallback: toggleSbFallback.checked,
        skipSelfPromo: toggleSelfPromo.checked,
        backendUrl: inputBackendUrl.value.trim() || DEFAULT_SETTINGS.backendUrl,
      };

      chrome.storage.local.set({ settings: nextSettings });
      const tab = await getActiveTab();
      if (tab?.id !== undefined) {
        sendTabMessage(tab.id, {
          type: 'SETTINGS_UPDATED',
          settings: nextSettings,
        });
      }
    };

    toggleAutoSkip.addEventListener('change', saveSettings);
    toggleSbFallback.addEventListener('change', saveSettings);
    toggleSelfPromo.addEventListener('change', saveSettings);
    inputBackendUrl.addEventListener('change', saveSettings);

    btnPresetCloud.addEventListener('click', () => {
      inputBackendUrl.value = DEFAULT_SETTINGS.backendUrl;
      saveSettings();
    });

    btnPresetLocal.addEventListener('click', () => {
      inputBackendUrl.value = LOCAL_BACKEND_URL;
      saveSettings();
    });

    const activeTab = await getActiveTab();
    const urlVideoId = extractVideoIdFromTabUrl(activeTab?.url);
    if (urlVideoId) {
      currentActiveVideoId = urlVideoId;
      renderVideoStatus(activeTab?.id, {
        videoId: urlVideoId,
        status: 'loading',
        source: null,
        segments: [],
      });
    }

    // Listen for live status broadcasts from contentScript in the active tab
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (message?.type === 'VIDEO_STATUS_CHANGED' && message.state) {
        if (
          sender?.tab?.id !== undefined &&
          activeTab?.id !== undefined &&
          sender.tab.id !== activeTab.id
        ) {
          return;
        }
        if (message.state.videoId) {
          currentActiveVideoId = message.state.videoId;
        }
        renderVideoStatus(activeTab?.id, message.state);
        if (
          pollTimer !== null &&
          message.state.status !== 'loading' &&
          message.state.status !== 'analyzing' &&
          message.state.status !== 'idle'
        ) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      }
    });

    if (activeTab?.id !== undefined && activeTab.url?.includes('youtube.com')) {
      const tabId = activeTab.id;

      const syncTabStatus = async () => {
        let response = await sendTabMessage(tabId, { type: 'GET_CURRENT_VIDEO_STATUS' });
        if (!response) {
          // Content script was not injected because the tab was already open before the extension loaded
          const injected = await ensureContentScriptsInjected(tabId);
          if (injected) {
            await new Promise((r) => setTimeout(r, 300));
            response = await sendTabMessage(tabId, { type: 'GET_CURRENT_VIDEO_STATUS' });
          }
        }

        if (response && (response.videoId || currentActiveVideoId)) {
          currentActiveVideoId = response.videoId || currentActiveVideoId;
          renderVideoStatus(tabId, {
            ...response,
            videoId: currentActiveVideoId,
          });

          if (
            (response.status === 'loading' ||
              response.status === 'analyzing' ||
              response.status === 'idle') &&
            pollTimer === null
          ) {
            pollTimer = window.setInterval(async () => {
              const latest = await sendTabMessage(tabId, { type: 'GET_CURRENT_VIDEO_STATUS' });
              if (latest) {
                currentActiveVideoId = latest.videoId || currentActiveVideoId;
                renderVideoStatus(tabId, {
                  ...latest,
                  videoId: currentActiveVideoId,
                });
                if (
                  latest.status !== 'loading' &&
                  latest.status !== 'analyzing' &&
                  latest.status !== 'idle'
                ) {
                  if (pollTimer !== null) {
                    clearInterval(pollTimer);
                    pollTimer = null;
                  }
                }
              }
            }, 900);
          }
        }
      };

      await syncTabStatus();

      btnReanalyze.addEventListener('click', async () => {
        const targetVideoId =
          currentActiveVideoId || extractVideoIdFromTabUrl(activeTab.url);
        if (!targetVideoId) {
          return;
        }
        currentActiveVideoId = targetVideoId;
        renderVideoStatus(tabId, {
          videoId: targetVideoId,
          status: 'analyzing',
          source: null,
          segments: [],
        });

        let response = await sendTabMessage(tabId, {
          type: 'FORCE_REANALYZE',
          videoId: targetVideoId,
        });
        if (!response) {
          await ensureContentScriptsInjected(tabId);
          await new Promise((r) => setTimeout(r, 300));
          response = await sendTabMessage(tabId, {
            type: 'FORCE_REANALYZE',
            videoId: targetVideoId,
          });
        }
        if (response && !response.error) {
          currentActiveVideoId = response.videoId || currentActiveVideoId;
          renderVideoStatus(tabId, response);
        } else if (response?.error) {
          renderVideoStatus(tabId, {
            videoId: targetVideoId,
            status: 'error',
            source: null,
            segments: [],
            error: response.error,
          });
        }
      });
    }
  });
}
