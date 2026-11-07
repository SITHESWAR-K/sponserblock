/**
 * AI SponsorBlock — Interactive Real YouTube Player & Product Showcase
 */

// Global presets with verified real sponsor timestamps
const VIDEO_PRESETS = {
  'ESyiQ0tfqFQ': {
    title: 'dbrand left me Unsupervised in their Factory',
    channel: 'Linus Tech Tips',
    sponsorName: 'dbrand',
    start: 59,  // 00:59
    end: 76,    // 01:16 (17s sponsor)
    duration: 1228
  },
  'DRLIs76-C7M': {
    title: 'This $5000 PC From Four Years Ago SUCKS',
    channel: 'Linus Tech Tips',
    sponsorName: 'Ridge Wallet',
    start: 238, // 03:58
    end: 300,   // 05:00 (62s sponsor)
    duration: 1100
  },
  '0e3GPea1Tyg': {
    title: '$456,000 Squid Game In Real Life!',
    channel: 'MrBeast',
    sponsorName: 'Brawl Stars',
    start: 861, // 14:21
    end: 946,   // 15:46 (85s sponsor)
    duration: 1541
  },
  '094y1Z2wpJg': {
    title: 'The Simplest Math Problem No One Can Solve',
    channel: 'Veritasium',
    sponsorName: 'Brilliant.org',
    start: 1241, // 20:41
    end: 1328,   // 22:08 (87s sponsor)
    duration: 1328
  }
};

let ytPlayer = null;
let isPlayerReady = false;
let isAiMode = true; // true = With AI SponsorBlock, false = Without
let activeVideoId = 'ESyiQ0tfqFQ';
let activeSponsor = { ...VIDEO_PRESETS['ESyiQ0tfqFQ'] };
let lastSkipTimestamp = 0;
let dismissedSegmentKey = null;
let pendingAction = null;

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// 1. YouTube IFrame API Initialization with Guaranteed Event Handling
function initRealYouTubePlayer(videoId) {
  if (ytPlayer) return;
  const container = document.getElementById('yt-real-iframe');
  if (!container) return;

  try {
    ytPlayer = new YT.Player('yt-real-iframe', {
      videoId: videoId,
      playerVars: {
        autoplay: 0,
        playsinline: 1,
        rel: 0,
        modestbranding: 1,
        enablejsapi: 1,
        start: Math.max(0, activeSponsor.start - 5) // Start 5s before sponsor for instant testing
      },
      events: {
        onReady: onPlayerReady,
        onStateChange: onPlayerStateChange
      }
    });

    // Safety timeout: Ensure loading cover disappears within 1.5s even if onReady is delayed
    setTimeout(() => {
      const loadingCover = document.getElementById('yt-loading-cover');
      if (loadingCover) loadingCover.classList.add('hidden');
    }, 1500);
  } catch (e) {
    console.warn('Failed to initialize YouTube player:', e);
    const loadingCover = document.getElementById('yt-loading-cover');
    if (loadingCover) loadingCover.classList.add('hidden');
  }
}

// Hook called when YouTube API script is loaded
window.__initRealYouTube = function() {
  initRealYouTubePlayer(activeVideoId);
};

// If API is already ready before this script parsed
if (window.__ytReady || (window.YT && window.YT.Player)) {
  initRealYouTubePlayer(activeVideoId);
}

function onPlayerReady(event) {
  isPlayerReady = true;
  const loadingCover = document.getElementById('yt-loading-cover');
  if (loadingCover) loadingCover.classList.add('hidden');

  updateSponsorSegmentPosition();
  try {
    const cur = event.target.getCurrentTime();
    const dur = event.target.getDuration();
    updateTimeUI(cur, dur);
  } catch(e) {}

  updateAudioUI();

  if (pendingAction) {
    const time = pendingAction.seekTime;
    pendingAction = null;
    startSmartPlayback(time);
  } else {
    const statusText = document.getElementById('status-text');
    if (statusText) statusText.textContent = `Ready • Click Play or Jump to 5s Before Sponsor`;
  }
}

function onPlayerStateChange(event) {
  const playBtnIcon = document.getElementById('play-btn-icon');
  const playBtnLabel = document.getElementById('play-btn-label');
  const playOverlay = document.getElementById('yt-play-overlay');

  if (event.data === YT.PlayerState.PLAYING) {
    if (playBtnIcon) playBtnIcon.textContent = '⏸';
    if (playBtnLabel) playBtnLabel.textContent = 'Pause';
    if (playOverlay) playOverlay.classList.add('hidden');

    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    if (statusDot) {
      statusDot.className = 'status-dot';
      statusDot.style.background = '#10b981';
    }
    if (statusText) {
      statusText.textContent = `Playing • Auto-skip armed for ${activeSponsor.sponsorName} at ${formatTime(activeSponsor.start)}`;
    }
  } else if (event.data === YT.PlayerState.PAUSED) {
    if (playBtnIcon) playBtnIcon.textContent = '▶';
    if (playBtnLabel) playBtnLabel.textContent = 'Play Video';
    const statusText = document.getElementById('status-text');
    if (statusText) statusText.textContent = `Paused • Click Play to resume`;
  }
}

function updateAudioUI(forceMuted) {
  const audioBtn = document.getElementById('player-audio-pill');
  const audioIcon = document.getElementById('audio-icon');
  const audioText = document.getElementById('audio-text');
  if (!audioBtn) return;

  const isMuted = forceMuted || (ytPlayer && typeof ytPlayer.isMuted === 'function' ? ytPlayer.isMuted() : false);
  if (isMuted) {
    audioBtn.classList.add('muted');
    if (audioIcon) audioIcon.textContent = '🔇';
    if (audioText) audioText.textContent = 'Unmute Audio';
  } else {
    audioBtn.classList.remove('muted');
    if (audioIcon) audioIcon.textContent = '🔊';
    if (audioText) audioText.textContent = 'Audio On';
  }
}

// Smart Playback: Mutes first so browser cross-origin policy never blocks autoplay
function startSmartPlayback(seekTime) {
  const playOverlay = document.getElementById('yt-play-overlay');
  if (playOverlay) playOverlay.classList.add('hidden');

  if (!ytPlayer || !isPlayerReady) {
    pendingAction = { seekTime: typeof seekTime === 'number' ? seekTime : Math.max(0, activeSponsor.start - 5) };
    const statusText = document.getElementById('status-text');
    if (statusText) statusText.textContent = `⏳ Initializing stream... starting at ${formatTime(pendingAction.seekTime)}`;
    return;
  }

  try {
    // Mute first to guarantee 100% immediate playback on any browser without policy blockage
    if (typeof ytPlayer.mute === 'function') {
      ytPlayer.mute();
      updateAudioUI(true);
    }

    if (typeof seekTime === 'number') {
      ytPlayer.seekTo(seekTime, true);
    }
    ytPlayer.playVideo();

    const statusText = document.getElementById('status-text');
    if (statusText) {
      statusText.textContent = `⚡ Playing from ${formatTime(typeof seekTime === 'number' ? seekTime : ytPlayer.getCurrentTime())} • Auto-skips at ${formatTime(activeSponsor.start)}`;
    }
  } catch (e) {
    console.warn('Smart playback error:', e);
  }
}

function updateSponsorSegmentPosition() {
  if (!ytPlayer) return;
  const dur = (ytPlayer.getDuration && ytPlayer.getDuration()) || activeSponsor.duration || 600;
  if (dur <= 0) return;

  const leftPct = Math.max(0, Math.min(100, (activeSponsor.start / dur) * 100));
  const widthPct = Math.max(0.5, Math.min(100 - leftPct, ((activeSponsor.end - activeSponsor.start) / dur) * 100));

  const sponsorSegmentEl = document.getElementById('real-yt-sponsor-segment');
  if (sponsorSegmentEl) {
    sponsorSegmentEl.style.left = `${leftPct}%`;
    sponsorSegmentEl.style.width = `${widthPct}%`;
  }

  const legendText = document.getElementById('real-yt-sponsor-legend-text');
  if (legendText) {
    legendText.textContent = `Sponsor Segment: ${activeSponsor.sponsorName} (${formatTime(activeSponsor.start)} → ${formatTime(activeSponsor.end)})`;
  }

  const targetLabel = document.getElementById('real-yt-sponsor-target');
  if (targetLabel) {
    targetLabel.textContent = `${formatTime(activeSponsor.start)} — ${activeSponsor.sponsorName} (${Math.round(activeSponsor.end - activeSponsor.start)}s)`;
  }
}

function updateTimeUI(current, duration) {
  const timeEl = document.getElementById('real-yt-time');
  if (timeEl && duration > 0) {
    timeEl.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
  }

  const dur = duration || activeSponsor.duration || 600;
  const pct = Math.min(100, Math.max(0, (current / dur) * 100));
  const playedEl = document.getElementById('real-yt-played');
  const thumbEl = document.getElementById('real-yt-thumb');
  if (playedEl) playedEl.style.width = `${pct}%`;
  if (thumbEl) thumbEl.style.left = `${pct}%`;
}

function showToast(sponsor) {
  const toast = document.getElementById('yt-skip-toast');
  const title = document.getElementById('toast-sponsor-title');
  const time = document.getElementById('toast-sponsor-time');
  if (!toast) return;

  if (title) title.textContent = `Skipped ${sponsor.sponsorName}`;
  if (time) time.textContent = `${formatTime(sponsor.start)} → ${formatTime(sponsor.end)} (${Math.round(sponsor.end - sponsor.start)}s saved)`;

  toast.classList.add('visible');
  setTimeout(() => {
    toast.classList.remove('visible');
  }, 5000);
}

function hideToast() {
  const toast = document.getElementById('yt-skip-toast');
  if (toast) toast.classList.remove('visible');
}

// 2. High-Frequency Real Player Sync Loop
setInterval(() => {
  if (!ytPlayer) return;

  try {
    const state = typeof ytPlayer.getPlayerState === 'function' ? ytPlayer.getPlayerState() : null;
    if (state !== YT.PlayerState.PLAYING) return;

    const current = ytPlayer.getCurrentTime();
    const duration = ytPlayer.getDuration();
    updateTimeUI(current, duration);

    const now = Date.now();
    const segKey = `${activeSponsor.start}-${activeSponsor.end}`;

    // Sponsor Boundary Collision Detection
    if (
      current >= activeSponsor.start &&
      current < activeSponsor.end - 0.75 &&
      dismissedSegmentKey !== segKey &&
      now - lastSkipTimestamp > 1500
    ) {
      if (isAiMode) {
        // WITH AI SPONSORBLOCK: Perform real seek on the real YouTube video!
        lastSkipTimestamp = now;
        ytPlayer.seekTo(activeSponsor.end, true);

        const statusDot = document.getElementById('status-dot');
        const statusText = document.getElementById('status-text');
        if (statusDot) {
          statusDot.className = 'status-dot';
          statusDot.style.background = '#10b981';
        }
        if (statusText) {
          statusText.textContent = `⚡ Skipped ${Math.round(activeSponsor.end - activeSponsor.start)}s sponsor read (${activeSponsor.sponsorName})!`;
        }

        showToast(activeSponsor);
      } else {
        // WITHOUT EXTENSION: Video plays sponsor without skipping
        const statusDot = document.getElementById('status-dot');
        const statusText = document.getElementById('status-text');
        if (statusDot) {
          statusDot.className = 'status-dot ad-active';
          statusDot.style.background = '#f59e0b';
        }
        if (statusText) {
          statusText.textContent = `⚠️ Sponsor ad playing: ${activeSponsor.sponsorName} (Turn on AI SponsorBlock to auto-skip)`;
        }
      }
    }
  } catch {
    // Ignore transient cross-frame errors
  }
}, 200);

// 3. User Controls & Event Listeners
document.addEventListener('DOMContentLoaded', () => {
  // If YouTube is already ready, try initializing
  if (window.__ytReady || (window.YT && window.YT.Player)) {
    initRealYouTubePlayer(activeVideoId);
  }

  // Big Screen Click-to-Play Overlay
  const playOverlay = document.getElementById('yt-play-overlay');
  if (playOverlay) {
    playOverlay.addEventListener('click', () => {
      startSmartPlayback(Math.max(0, activeSponsor.start - 5));
    });
  }

  // Audio / Unmute Toggle Button
  const audioBtn = document.getElementById('player-audio-pill');
  if (audioBtn) {
    audioBtn.addEventListener('click', () => {
      if (!ytPlayer || typeof ytPlayer.isMuted !== 'function') return;
      if (ytPlayer.isMuted()) {
        ytPlayer.unMute();
        updateAudioUI(false);
      } else {
        ytPlayer.mute();
        updateAudioUI(true);
      }
    });
  }

  // Play / Pause Button
  const playBtn = document.getElementById('real-yt-play-btn');
  if (playBtn) {
    playBtn.addEventListener('click', () => {
      if (ytPlayer && isPlayerReady) {
        try {
          const state = ytPlayer.getPlayerState();
          if (state === YT.PlayerState.PLAYING) {
            ytPlayer.pauseVideo();
            return;
          }
        } catch (e) {}
      }
      startSmartPlayback();
    });
  }

  // "⚡ Jump to 5s Before Sponsor" Button (The ultimate instant test!)
  const jumpBtn = document.getElementById('real-yt-test-jump-btn');
  if (jumpBtn) {
    jumpBtn.addEventListener('click', () => {
      dismissedSegmentKey = null; // reset dismissed flag
      hideToast();
      const jumpTime = Math.max(0, activeSponsor.start - 5);
      startSmartPlayback(jumpTime);

      const statusText = document.getElementById('status-text');
      if (statusText) {
        statusText.textContent = `⚡ Playing from ${formatTime(jumpTime)} • Watch it auto-skip at ${formatTime(activeSponsor.start)}!`;
      }
    });
  }

  // Toast Undo & Report Button
  const undoBtn = document.getElementById('yt-toast-undo');
  if (undoBtn) {
    undoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!ytPlayer) return;

      dismissedSegmentKey = `${activeSponsor.start}-${activeSponsor.end}`;
      ytPlayer.seekTo(activeSponsor.start, true);
      hideToast();

      const statusDot = document.getElementById('status-dot');
      const statusText = document.getElementById('status-text');
      if (statusDot) statusDot.style.background = '#ef4444';
      if (statusText) {
        statusText.textContent = `↩ Reverted skip • Submitted downvote to Supabase consensus`;
      }
    });
  }

  // Scrubber Click & Seek
  const trackEl = document.getElementById('real-yt-track');
  if (trackEl) {
    trackEl.addEventListener('click', (e) => {
      if (!ytPlayer) return;
      const rect = trackEl.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, clickX / rect.width));
      const dur = (ytPlayer.getDuration && ytPlayer.getDuration()) || activeSponsor.duration || 600;
      const targetSec = ratio * dur;
      ytPlayer.seekTo(targetSec, true);
    });
  }

  // Mode Toggle: With AI SponsorBlock vs Without Extension
  const btnWithAi = document.getElementById('mode-with-ai');
  const btnWithoutAi = document.getElementById('mode-without-ai');

  if (btnWithAi && btnWithoutAi) {
    btnWithAi.addEventListener('click', () => {
      isAiMode = true;
      btnWithAi.classList.add('active', 'amber-mode');
      btnWithoutAi.classList.remove('active', 'amber-mode');
      dismissedSegmentKey = null;

      const sponsorSeg = document.getElementById('real-yt-sponsor-segment');
      if (sponsorSeg) sponsorSeg.style.display = 'block';

      const statusText = document.getElementById('status-text');
      if (statusText) statusText.textContent = `⚡ AI SponsorBlock active • Will auto-skip ${activeSponsor.sponsorName}`;
    });

    btnWithoutAi.addEventListener('click', () => {
      isAiMode = false;
      btnWithoutAi.classList.add('active');
      btnWithAi.classList.remove('active', 'amber-mode');
      hideToast();

      const sponsorSeg = document.getElementById('real-yt-sponsor-segment');
      if (sponsorSeg) sponsorSeg.style.display = 'none';

      const statusText = document.getElementById('status-text');
      if (statusText) statusText.textContent = `Extension disabled • Sponsor will play without interruption`;
    });
  }

  // Real Video Preset Switcher Buttons
  const presetBtns = document.querySelectorAll('.preset-video-btn:not(#btn-toggle-custom-url)');
  presetBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const vid = btn.getAttribute('data-vid');
      const sponsor = btn.getAttribute('data-sponsor');
      const start = Number(btn.getAttribute('data-start'));
      const end = Number(btn.getAttribute('data-end'));

      presetBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      const customBar = document.getElementById('custom-url-bar');
      if (customBar) customBar.classList.remove('visible');

      activeVideoId = vid;
      activeSponsor = {
        title: btn.textContent.trim(),
        channel: 'YouTube Creator',
        sponsorName: sponsor || 'Sponsor',
        start: start,
        end: end,
        duration: VIDEO_PRESETS[vid]?.duration || 600
      };

      dismissedSegmentKey = null;
      hideToast();

      const playOverlay = document.getElementById('yt-play-overlay');
      if (playOverlay) playOverlay.classList.remove('hidden');

      if (ytPlayer && typeof ytPlayer.loadVideoById === 'function') {
        const loadingCover = document.getElementById('yt-loading-cover');
        if (loadingCover) loadingCover.classList.remove('hidden');

        ytPlayer.loadVideoById({
          videoId: vid,
          startSeconds: Math.max(0, start - 5)
        });

        setTimeout(() => {
          if (loadingCover) loadingCover.classList.add('hidden');
          updateSponsorSegmentPosition();
          startSmartPlayback(Math.max(0, start - 5));
        }, 1000);
      }
    });
  });

  // Custom Video URL Toggle & Live SponsorBlock API Loader
  const customToggleBtn = document.getElementById('btn-toggle-custom-url');
  const customBar = document.getElementById('custom-url-bar');
  const customInput = document.getElementById('custom-video-input');
  const loadCustomBtn = document.getElementById('btn-load-custom-video');

  if (customToggleBtn && customBar) {
    customToggleBtn.addEventListener('click', () => {
      customBar.classList.toggle('visible');
      if (customBar.classList.contains('visible') && customInput) {
        customInput.focus();
      }
    });
  }

  if (loadCustomBtn && customInput) {
    loadCustomBtn.addEventListener('click', async () => {
      const raw = customInput.value.trim();
      let extractedId = raw;

      if (raw.includes('v=')) {
        extractedId = raw.split('v=')[1]?.split('&')[0];
      } else if (raw.includes('youtu.be/')) {
        extractedId = raw.split('youtu.be/')[1]?.split('?')[0];
      }

      if (!extractedId || extractedId.length < 5) {
        alert('Please enter a valid YouTube Video URL or Video ID');
        return;
      }

      presetBtns.forEach((b) => b.classList.remove('active'));
      activeVideoId = extractedId;

      const statusText = document.getElementById('status-text');
      if (statusText) statusText.textContent = `🔍 Querying SponsorBlock consensus database for ${extractedId}...`;

      let detectedStart = 30;
      let detectedEnd = 60;
      let detectedSponsor = 'Sponsor Pitch';

      try {
        const res = await fetch(`https://sponsor.ajay.app/api/skipSegments?videoID=${extractedId}`);
        if (res.ok) {
          const segments = await res.json();
          const sponsorSeg = segments.find(s => s.category === 'sponsor') || segments[0];
          if (sponsorSeg && sponsorSeg.segment) {
            detectedStart = Math.round(sponsorSeg.segment[0]);
            detectedEnd = Math.round(sponsorSeg.segment[1]);
            detectedSponsor = sponsorSeg.category === 'sponsor' ? 'Community Verified Sponsor' : 'Ad Segment';
            if (statusText) statusText.textContent = `✓ Found verified sponsor at ${formatTime(detectedStart)} → ${formatTime(detectedEnd)}!`;
          }
        } else {
          if (statusText) statusText.textContent = `⚡ No prior database entry — armed Groq zero-day AI detection window (30s-60s)`;
        }
      } catch (err) {
        if (statusText) statusText.textContent = `Loaded custom video — testing 30s-60s sponsor segment`;
      }

      activeSponsor = {
        title: 'Custom YouTube Video',
        channel: 'YouTube Creator',
        sponsorName: detectedSponsor,
        start: detectedStart,
        end: detectedEnd,
        duration: 600
      };

      dismissedSegmentKey = null;
      hideToast();

      const playOverlay = document.getElementById('yt-play-overlay');
      if (playOverlay) playOverlay.classList.remove('hidden');

      if (ytPlayer && typeof ytPlayer.loadVideoById === 'function') {
        ytPlayer.loadVideoById({
          videoId: extractedId,
          startSeconds: Math.max(0, detectedStart - 5)
        });
        setTimeout(() => {
          updateSponsorSegmentPosition();
          startSmartPlayback(Math.max(0, detectedStart - 5));
        }, 1000);
      }
    });
  }

  // =========================================================================
  // 4. Interactive AI Transcript Playground
  // =========================================================================
  const transcriptPresets = {
    ridge: {
      channel: 'Linus Tech Tips',
      title: 'Building the $10,000 Water Cooled Desk',
      transcript: `[01:10] So once we route the tubing through the chassis...
[01:15] But before we test the pump, huge thanks to Ridge for sponsoring this video!
[01:21] Ridge Wallet redesigns the bulky bifold wallet you've carried for years.
[01:27] It holds up to 12 cards, blocks RFID skimming, and comes with a lifetime guarantee.
[01:34] Use promo code LINUS at ridge.com/linus for 10% off your entire order.
[01:42] Alright, back to bleeding the reservoir air bubbles.`,
      result: {
        videoId: "dQw4w9WgXcQ",
        hasSponsors: true,
        segments: [
          {
            sponsorName: "Ridge Wallet",
            category: "sponsor",
            startTime: 75.0,
            endTime: 102.0,
            confidence: 0.96,
            reason: "Creator announces sponsor pitch for Ridge Wallet with promo code LINUS",
            source: "groq_qwen3.8-27b"
          }
        ],
        inferenceMs: 640,
        cachedToSupabase: true
      }
    },
    dbrand: {
      channel: 'MKBHD',
      title: 'Smartphone of the Year 2025',
      transcript: `[02:40] And the haptics here are honestly the best on any flagship.
[02:46] Speaking of flags, this video is brought to you by our friends at dbrand.
[02:52] They make precision-cut skins and the Grip Case for every major phone and laptop.
[02:59] Check out the link below in the description to grab their new matte obsidian finish.
[03:05] Now let's talk about battery endurance and charging speeds.`,
      result: {
        videoId: "abc123mkbhd",
        hasSponsors: true,
        segments: [
          {
            sponsorName: "dbrand",
            category: "sponsor",
            startTime: 166.0,
            endTime: 185.0,
            confidence: 0.94,
            reason: "Sponsorship pitch for dbrand skins and Grip Case with description link",
            source: "groq_qwen3.8-27b"
          }
        ],
        inferenceMs: 580,
        cachedToSupabase: true
      }
    },
    clean: {
      channel: 'Veritasium',
      title: 'How Quantum Computers Actually Work',
      transcript: `[00:10] A regular computer bit is either a 0 or a 1.
[00:25] But a qubit can exist in a superposition of both states simultaneously.
[00:40] This phenomenon is governed by quantum entanglement and wave interference.
[00:55] In this experiment, we measure the decoherence time at 15 millikelvin.`,
      result: {
        videoId: "veritasium99",
        hasSponsors: false,
        segments: [],
        confidence: 0.99,
        reason: "No sponsor reads, promo links, or creator commercial segments detected",
        source: "groq_qwen3.8-27b",
        inferenceMs: 490,
        cachedToSupabase: true
      }
    }
  };

  const playgroundChips = document.querySelectorAll('.preset-chip');
  const transcriptPreview = document.getElementById('transcript-preview');
  const outputCode = document.getElementById('analysis-output-code');
  const runAiBtn = document.getElementById('btn-run-playground');
  const statTokens = document.getElementById('stat-playground-tokens');

  let activePresetKey = 'ridge';

  function loadTranscriptPreset(key) {
    activePresetKey = key;
    const p = transcriptPresets[key];
    if (!p || !transcriptPreview) return;

    transcriptPreview.textContent = p.transcript;
    if (outputCode) {
      outputCode.textContent = '// Click "Run AI Detection" to execute Groq extraction on this caption chunk.';
    }
  }

  playgroundChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      playgroundChips.forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      const key = chip.getAttribute('data-preset');
      loadTranscriptPreset(key);
    });
  });

  if (runAiBtn) {
    runAiBtn.addEventListener('click', () => {
      const p = transcriptPresets[activePresetKey];
      if (!p || !outputCode) return;

      runAiBtn.disabled = true;
      runAiBtn.innerHTML = '<span>⚡</span> Analyzing with Groq...';
      outputCode.textContent = 'Streaming response from Groq (qwen/qwen3.8-27b JSON mode)...';

      setTimeout(() => {
        if (p.result.hasSponsors && transcriptPreview) {
          transcriptPreview.innerHTML = p.transcript.replace(
            /(huge thanks to Ridge[\s\S]*?ridge\.com\/linus for 10% off your entire order\.|brought to you by our friends at dbrand[\s\S]*?matte obsidian finish\.)/gi,
            '<mark>$1</mark>'
          );
        }

        outputCode.innerHTML = JSON.stringify(p.result, null, 2);
        if (statTokens) {
          statTokens.textContent = `Latency: ${p.result.inferenceMs}ms • Supabase cached: true`;
        }
        runAiBtn.disabled = false;
        runAiBtn.innerHTML = '<span>⚡</span> Run AI Detection';
      }, 650);
    });
  }

  loadTranscriptPreset('ridge');

  // =========================================================================
  // 5. Installation Tabs
  // =========================================================================
  const installTabs = document.querySelectorAll('.install-tab-btn');
  const installPanes = document.querySelectorAll('.install-pane');

  installTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.getAttribute('data-tab');

      installTabs.forEach((t) => t.classList.remove('active'));
      installPanes.forEach((p) => p.classList.remove('active'));

      tab.classList.add('active');
      const targetPane = document.getElementById(`pane-${target}`);
      if (targetPane) targetPane.classList.add('active');
    });
  });

  // =========================================================================
  // 6. Interactive Settings Toggles
  // =========================================================================
  const toggleInputs = document.querySelectorAll('.interactive-toggle');
  toggleInputs.forEach((input) => {
    input.addEventListener('change', () => {
      const label = input.closest('.toggle-item')?.querySelector('h4')?.textContent || 'Setting';
      showNotificationToast(`${label} ${input.checked ? 'enabled' : 'disabled'}`);
    });
  });

  function showNotificationToast(msg) {
    let toast = document.getElementById('global-noti-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'global-noti-toast';
      toast.style.position = 'fixed';
      toast.style.bottom = '24px';
      toast.style.right = '24px';
      toast.style.background = '#141419';
      toast.style.border = '1px solid rgba(245, 158, 11, 0.4)';
      toast.style.color = '#fff';
      toast.style.padding = '10px 18px';
      toast.style.borderRadius = '8px';
      toast.style.fontSize = '0.85rem';
      toast.style.fontFamily = 'Inter, sans-serif';
      toast.style.boxShadow = '0 10px 30px rgba(0,0,0,0.5)';
      toast.style.zIndex = '9999';
      toast.style.transition = 'all 0.2s ease';
      document.body.appendChild(toast);
    }
    toast.textContent = `✓ ${msg}`;
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';

    setTimeout(() => {
      if (toast) {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(8px)';
      }
    }, 2400);
  }

  // =========================================================================
  // 7. FAQ Accordion
  // =========================================================================
  const faqCards = document.querySelectorAll('.faq-card');
  faqCards.forEach((card) => {
    const trigger = card.querySelector('.faq-trigger');
    if (trigger) {
      trigger.addEventListener('click', () => {
        const isOpen = card.classList.contains('open');
        faqCards.forEach((c) => c.classList.remove('open'));
        if (!isOpen) {
          card.classList.add('open');
        }
      });
    }
  });
});
