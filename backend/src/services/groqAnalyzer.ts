import dotenv from 'dotenv';

dotenv.config();

export interface TranscriptCue {
  start: number;
  end?: number;
  duration?: number;
  text: string;
}

export interface YouTubeJson3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Array<{ utf8?: string }>;
}

export interface ChapterItem {
  title: string;
  startTime: number;
  endTime?: number;
}

export interface DetectedSegment {
  id?: string;
  videoId?: string;
  startTime: number;
  endTime: number;
  sponsorName: string;
  category: 'sponsor' | 'selfpromo' | 'interaction';
  confidence: number;
  reason: string;
  source?: 'groq_ai' | 'sponsorblock' | 'chapters' | 'manual';
  upvotes?: number;
  downvotes?: number;
}

export interface AnalyzeVideoInput {
  videoId: string;
  title?: string;
  channelName?: string;
  duration?: number;
  description?: string;
  chapters?: ChapterItem[];
  transcript?: TranscriptCue[] | string;
  json3Events?: YouTubeJson3Event[];
  hasPaidPromotion?: boolean;
}

export interface AnalyzeVideoResult {
  hasSponsors: boolean;
  segments: DetectedSegment[];
  model: string;
  source: 'groq_ai' | 'chapters';
  hasTranscript?: boolean;
}

const SPONSOR_TRANSITION_REGEX =
  /(\b(?:sponsor(?:ed|ship)?|sponser(?:ed|ship)?|brought to you by|thanks to|thank you to|special thanks|huge thanks to|big thanks to|today'?s (?:video is|sponsor)|video sponsor|partnered with|paid promotion|ad\s*read|quick word from|portion of this video|segment of this video|support the channel|use code|promo code|coupon code|discount|%\s*off|free trial|money[-\s]*back guarantee|cancel anytime|scan the qr code|first \d+[\d,]* people|link (?:is )?(?:given )?(?:in|down in|below in) (?:the )?description|link below|use my link|use our link|click the link|pinned comment|check out|sign up at|download the app|before (?:going|we go|entering|jumping|diving) into the video|back to the video|let'?s get back|let'?s (?:go|get|dive|jump) into the video|now back to|onto the video|indha video(?:va|oda)?|videokulla|description[-\s]*la|comment[-\s]*la|keela description|link keela|check out pannunga|register pannunga|download pannunga|is video ke|link niche|description mein)\b|ஸ்பான்சர்|விளம்பரம்|டிஸ்கிரிப்ஷன்|லிங்க|கூப்பன்|ஆஃபர்|ஆபர்|டிஸ்கவுண்ட்|வீடியோக்குள்ள|स्पॉन्सर|डिस्क्रिप्शन|लिंक|कूपन|डिस्काउंट)/i;

const DESCRIPTION_PROMO_REGEX =
  /(https?:\/\/[^\s]+|[a-z0-9-]+\.(?:com|io|gg|co|org|net|deals|tv|app|in|ai|me|xyz|dev|shop|store|tech)\/[^\s]*|\b(?:sponsor(?:ed)?|sponser|code|coupon|discount|%\s*off|free trial|brought to you by|partner(?:ed)?|merch|paid promotion|special thanks|thanks to|check out)\b)/i;

const CHAPTER_SPONSOR_REGEX =
  /\b(sponsor(?:ed|ship)?|sponser(?:ed|ship)?|paid promotion|ad\s*read|partner(?:ship)?|brought to you by|thanks to|special thanks)\b/i;

const IGNORED_BRAND_DOMAINS = new Set([
  'youtube',
  'youtu',
  'google',
  'instagram',
  'twitter',
  'x',
  'facebook',
  'fb',
  'discord',
  'tiktok',
  'patreon',
  'github',
  'gitlab',
  'linkedin',
  'reddit',
  'twitch',
  'threads',
  'bsky',
  'mastodon',
  'telegram',
  'whatsapp',
  'spotify',
  'apple',
  'amzn',
  'amazon',
  'bit',
  'tinyurl',
  'linktr',
  'beacons',
  'ko-fi',
  'buymeacoffee',
  'substack',
  'medium',
  'wikipedia',
]);

/**
 * Extracts probable sponsor brand/domain tokens from the video description
 * so transcript compaction and chapter detection can anchor on brand mentions
 * even when the creator uses an organic transition without saying "sponsored by".
 */
export function extractBrandKeywordsFromDescription(description?: string): string[] {
  if (!description || typeof description !== 'string') {
    return [];
  }

  const keywords = new Set<string>();
  const urlRegex = /(?:https?:\/\/)?(?:www\.)?([a-z0-9-]{3,})\.(?:com|io|gg|co|org|net|deals|tv|app|in|ai|me|xyz|dev|shop|store|tech)(?:\/[^\s)]*)?/gi;
  let match: RegExpExecArray | null;

  while ((match = urlRegex.exec(description)) !== null) {
    const domainStem = match[1].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (domainStem.length >= 3 && !IGNORED_BRAND_DOMAINS.has(domainStem)) {
      keywords.add(domainStem);
      // Also strip trailing digits like factor75 -> factor
      const alphaStem = domainStem.replace(/\d+$/, '');
      if (alphaStem.length >= 4 && !IGNORED_BRAND_DOMAINS.has(alphaStem)) {
        keywords.add(alphaStem);
      }
    }
  }

  // Extract explicit brand names following "sponsored by X", "thanks to X", "check out X"
  const brandPhraseRegex =
    /\b(?:sponsor(?:ed)? by|brought to you by|thanks to|partnered with|check out)\s+([A-Z][A-Za-z0-9.+_-]{2,24})/g;
  while ((match = brandPhraseRegex.exec(description)) !== null) {
    const candidate = match[1].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (
      candidate.length >= 3 &&
      !IGNORED_BRAND_DOMAINS.has(candidate) &&
      !['our', 'the', 'this', 'today', 'my', 'their', 'new', 'video'].includes(candidate)
    ) {
      keywords.add(candidate);
    }
  }

  return Array.from(keywords).slice(0, 15);
}

function textMatchesBrandKeywords(text: string, brandKeywords: string[]): boolean {
  if (!text || !Array.isArray(brandKeywords) || brandKeywords.length === 0) {
    return false;
  }
  const lower = text.toLowerCase();
  for (const kw of brandKeywords) {
    if (kw.length >= 3 && lower.includes(kw)) {
      return true;
    }
  }
  return false;
}

/**
 * Parses YouTube's fmt=json3 caption events into normalized TranscriptCue objects.
 */
export function parseJson3ToCues(events: YouTubeJson3Event[]): TranscriptCue[] {
  if (!Array.isArray(events) || events.length === 0) {
    return [];
  }

  const rawCues: Array<{ start: number; duration?: number; text: string }> = [];

  for (const ev of events) {
    if (typeof ev?.tStartMs !== 'number' || !Array.isArray(ev.segs)) {
      continue;
    }

    const rawText = ev.segs
      .map((s) => (typeof s?.utf8 === 'string' ? s.utf8 : ''))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();

    if (!rawText || /^[♪♫\s\[\]()]+$/.test(rawText)) {
      continue;
    }

    const startSec = Math.round((ev.tStartMs / 1000) * 100) / 100;
    const durationSec =
      typeof ev.dDurationMs === 'number' && ev.dDurationMs > 0
        ? Math.round((ev.dDurationMs / 1000) * 100) / 100
        : undefined;

    rawCues.push({
      start: startSec,
      duration: durationSec,
      text: rawText,
    });
  }

  return rawCues.map((cue, idx) => {
    const nextCue = rawCues[idx + 1];
    let endSec: number;
    if (nextCue && nextCue.start > cue.start) {
      endSec = cue.duration
        ? Math.min(cue.start + cue.duration, nextCue.start)
        : nextCue.start;
    } else {
      endSec = cue.start + (cue.duration ?? 3.0);
    }
    endSec = Math.round(Math.max(endSec, cue.start + 0.5) * 100) / 100;

    return {
      start: cue.start,
      end: endSec,
      duration: Math.round((endSec - cue.start) * 100) / 100,
      text: cue.text,
    };
  });
}

/**
 * Estimates LLM BPE token count for mixed ASCII and non-ASCII (e.g. Tamil, Hindi, CJK) text.
 * ASCII characters average ~0.35 tokens/char (accounting for timestamp digits/punctuation),
 * while non-ASCII Unicode characters average ~1.5 tokens/char in Qwen/Llama tokenizers.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    tokens += text.charCodeAt(i) > 127 ? 1.5 : 0.35;
  }
  return Math.ceil(tokens);
}

/**
 * Compacts fine-grained caption cues into timestamped lines `[start - end] text`.
 * Splits immediately on sponsor transition phrases so start/end timestamps remain exact.
 * Enforces both character and token caps so total input stays well below Groq's 7,000 ITPM limit.
 */
export function compactTranscript(
  cues: TranscriptCue[],
  windowSeconds = 8,
  maxChars = 11000,
  maxTokens = 3800,
  brandKeywords: string[] = []
): string {
  if (!Array.isArray(cues) || cues.length === 0) {
    return '';
  }

  const normalized = cues
    .filter(
      (c) =>
        c &&
        typeof c.start === 'number' &&
        !Number.isNaN(c.start) &&
        typeof c.text === 'string' &&
        c.text.trim().length > 0
    )
    .sort((a, b) => a.start - b.start);

  if (normalized.length === 0) {
    return '';
  }

  const matchesSponsorSignal = (text: string): boolean =>
    SPONSOR_TRANSITION_REGEX.test(text) || textMatchesBrandKeywords(text, brandKeywords);

  const blocks: Array<{ line: string; hasTransition: boolean }> = [];
  let blockStart = normalized[0].start;
  let blockEnd =
    normalized[0].end ??
    normalized[0].start + (normalized[0].duration && normalized[0].duration > 0 ? normalized[0].duration : 3.0);
  let blockTexts: string[] = [normalized[0].text.trim().slice(0, 600)];
  let blockHasTransition = matchesSponsorSignal(normalized[0].text);

  const flushBlock = () => {
    if (blockTexts.length === 0) return;
    const s = Math.max(0, blockStart).toFixed(1);
    const e = Math.max(blockStart + 0.5, blockEnd).toFixed(1);
    const combinedText = blockTexts.join(' ');
    blocks.push({
      line: `[${s} - ${e}] ${combinedText}`,
      hasTransition: blockHasTransition || matchesSponsorSignal(combinedText),
    });
    blockTexts = [];
    blockHasTransition = false;
  };

  for (let i = 1; i < normalized.length; i++) {
    const cue = normalized[i];
    const cueText = cue.text.trim().slice(0, 600);
    const nextCue = normalized[i + 1];
    const cueEnd =
      cue.end ??
      (cue.duration && cue.duration > 0
        ? cue.start + cue.duration
        : nextCue && nextCue.start > cue.start
        ? nextCue.start
        : cue.start + 3.0);

    const isTransitionCue = matchesSponsorSignal(cueText);
    const elapsedInBlock = cueEnd - blockStart;

    if (isTransitionCue || elapsedInBlock > windowSeconds) {
      // Ensure previous block ends cleanly at the start of the new cue if contiguous
      if (cue.start > blockStart && cue.start < blockEnd + 2.0) {
        blockEnd = cue.start;
      }
      flushBlock();
      blockStart = cue.start;
      blockEnd = cueEnd;
      blockTexts = [cueText];
      blockHasTransition = isTransitionCue;
    } else {
      blockEnd = Math.max(blockEnd, cueEnd);
      blockTexts.push(cueText);
    }
  }

  flushBlock();

  const fullText = blocks.map((b) => b.line).join('\n');
  if (fullText.length <= maxChars && estimateTokens(fullText) <= maxTokens) {
    return fullText;
  }

  // Long video handling: prioritize windows around sponsor transition/brand keywords [-3, +14 blocks],
  // then intro and outro blocks, then fill remaining character/token budget in chronological order.
  // Two-pass transition selection ensures early transition padding never starves later transition centers.
  const transitionCoreIndices: number[] = [];
  const transitionWindowIndices = new Set<number>();
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].hasTransition) {
      for (const offset of [0, 1, 2, -1]) {
        const k = i + offset;
        if (k >= 0 && k < blocks.length) {
          transitionCoreIndices.push(k);
        }
      }
      const startIdx = Math.max(0, i - 3);
      const endIdx = Math.min(blocks.length - 1, i + 14);
      for (let k = startIdx; k <= endIdx; k++) {
        transitionWindowIndices.add(k);
      }
    }
  }

  const introOutroIndices = new Set<number>();
  // Include first 10 blocks (intro) and last 6 blocks (outro)
  for (let i = 0; i < Math.min(10, blocks.length); i++) introOutroIndices.add(i);
  for (let i = Math.max(0, blocks.length - 6); i < blocks.length; i++) introOutroIndices.add(i);

  const selectedIndices = new Set<number>();
  let usedChars = 0;
  let usedTokens = 0;

  const tryAddBlock = (idx: number): boolean => {
    if (selectedIndices.has(idx)) return true;
    const line = blocks[idx].line;
    const sep = selectedIndices.size > 0 ? 1 : 0;
    const len = line.length + sep;
    const tokens = estimateTokens(line) + sep;
    if (usedChars + len <= maxChars && usedTokens + tokens <= maxTokens) {
      selectedIndices.add(idx);
      usedChars += len;
      usedTokens += tokens;
      return true;
    }
    return false;
  };

  // 1a. Add core transition blocks across all matches first so late-video ad reads are never starved
  for (const idx of transitionCoreIndices) {
    tryAddBlock(idx);
  }

  // 1b. Expand to full [-3, +14] sponsor transition windows
  for (const idx of Array.from(transitionWindowIndices).sort((a, b) => a - b)) {
    tryAddBlock(idx);
  }

  // 2. Add intro and outro blocks
  for (const idx of Array.from(introOutroIndices).sort((a, b) => a - b)) {
    tryAddBlock(idx);
  }

  // 3. Fill remaining budget with sequential blocks
  for (let i = 0; i < blocks.length; i++) {
    if (selectedIndices.has(i)) continue;
    if (!tryAddBlock(i)) {
      break;
    }
  }

  if (selectedIndices.size === 0 && blocks.length > 0) {
    let fallback = blocks[0].line.slice(0, Math.max(20, maxChars));
    while (fallback.length > 20 && estimateTokens(fallback) > maxTokens) {
      fallback = fallback.slice(0, Math.floor(fallback.length * 0.75));
    }
    return fallback;
  }

  return Array.from(selectedIndices)
    .sort((a, b) => a - b)
    .map((idx) => blocks[idx].line)
    .join('\n');
}

/**
 * Extracts sponsor-relevant URLs, discount codes, and promotional lines from the video description.
 */
export function extractDescriptionHints(description?: string): string[] {
  if (!description || typeof description !== 'string') {
    return [];
  }

  const lines = description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const hints: string[] = [];
  for (const line of lines) {
    if (DESCRIPTION_PROMO_REGEX.test(line)) {
      hints.push(line.slice(0, 240));
    }
    if (hints.length >= 25) {
      break;
    }
  }

  return hints;
}

/**
 * Checks if video chapters explicitly label a sponsor segment or match a sponsor brand from the description.
 */
export function detectSponsorFromChapters(
  chapters?: ChapterItem[],
  duration?: number,
  description?: string
): DetectedSegment[] {
  if (!Array.isArray(chapters) || chapters.length === 0) {
    return [];
  }

  const brandKeywords = extractBrandKeywordsFromDescription(description);
  const sorted = [...chapters]
    .filter((c) => c && typeof c.startTime === 'number' && typeof c.title === 'string')
    .sort((a, b) => a.startTime - b.startTime);

  const rawSegments: any[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const ch = sorted[i];
    const isExplicitSponsorChapter = CHAPTER_SPONSOR_REGEX.test(ch.title);
    const matchedBrand = !isExplicitSponsorChapter
      ? brandKeywords.find((kw) => {
          if (kw.length < 4) return false;
          const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return new RegExp(`\\b${escaped}\\b`, 'i').test(ch.title);
        })
      : undefined;

    if (isExplicitSponsorChapter || matchedBrand) {
      const nextCh = sorted[i + 1];
      const endTime =
        typeof ch.endTime === 'number' && ch.endTime > ch.startTime
          ? ch.endTime
          : nextCh
          ? nextCh.startTime
          : duration ?? ch.startTime + 60;

      const cleanedSponsor = isExplicitSponsorChapter
        ? ch.title
            .replace(CHAPTER_SPONSOR_REGEX, '')
            .replace(/[:\-–—|()\[\]]/g, ' ')
            .trim()
        : ch.title.trim();

      rawSegments.push({
        startTime: ch.startTime,
        endTime,
        sponsorName: cleanedSponsor || matchedBrand || 'Sponsor',
        category: 'sponsor',
        confidence: isExplicitSponsorChapter ? 0.92 : 0.88,
        reason: `Explicitly marked in video chapter: "${ch.title}"`,
        source: 'chapters',
      });
    }
  }

  return validateAndNormalizeSegments(rawSegments, duration);
}

/**
 * Safely extracts JSON from LLM output, stripping any <think>...</think> blocks or markdown fences.
 */
export function extractJsonFromModelOutput(rawContent: string): any {
  if (!rawContent || typeof rawContent !== 'string') {
    return { hasSponsors: false, segments: [] };
  }

  // Strip Qwen/DeepSeek/Nemotron <think>...</think> reasoning blocks if present
  let cleaned = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // Strip markdown code fences if present
  cleaned = cleaned
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Fallback: locate outermost JSON object braces
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const slice = cleaned.slice(firstBrace, lastBrace + 1);
      return JSON.parse(slice);
    }
    throw new Error('Failed to parse JSON object from AI model output');
  }
}

/**
 * Validates, clamps, filters (< 5s), and merges overlapping sponsor segments.
 */
export function validateAndNormalizeSegments(
  rawSegments: any[],
  duration?: number
): DetectedSegment[] {
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    return [];
  }

  const maxDuration =
    typeof duration === 'number' && !Number.isNaN(duration) && duration > 0
      ? duration
      : undefined;

  const valid: DetectedSegment[] = [];

  for (const item of rawSegments) {
    if (!item || typeof item !== 'object') continue;

    let startTime = Number(item.startTime ?? item.start_time ?? item.start);
    let endTime = Number(item.endTime ?? item.end_time ?? item.end);

    if (Number.isNaN(startTime) || Number.isNaN(endTime)) {
      continue;
    }

    startTime = Math.max(0, Math.round(startTime * 100) / 100);
    if (maxDuration !== undefined) {
      endTime = Math.min(maxDuration, Math.round(endTime * 100) / 100);
    } else {
      endTime = Math.round(endTime * 100) / 100;
    }

    // Require minimum 5 second segment length to prevent accidental micro-skips
    if (endTime - startTime < 5) {
      continue;
    }

    let confidence = Number(item.confidence ?? 0.85);
    if (Number.isNaN(confidence)) {
      confidence = 0.85;
    }
    confidence = Math.max(0, Math.min(1, Math.round(confidence * 100) / 100));

    // Ignore very low confidence guesses (< 0.50)
    if (confidence < 0.50) {
      continue;
    }

    const rawCategory = String(item.category || 'sponsor').toLowerCase();
    const category: 'sponsor' | 'selfpromo' | 'interaction' =
      rawCategory === 'selfpromo' || rawCategory === 'interaction'
        ? rawCategory
        : 'sponsor';

    const sponsorName =
      typeof item.sponsorName === 'string' && item.sponsorName.trim().length > 0
        ? item.sponsorName.trim().slice(0, 80)
        : typeof item.sponsor_name === 'string' && item.sponsor_name.trim().length > 0
        ? item.sponsor_name.trim().slice(0, 80)
        : category === 'selfpromo'
        ? 'Self Promotion'
        : 'Sponsor';

    const reason =
      typeof item.reason === 'string' && item.reason.trim().length > 0
        ? item.reason.trim().slice(0, 300)
        : 'Detected promotional segment in transcript';

    valid.push({
      startTime,
      endTime,
      sponsorName,
      category,
      confidence,
      reason,
      source: item.source || 'groq_ai',
    });
  }

  if (valid.length <= 1) {
    return valid;
  }

  // Sort by startTime ascending and merge overlapping or nearly-contiguous segments (< 2.5s gap)
  valid.sort((a, b) => a.startTime - b.startTime);

  const merged: DetectedSegment[] = [valid[0]];
  for (let i = 1; i < valid.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = valid[i];

    if (curr.startTime <= prev.endTime + 2.5) {
      prev.endTime = Math.max(prev.endTime, curr.endTime);
      prev.confidence = Math.max(prev.confidence, curr.confidence);
      if (
        prev.sponsorName === 'Sponsor' &&
        curr.sponsorName !== 'Sponsor'
      ) {
        prev.sponsorName = curr.sponsorName;
      }
    } else {
      merged.push(curr);
    }
  }

  return merged;
}

export const DEFAULT_AI_MODEL = 'nvidia/nemotron-3.5-super-vl-120b-a12b';

export const GROQ_MODEL_FAILOVER_CHAIN = [
  'nvidia/nemotron-3.5-super-vl-120b-a12b',
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b',
  'openai/gpt-oss-20b',
];
const GROQ_TIMEOUT_MS = 14000;
const NVIDIA_TIMEOUT_MS = 24000;

export function isNvidiaModel(model: string): boolean {
  return typeof model === 'string' && model.toLowerCase().startsWith('nvidia/');
}

async function callGroqChatCompletion(params: {
  apiKey: string;
  nvidiaApiKey?: string;
  groqApiKey?: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  timeoutMs?: number;
}): Promise<string> {
  const useNvidia = isNvidiaModel(params.model);
  const endpoint = useNvidia
    ? 'https://integrate.api.nvidia.com/v1/chat/completions'
    : 'https://api.groq.com/openai/v1/chat/completions';

  const effectiveKey = useNvidia
    ? params.nvidiaApiKey || params.apiKey
    : params.groqApiKey || params.apiKey;

  const requestBody: Record<string, any> = {
    model: params.model,
    messages: [
      { role: 'system', content: params.systemPrompt },
      { role: 'user', content: params.userPrompt },
    ],
    temperature: 0.1,
  };

  if (useNvidia) {
    requestBody.max_tokens = 1200;
    requestBody.chat_template_kwargs = { enable_thinking: false };
  } else {
    requestBody.response_format = { type: 'json_object' };
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${effectiveKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(
      params.timeoutMs ?? (useNvidia ? NVIDIA_TIMEOUT_MS : GROQ_TIMEOUT_MS)
    ),
  });

  if (!response.ok) {
    const errText = await response.text();
    const providerLabel = useNvidia ? 'NVIDIA API' : 'Groq API';
    const error = new Error(`${providerLabel} error (${response.status}): ${errText}`) as Error & {
      status?: number;
    };
    error.status = response.status;
    throw error;
  }

  const data = (await response.json()) as any;
  return data?.choices?.[0]?.message?.content || '{}';
}

/**
 * Compacts/truncates a userPrompt when Groq returns HTTP 413 or a token-limit error,
 * preserving metadata headers and sponsor transition windows while fitting strictly under the token budget.
 */
export function shrinkUserPromptForRetry(
  userPrompt: string,
  customMaxChars?: number,
  customMaxTokens?: number
): string {
  if (!userPrompt) return '';

  const targetMaxChars =
    customMaxChars ?? Math.min(5500, Math.max(80, Math.floor(userPrompt.length * 0.5)));
  const targetMaxTokens =
    customMaxTokens ??
    Math.min(2000, Math.max(40, Math.floor(estimateTokens(userPrompt) * 0.5)));

  const selectLinesWithinBudget = (
    lines: string[],
    charBudget: number,
    tokenBudget: number
  ): string => {
    const coreIndices: number[] = [];
    const priorityIndices = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
      if (SPONSOR_TRANSITION_REGEX.test(lines[i])) {
        for (const offset of [0, 1, 2, -1]) {
          const k = i + offset;
          if (k >= 0 && k < lines.length) {
            coreIndices.push(k);
          }
        }
        const startIdx = Math.max(0, i - 2);
        const endIdx = Math.min(lines.length - 1, i + 6);
        for (let k = startIdx; k <= endIdx; k++) {
          priorityIndices.add(k);
        }
      }
    }

    const introOutroIndices = new Set<number>();
    for (let i = 0; i < Math.min(5, lines.length); i++) introOutroIndices.add(i);
    for (let i = Math.max(0, lines.length - 4); i < lines.length; i++) introOutroIndices.add(i);

    const selected = new Set<number>();
    let usedChars = 0;
    let usedTokens = 0;

    const tryAdd = (idx: number): boolean => {
      if (selected.has(idx)) return true;
      const line = lines[idx];
      const sep = selected.size > 0 ? 1 : 0;
      const len = line.length + sep;
      const tokens = estimateTokens(line) + sep;
      if (usedChars + len <= charBudget && usedTokens + tokens <= tokenBudget) {
        selected.add(idx);
        usedChars += len;
        usedTokens += tokens;
        return true;
      }
      return false;
    };

    for (const idx of coreIndices) {
      tryAdd(idx);
    }
    for (const idx of Array.from(priorityIndices).sort((a, b) => a - b)) {
      tryAdd(idx);
    }
    for (const idx of Array.from(introOutroIndices).sort((a, b) => a - b)) {
      tryAdd(idx);
    }
    for (let i = 0; i < lines.length; i++) {
      if (selected.has(i)) continue;
      if (!tryAdd(i)) break;
    }

    if (selected.size === 0 && lines.length > 0) {
      let sliced = lines[0].slice(0, Math.max(20, charBudget));
      while (sliced.length > 20 && estimateTokens(sliced) > tokenBudget) {
        sliced = sliced.slice(0, Math.floor(sliced.length * 0.75));
      }
      return sliced;
    }

    return Array.from(selected)
      .sort((a, b) => a - b)
      .map((idx) => lines[idx])
      .join('\n');
  };

  const marker = 'Timestamped Transcript ([start_sec - end_sec] text):';
  const markerIdx = userPrompt.indexOf(marker);

  if (markerIdx !== -1) {
    const rawPrefix = userPrompt.slice(0, markerIdx).trimEnd();
    const rawHeader = userPrompt.slice(0, markerIdx + marker.length);
    const maxHeaderChars = Math.min(
      1200,
      Math.max(marker.length + 10, Math.floor(targetMaxChars * 0.35))
    );
    const maxHeaderTokens = Math.min(
      450,
      Math.max(estimateTokens(marker) + 5, Math.floor(targetMaxTokens * 0.35))
    );

    let header = rawHeader;
    if (header.length > maxHeaderChars || estimateTokens(header) > maxHeaderTokens) {
      let prefixSlice = rawPrefix.slice(
        0,
        Math.max(0, maxHeaderChars - marker.length - 1)
      );
      while (
        prefixSlice.length > 0 &&
        estimateTokens(`${prefixSlice}\n${marker}`) > maxHeaderTokens
      ) {
        prefixSlice = prefixSlice.slice(0, Math.floor(prefixSlice.length * 0.75));
      }
      header = prefixSlice.length > 0 ? `${prefixSlice}\n${marker}` : marker;
    }

    const body = userPrompt.slice(markerIdx + marker.length).replace(/^\r?\n/, '');
    const headerTokens = estimateTokens(header) + 1;
    const remChars = Math.max(20, targetMaxChars - header.length - 1);
    const remTokens = Math.max(15, targetMaxTokens - headerTokens);

    const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const compactedBody = selectLinesWithinBudget(lines, remChars, remTokens);
    return `${header}\n${compactedBody}`;
  }

  const lines = userPrompt.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length > 1) {
    const compacted = selectLinesWithinBudget(lines, targetMaxChars, targetMaxTokens);
    if (compacted.length < userPrompt.length) {
      return compacted;
    }
  }

  let sliced = userPrompt.slice(0, targetMaxChars);
  while (sliced.length > 20 && estimateTokens(sliced) > targetMaxTokens) {
    sliced = sliced.slice(0, Math.floor(sliced.length * 0.75));
  }
  return sliced;
}

export async function callGroqWithRetry(params: {
  apiKey: string;
  nvidiaApiKey?: string;
  groqApiKey?: string;
  primaryModel: string;
  systemPrompt: string;
  userPrompt: string;
  maxRetries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
}): Promise<{ content: string; usedModel: string; actualModel?: string }> {
  const maxRetries = params.maxRetries ?? 3;
  const baseDelayMs = params.baseDelayMs ?? 150;
  let lastError: any = null;

  // Build deduplicated failover chain starting with primaryModel -> GROQ_MODEL_FAILOVER_CHAIN
  const modelChain = Array.from(
    new Set([params.primaryModel, ...GROQ_MODEL_FAILOVER_CHAIN])
  );
  let totalAttempts = Math.max(maxRetries, modelChain.length);
  let modelIndex = 0;
  let hasRetriedPrimaryAfterShrink = false;
  let currentUserPrompt = params.userPrompt;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    const candidateModel = modelChain[Math.min(modelIndex, modelChain.length - 1)];

    // If failing over from a large-context NVIDIA model to a Groq model (8K TPM limit),
    // proactively bound the prompt so Groq doesn't reject with HTTP 413.
    const promptForAttempt =
      !isNvidiaModel(candidateModel) &&
      (currentUserPrompt.length > 11500 || estimateTokens(currentUserPrompt) > 3600)
        ? shrinkUserPromptForRetry(currentUserPrompt, 11000, 3500)
        : currentUserPrompt;

    try {
      const content = await callGroqChatCompletion({
        apiKey: params.apiKey,
        nvidiaApiKey: params.nvidiaApiKey,
        groqApiKey: params.groqApiKey,
        model: candidateModel,
        systemPrompt: params.systemPrompt,
        userPrompt: promptForAttempt,
        timeoutMs: params.timeoutMs,
      });
      return {
        content,
        usedModel: params.primaryModel,
        actualModel: candidateModel,
      };
    } catch (err: any) {
      lastError = err;
      const status = err?.status;
      const errMsg = String(err?.message || '');

      // Never retry invalid API keys / auth errors unless switching provider with a distinct fallback key
      if (status === 401 || status === 403) {
        const hasAlternateProviderKey =
          isNvidiaModel(candidateModel) &&
          Boolean(params.groqApiKey && params.groqApiKey !== params.nvidiaApiKey);
        if (!hasAlternateProviderKey) {
          throw err;
        }
      }

      const isTokenLimitError =
        status === 413 ||
        /request too large|input tokens per minute|\bitpm\b|\btpm\b|reduce your message size|context_length_exceeded|maximum context length|prompt is too long|too many tokens/i.test(
          errMsg
        );

      const isModelFailoverOrRetryable =
        isTokenLimitError ||
        status === 400 ||
        status === 401 ||
        status === 403 ||
        status === 404 ||
        status === 429 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        err?.name === 'TimeoutError' ||
        err?.name === 'AbortError' ||
        /over capacity|rate limit|timeout|fetch failed|model.*not.*found|decommissioned|unavailable/i.test(
          errMsg
        );

      if (!isModelFailoverOrRetryable) {
        throw err;
      }

      let isSwitchingModel = false;
      if (isTokenLimitError) {
        currentUserPrompt = shrinkUserPromptForRetry(currentUserPrompt);
        if (modelIndex === 0 && !hasRetriedPrimaryAfterShrink) {
          hasRetriedPrimaryAfterShrink = true;
          totalAttempts = Math.max(totalAttempts, modelChain.length + 1);
        } else {
          const nextModelIndex = Math.min(modelIndex + 1, modelChain.length - 1);
          isSwitchingModel = nextModelIndex !== modelIndex;
          modelIndex = nextModelIndex;
        }
      } else {
        const nextModelIndex = Math.min(modelIndex + 1, modelChain.length - 1);
        isSwitchingModel = nextModelIndex !== modelIndex;
        modelIndex = nextModelIndex;
      }

      if (attempt < totalAttempts - 1) {
        // When switching to a different healthy fallback model or retrying with shrunk prompt, do not stall
        const delay =
          isSwitchingModel || isTokenLimitError
            ? Math.min(baseDelayMs, 25)
            : baseDelayMs * Math.pow(2, attempt);
        if (delay > 0) {
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
  }

  throw lastError || new Error('AI API request failed after retries');
}

/**
 * Calls NVIDIA NIM (`nvidia/nemotron-3.5-super-vl-120b-a12b`) with automatic Groq failover
 * (`openai/gpt-oss-120b` -> `qwen/qwen3.8-27b` -> `openai/gpt-oss-20b`) to detect sponsorship segments.
 */
export async function analyzeWithGroq(
  input: AnalyzeVideoInput
): Promise<AnalyzeVideoResult> {
  const model =
    process.env.NVIDIA_MODEL ||
    process.env.GROQ_MODEL ||
    DEFAULT_AI_MODEL;
  const nvidiaApiKey = process.env.NVIDIA_API_KEY;
  const groqApiKey = process.env.GROQ_API_KEY;
  const apiKey = isNvidiaModel(model)
    ? nvidiaApiKey || groqApiKey
    : groqApiKey || nvidiaApiKey;

  const brandKeywords = extractBrandKeywordsFromDescription(input.description);
  const useLargeContext = isNvidiaModel(model);
  const transcriptMaxChars = useLargeContext ? 48000 : 11000;
  const transcriptMaxTokens = useLargeContext ? 16000 : 3800;

  // Build compacted transcript string from whichever input format was provided
  let transcriptText = '';
  if (typeof input.transcript === 'string') {
    transcriptText = input.transcript.trim();
    if (
      transcriptText.length > transcriptMaxChars ||
      estimateTokens(transcriptText) > transcriptMaxTokens
    ) {
      transcriptText = shrinkUserPromptForRetry(
        transcriptText,
        transcriptMaxChars,
        transcriptMaxTokens
      );
    }
  } else if (Array.isArray(input.transcript) && input.transcript.length > 0) {
    transcriptText = compactTranscript(
      input.transcript,
      8,
      transcriptMaxChars,
      transcriptMaxTokens,
      brandKeywords
    );
  } else if (Array.isArray(input.json3Events) && input.json3Events.length > 0) {
    const cues = parseJson3ToCues(input.json3Events);
    transcriptText = compactTranscript(
      cues,
      8,
      transcriptMaxChars,
      transcriptMaxTokens,
      brandKeywords
    );
  }

  const chapterSegments = detectSponsorFromChapters(
    input.chapters,
    input.duration,
    input.description
  );

  // If there is no transcript at all, fall back to chapter segments if any
  if (!transcriptText) {
    return {
      hasSponsors: chapterSegments.length > 0,
      segments: chapterSegments,
      model,
      source: chapterSegments.length > 0 ? 'chapters' : 'groq_ai',
      hasTranscript: false,
    };
  }

  if (!apiKey) {
    throw new Error('Neither NVIDIA_API_KEY nor GROQ_API_KEY is configured');
  }

  const descriptionHints = extractDescriptionHints(input.description);
  const chapterHints =
    Array.isArray(input.chapters) && input.chapters.length > 0
      ? input.chapters
          .slice(0, 30)
          .map((c) => `[${c.startTime}s] ${String(c.title || '').slice(0, 100)}`)
          .join('\n')
      : 'None';

  const systemPrompt = `You are a high-precision YouTube Sponsorship & Ad-Read Segment Detector.
Your job is to analyze a timestamped video transcript along with video metadata (title, channel, description links, brand candidates, and chapters) and identify exact start and end timestamps (in seconds) for any in-video paid sponsorship reads or creator self-promotions (merch/courses/Patreon/app/newsletter plugs).

CRITICAL DETECTION RULES:
1. Flag ALL paid sponsor segments AND explicit creator self-promotion segments:
   - Explicit transitions: "This video is sponsored by...", "Brought to you by...", "Thanks to [Brand]...", "Partnered with...".
   - Organic / Narrative Segues (HIGH PRIORITY): Creators frequently transition into a sponsor pitch using a 3-10 second relatable problem or story hook BEFORE naming the brand (e.g., "When you're working late, the last thing you want to do is cook dinner. That's why I use Factor..." or "Speaking of security, hackers can intercept your Wi-Fi...").
   - You MUST include that initial narrative pivot / problem-hook sentence in \`startTime\`—do NOT wait until the brand name is spoken to start the segment!
2. Cross-Reference Description Links & Brand Candidates:
   - Check the "Detected Brand Candidates from Description" and "Description Links & Promo Hints".
   - If ANY of those brands/products/domains (or phonetically similar ASR spellings) is pitched in the transcript with benefits + a Call-To-Action (link in description, QR code, promo/coupon code, free trial, % off, sign up), it IS a sponsor segment even if the creator never uses the literal word "sponsor".
   - If "Paid Promotion Flag: YES" is present, the creator officially declared a paid promotion—search carefully for both subtle and explicit brand pitches.
3. Multilingual & Regional Creator Support:
   - The transcript may be in English, auto-translated English from a regional language (e.g., Tamil/Tanglish, Hindi/Hinglish, Telugu, Spanish), or native script.
   - Watch for conversational transitions like "Before going into the video, let's see about [Brand]...", "If you want to learn/buy/register, check the link in the description below", "Indha video sponsor...", "Keela description la link iruku".
4. Exact End Boundary (\`endTime\`):
   - \`endTime\` MUST be the exact timestamp where the Call-To-Action finishes and the creator returns to the main video topic (e.g., "Now back to the video", "Anyway, let's look at...", or when the main tutorial/story resumes).
5. Avoid False Positives:
   - Do NOT flag normal editorial content where the entire video is an organic review/news story about a company (e.g., a news video about Microsoft layoffs is NOT sponsored by Microsoft), or brief 2-second thank-yous without an ad pitch.
6. Return ONLY a valid JSON object matching this exact schema:
{
  "analysis": "Brief 1-2 sentence check of description brand candidates, paid promo flag, and exact start/end transition timestamps found in transcript",
  "hasSponsors": boolean,
  "segments": [
    {
      "startTime": number,
      "endTime": number,
      "sponsorName": string,
      "category": "sponsor" | "selfpromo",
      "confidence": number,
      "reason": string
    }
  ]
}`;

  const paidPromoLine = input.hasPaidPromotion
    ? '\nPaid Promotion Flag: YES (Creator marked this video as including paid promotion)'
    : '';
  const brandCandidatesLine =
    brandKeywords.length > 0 ? `\nDetected Brand Candidates from Description: ${brandKeywords.join(', ')}` : '';

  let userPrompt = `Video ID: ${input.videoId}
Title: ${String(input.title || 'Unknown').slice(0, 200)}
Channel: ${String(input.channelName || 'Unknown').slice(0, 120)}
Duration: ${input.duration ? `${input.duration}s` : 'Unknown'}${paidPromoLine}${brandCandidatesLine}

Description Links & Promo Hints:
${descriptionHints.length > 0 ? descriptionHints.map((h) => `- ${h}`).join('\n') : 'None'}

Video Chapters:
${chapterHints}

Timestamped Transcript ([start_sec - end_sec] text):
${transcriptText}`;

  const maxTotalInputTokens = useLargeContext ? 18000 : 4500;
  const maxPromptChars = useLargeContext ? 52000 : 12000;
  const maxUserTokens = Math.max(1500, maxTotalInputTokens - estimateTokens(systemPrompt));
  if (userPrompt.length > maxPromptChars || estimateTokens(userPrompt) > maxUserTokens) {
    userPrompt = shrinkUserPromptForRetry(
      userPrompt,
      maxPromptChars - 500,
      maxUserTokens
    );
  }

  const { content, usedModel } = await callGroqWithRetry({
    apiKey,
    nvidiaApiKey,
    groqApiKey,
    primaryModel: model,
    systemPrompt,
    userPrompt,
  });

  const parsed = extractJsonFromModelOutput(content);

  const validatedSegments = validateAndNormalizeSegments(
    Array.isArray(parsed?.segments) ? parsed.segments : [],
    input.duration
  );

  // If chapters also had explicit sponsor segments that don't overlap, merge them
  const combinedSegments =
    chapterSegments.length > 0
      ? validateAndNormalizeSegments(
          [...validatedSegments, ...chapterSegments],
          input.duration
        )
      : validatedSegments;

  return {
    hasSponsors: combinedSegments.length > 0,
    segments: combinedSegments,
    model: usedModel,
    source: 'groq_ai',
    hasTranscript: true,
  };
}
