import { ExtensionSettings, SponsorSegment } from '../types.js';

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export class PlayerOverlayController {
  private segments: SponsorSegment[] = [];
  private settings: ExtensionSettings;
  private videoDuration = 0;
  private dismissedSegmentKeys = new Set<string>();
  private lastSkipTimestamp = 0;
  private activeToastEl: HTMLElement | null = null;
  private activeToastTimer: number | null = null;
  private statusPillEl: HTMLElement | null = null;
  private timeUpdateCleanup: (() => void) | null = null;
  private mountRetryTimer: number | null = null;
  private onUndoSegment: (segment: SponsorSegment) => void;
  private onManualSkipSegment: (segment: SponsorSegment) => void;
  private onAutoSkipRecorded: (segment: SponsorSegment) => void;

  constructor(params: {
    settings: ExtensionSettings;
    onUndoSegment: (segment: SponsorSegment) => void;
    onManualSkipSegment: (segment: SponsorSegment) => void;
    onAutoSkipRecorded: (segment: SponsorSegment) => void;
  }) {
    this.settings = params.settings;
    this.onUndoSegment = params.onUndoSegment;
    this.onManualSkipSegment = params.onManualSkipSegment;
    this.onAutoSkipRecorded = params.onAutoSkipRecorded;
  }

  public updateSettings(settings: ExtensionSettings): void {
    this.settings = settings;
    this.renderMarkers();
  }

  public resetForNewVideo(): void {
    this.segments = [];
    this.videoDuration = 0;
    this.dismissedSegmentKeys.clear();
    if (this.mountRetryTimer !== null) {
      clearTimeout(this.mountRetryTimer);
      this.mountRetryTimer = null;
    }
    if (this.timeUpdateCleanup) {
      this.timeUpdateCleanup();
      this.timeUpdateCleanup = null;
    }
    this.clearMarkers();
    this.hideToast();
    this.hideStatusPill();
  }

  private isAdPlaying(): boolean {
    const player = document.getElementById('movie_player');
    if (!player) return false;
    return (
      player.classList.contains('ad-showing') ||
      player.classList.contains('ad-interrupting')
    );
  }

  public showStatusPill(text: string): void {
    const player = document.getElementById('movie_player');
    if (!player) return;

    this.hideStatusPill();
    const pill = document.createElement('div');
    pill.className = 'ai-sb-status-pill';
    pill.textContent = text;
    player.appendChild(pill);
    this.statusPillEl = pill;
  }

  public hideStatusPill(): void {
    if (this.statusPillEl) {
      this.statusPillEl.remove();
      this.statusPillEl = null;
    }
  }

  public setSegments(segments: SponsorSegment[], duration?: number): void {
    this.segments = Array.isArray(segments) ? segments : [];
    if (typeof duration === 'number' && !Number.isNaN(duration) && duration > 0) {
      this.videoDuration = duration;
    }
    this.mountWithRetry(0);
  }

  private mountWithRetry(attempt: number): void {
    if (this.mountRetryTimer !== null) {
      clearTimeout(this.mountRetryTimer);
      this.mountRetryTimer = null;
    }

    const rendered = this.renderMarkers();
    const attached = this.attachVideoListener();

    if ((!rendered || !attached) && this.segments.length > 0 && attempt < 10) {
      this.mountRetryTimer = window.setTimeout(() => {
        this.mountWithRetry(attempt + 1);
      }, 400);
    }
  }

  public renderMarkers(): boolean {
    this.clearMarkers();
    if (this.segments.length === 0) return true;

    const progressBar = document.querySelector('.ytp-progress-bar') as HTMLElement | null;
    const video = document.querySelector('video.html5-main-video') as HTMLVideoElement | null;
    if (!progressBar) return false;

    const liveVideoDuration =
      !this.isAdPlaying() && video && !Number.isNaN(video.duration) && video.duration > 0
        ? video.duration
        : 0;

    const totalDuration =
      this.videoDuration > 0 ? this.videoDuration : liveVideoDuration;

    if (totalDuration <= 0) return false;

    const container = document.createElement('div');
    container.className = 'ai-sb-markers-container';

    for (const seg of this.segments) {
      if (seg.category === 'selfpromo' && !this.settings.skipSelfPromo) {
        continue;
      }

      const leftPct = Math.max(0, Math.min(100, (seg.startTime / totalDuration) * 100));
      const widthPct = Math.max(
        0.5,
        Math.min(100 - leftPct, ((seg.endTime - seg.startTime) / totalDuration) * 100)
      );

      const marker = document.createElement('div');
      marker.className = `ai-sb-segment-marker ai-sb-category-${seg.category || 'sponsor'}`;
      marker.style.left = `${leftPct}%`;
      marker.style.width = `${widthPct}%`;
      marker.title = `${seg.sponsorName || 'Sponsor'} (${formatTime(seg.startTime)} – ${formatTime(seg.endTime)})`;

      container.appendChild(marker);
    }

    progressBar.appendChild(container);
    return true;
  }

  public clearMarkers(): void {
    document
      .querySelectorAll('.ai-sb-markers-container')
      .forEach((el) => el.remove());
  }

  private getSegmentKey(seg: SponsorSegment): string {
    return seg.id || `${seg.startTime.toFixed(1)}-${seg.endTime.toFixed(1)}`;
  }

  private attachVideoListener(): boolean {
    if (this.timeUpdateCleanup) {
      this.timeUpdateCleanup();
      this.timeUpdateCleanup = null;
    }

    const video = document.querySelector('video.html5-main-video') as HTMLVideoElement | null;
    if (!video) return false;

    const onTimeUpdate = () => {
      if (!this.settings.autoSkipEnabled || this.segments.length === 0) return;
      if (video.paused || video.seeking) return;
      if (this.isAdPlaying()) return;

      const now = Date.now();
      if (now - this.lastSkipTimestamp < 1200) return;

      const currentTime = video.currentTime;

      for (const seg of this.segments) {
        if (seg.category === 'selfpromo' && !this.settings.skipSelfPromo) {
          continue;
        }

        const key = this.getSegmentKey(seg);
        if (this.dismissedSegmentKeys.has(key)) {
          continue;
        }

        if (currentTime >= seg.startTime && currentTime < seg.endTime - 0.5) {
          const confidence = seg.confidence ?? 0.9;

          if (confidence >= 0.8) {
            // High confidence: automatic skip
            this.lastSkipTimestamp = now;
            video.currentTime = seg.endTime;
            this.onAutoSkipRecorded(seg);
            this.showSkippedToast(seg, video);
            break;
          } else if (confidence >= 0.55) {
            // Medium confidence: prompt user with manual Skip button
            this.showManualSkipPrompt(seg, video);
            break;
          }
        }
      }
    };

    const onLoadedMetadata = () => {
      if (!this.isAdPlaying() && video.duration > 0 && !Number.isNaN(video.duration)) {
        this.videoDuration = video.duration;
        this.renderMarkers();
      }
    };

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('loadedmetadata', onLoadedMetadata);

    this.timeUpdateCleanup = () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
    };

    return true;
  }

  private showSkippedToast(seg: SponsorSegment, video: HTMLVideoElement): void {
    const player = document.getElementById('movie_player');
    if (!player) return;

    this.hideToast();

    const toast = document.createElement('div');
    toast.className = 'ai-sb-toast';

    const badge = document.createElement('span');
    badge.className = 'ai-sb-toast-badge';
    badge.textContent = seg.source === 'sponsorblock' ? 'SB' : 'AI SKIP';

    const textWrap = document.createElement('div');
    textWrap.className = 'ai-sb-toast-text';

    const title = document.createElement('div');
    title.className = 'ai-sb-toast-title';
    title.textContent = `Skipped ${seg.sponsorName || 'Sponsor'}`;

    const sub = document.createElement('div');
    sub.className = 'ai-sb-toast-sub';
    sub.textContent = `${formatTime(seg.startTime)} → ${formatTime(seg.endTime)} (${Math.round(
      seg.endTime - seg.startTime
    )}s saved)`;

    textWrap.appendChild(title);
    textWrap.appendChild(sub);

    const undoBtn = document.createElement('button');
    undoBtn.className = 'ai-sb-toast-btn';
    undoBtn.textContent = 'Undo & Report';
    undoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = this.getSegmentKey(seg);
      this.dismissedSegmentKeys.add(key);
      video.currentTime = seg.startTime;
      this.onUndoSegment(seg);
      this.hideToast();
    });

    toast.appendChild(badge);
    toast.appendChild(textWrap);
    toast.appendChild(undoBtn);

    player.appendChild(toast);
    this.activeToastEl = toast;

    this.activeToastTimer = window.setTimeout(() => {
      this.hideToast();
    }, 6500);
  }

  private showManualSkipPrompt(seg: SponsorSegment, video: HTMLVideoElement): void {
    if (this.activeToastEl) return;
    const player = document.getElementById('movie_player');
    if (!player) return;

    const toast = document.createElement('div');
    toast.className = 'ai-sb-toast';

    const badge = document.createElement('span');
    badge.className = 'ai-sb-toast-badge';
    badge.textContent = 'SPONSOR?';

    const textWrap = document.createElement('div');
    textWrap.className = 'ai-sb-toast-text';

    const title = document.createElement('div');
    title.className = 'ai-sb-toast-title';
    title.textContent = `${seg.sponsorName || 'Sponsor'} (${formatTime(seg.startTime)} → ${formatTime(seg.endTime)})`;

    textWrap.appendChild(title);

    const skipBtn = document.createElement('button');
    skipBtn.className = 'ai-sb-toast-btn ai-sb-toast-btn-primary';
    skipBtn.textContent = '⏭ Skip Sponsor';
    skipBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.lastSkipTimestamp = Date.now();
      video.currentTime = seg.endTime;
      this.onManualSkipSegment(seg);
      this.hideToast();
    });

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'ai-sb-toast-btn';
    dismissBtn.textContent = '✕';
    dismissBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.dismissedSegmentKeys.add(this.getSegmentKey(seg));
      this.hideToast();
    });

    toast.appendChild(badge);
    toast.appendChild(textWrap);
    toast.appendChild(skipBtn);
    toast.appendChild(dismissBtn);

    player.appendChild(toast);
    this.activeToastEl = toast;

    this.activeToastTimer = window.setTimeout(() => {
      this.hideToast();
    }, 8000);
  }

  public hideToast(): void {
    if (this.activeToastTimer !== null) {
      clearTimeout(this.activeToastTimer);
      this.activeToastTimer = null;
    }
    if (this.activeToastEl) {
      this.activeToastEl.remove();
      this.activeToastEl = null;
    }
  }
}
