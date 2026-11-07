# Privacy Policy for AI SponsorBlock for YouTube™

**Effective Date:** March 2025  
**Last Updated:** March 2025

This Privacy Policy explains how **AI SponsorBlock for YouTube™** ("the Extension", "we", "us", or "our") collects, uses, and protects your information when you use our browser extension on Microsoft Edge and Chromium-based browsers.

---

## 1. Core Principle: Privacy by Design

AI SponsorBlock is built with a strict privacy-first philosophy:
- We **do not** collect personal identifiable information (PII).
- We **do not** track your browsing history or personal web activity.
- We **do not** sell, rent, monetize, or trade any user data to third parties or advertising brokers.
- We **do not** require an account, email address, password, or login to use the extension.

---

## 2. What Information We Access and Why

To detect and skip sponsorships within YouTube videos, the extension accesses the following technical data:

### A. YouTube Video Identifier and Timestamps
- **What is accessed:** The public YouTube Video ID (e.g. `dQw4w9WgXcQ`), video title, video duration, and public closed caption cues / transcript text provided by YouTube.
- **Why:** The transcript is analyzed to determine the start and end timestamps where creator sponsorships or promo segments occur.
- **Where it is sent:** Anonymized transcript text and video ID are sent to our AI analysis backend powered by Groq and cached in Supabase PostgreSQL so that future viewers of the same video do not need to re-scan it.

### B. Local Extension Storage (`chrome.storage.local`)
- **What is stored:**
  - Your personal preferences (e.g., toggle for auto-skipping, toggle for skipping self-promotions).
  - Aggregate statistics stored exclusively on your device (number of sponsorships skipped and estimated seconds saved).
- **Location:** Stored locally in your browser profile. This data never leaves your device.

### C. Community Feedback / Voting (Optional)
- **What is sent:** If you click "Undo & Report" or skip a segment manually, an anonymous segment vote (`upvote` or `downvote`) is transmitted to Supabase to adjust community confidence ratings and suppress false detections. No IP address or user identity is permanently linked to your vote.

---

## 3. Permissions Used and Justification

The extension requests only the minimum permissions required to perform its function:

| Permission | Justification |
|---|---|
| `storage` | Used to persist your user settings (auto-skip toggle, category preferences) and local skip statistics on your device. |
| `tabs` | Used exclusively when the extension is installed or updated to detect currently open `youtube.com` tabs so the overlay can function without requiring a manual page reload. |
| `scripting` | Used to inject the player overlay controller and caption bridge into YouTube video player pages. |
| Host: `*://*.youtube.com/*` | Required to read public captions and overlay skip markers on YouTube video players. |
| Host: `https://sponsorblock.ajay.app/*` | Used as a fast crowdsourced fallback to retrieve existing community skip segments. |
| Host: `https://yayhcowmesmjccjelmuf.supabase.co/*` | Used to query cached sponsor timestamps and store verified segments in our database. |

---

## 4. Third-Party Services

When analyzing video transcripts, the extension interacts with:
- **Supabase (PostgreSQL & Edge Functions):** Used for fast read/write caching of video sponsor timestamps and community votes.
- **Groq Cloud API:** Used to run high-speed inference (Qwen 3.8 27B model) to identify sponsorship timestamps from public video transcripts.
- **SponsorBlock Public API:** Used as a fallback database to check if community segments already exist for the video.

None of these third parties receive your personal identity, browsing history, cookies, or account credentials.

---

## 5. Data Security

All network communications with Supabase, Groq, and SponsorBlock are encrypted in transit using industry-standard **HTTPS / TLS 1.3**.

---

## 6. Children’s Privacy

The Extension does not knowingly collect or solicit any personal information from children under the age of 13.

---

## 7. Changes to This Privacy Policy

We may update this Privacy Policy from time to time. Any modifications will be reflected by the "Last Updated" date at the top of this policy.

---

## 8. Contact Us

If you have questions or concerns about this Privacy Policy or the Extension, please reach out via GitHub issues or email:  
**Support / GitHub:** `https://github.com/your-username/ai-sponsorblock` (or your contact email)

---

*Disclaimer: AI SponsorBlock is an independent open-source project and is not affiliated with, endorsed by, or sponsored by YouTube™, Google LLC, or Microsoft Corporation.*
