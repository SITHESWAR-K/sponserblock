# ⚡ AI SponsorBlock — Instant YouTube Sponsorship Blocker

Automatically detects and skips in-video creator sponsorships on YouTube — including **brand-new uploads** with zero crowdsourced data — powered by **Groq (`qwen/qwen3.8-27b`)**, **Supabase PostgreSQL**, and **SponsorBlock fallback**.

- 🌐 **Live Website & Interactive Demo:** [https://sponsorblockyt.web.app](https://sponsorblockyt.web.app)
- 🧩 **Microsoft Edge Add-ons Store:** [Install AI SponsorBlock on Edge](https://microsoftedge.microsoft.com/addons/detail/ai-sponsorblock-%E2%80%94-sponsor/fgefilonebjmccnkkneijhiinmbdihgf)
- 🔒 **Privacy Policy:** [https://sponsorblockyt.web.app/privacy](https://sponsorblockyt.web.app/privacy)

---

## Architecture Overview

1. **Parallel Fast Lookup (<150ms):**
   - When a YouTube video loads, the extension queries **Supabase** (`videos` + `sponsor_segments`) and the **SponsorBlock Public API** (`sponsorblock.ajay.app`) in parallel.
   - If segments are already cached in Supabase or found in SponsorBlock, they are rendered on the YouTube progress bar and auto-skipped immediately.
2. **Real-Time AI Caption Analysis (Cache Miss):**
   - For brand-new videos not yet in Supabase or SponsorBlock, `pageBridge.js` (`MAIN` world) extracts the timestamped caption cues (`fmt=json3`), description promo links, and chapters directly from the YouTube player.
   - The backend/Edge Function compacts the transcript and calls **Groq (`qwen/qwen3.8-27b`)** in JSON mode (`temperature: 0.1`) to identify exact `startTime` and `endTime` boundaries.
   - Detected segments (and clean `has_sponsors = false` results) are stored in **Supabase** so every subsequent viewer skips the sponsorship instantaneously.
3. **Confidence-Based UX & Community Verification:**
   - **High Confidence (`>= 0.80`):** Automatically seeks to `endTime` and displays a sleek toast with an **[Undo & Report]** button (which seeks back and submits a `downvote` to Supabase; segments with `>= 3` downvotes and `downvotes > upvotes * 2` are automatically hidden).
   - **Medium Confidence (`0.55 – 0.79`):** Displays a clickable **[⏭ Skip Sponsor]** prompt that skips and records an `upvote`.

---

## Project Structure

- `supabase/`
  - `migrations/001_init_schema.sql` — PostgreSQL schema (`videos`, `sponsor_segments`, RLS policies, `vote_segment` RPC, `save_video_analysis` RPC).
  - `functions/analyze-video/index.ts` — Deployed Supabase Edge Function (`https://yayhcowmesmjccjelmuf.supabase.co/functions/v1/analyze-video`).
- `backend/`
  - `src/services/groqAnalyzer.ts` — Transcript compaction, description link/promo extraction, chapter detection, and Groq `qwen/qwen3.8-27b` analysis.
  - `src/services/supabaseService.ts` — Supabase caching, in-flight request deduplication lock, and community voting.
  - `src/server.ts` — Express server (`GET /api/segments/:videoId`, `POST /api/analyze`, `POST /api/vote`, `GET /api/health`).
  - `tests/` — Vitest unit and live integration test suites.
- `extension/`
  - `manifest.json` — Chrome Extension Manifest V3 configuration.
  - `src/content/pageBridge.ts` — `MAIN` world YouTube player caption (`json3`) and metadata extractor.
  - `src/content/playerOverlay.ts` — Timeline marker renderer, auto-skipper, and Undo/Skip toast controller.
  - `src/content/contentScript.ts` — `ISOLATED` world coordinator for YouTube SPA navigation.
  - `src/background/serviceWorker.ts` — Parallel Supabase + SponsorBlock lookup & Groq analysis trigger.
  - `src/popup/` — Extension popup dashboard.
  - `dist/` — Compiled Manifest V3 extension ready for Chrome `Load unpacked`.

---

## Quick Start

### 1. Load the Chrome Extension
1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select:
   ```
   C:\Users\sithe\OneDrive\Desktop\web_dev\sponserblock\extension\dist
   ```
4. By default, the extension connects directly to the deployed **Supabase Edge Function** (`https://yayhcowmesmjccjelmuf.supabase.co/functions/v1/analyze-video`), so it works immediately without needing a local server running.

### 2. Run the Local Backend (Optional)
```bash
cd backend
npm run dev
```
In the extension popup, click **Local :3001** under Backend API Endpoint to route requests through `http://localhost:3001` (with automatic fallback to Supabase Cloud).

### 3. Run Tests & Rebuild
```bash
# Run backend unit & live Groq + Supabase integration tests
cd backend && npm test

# Rebuild Chrome extension into extension/dist
cd extension && npm run build
```
