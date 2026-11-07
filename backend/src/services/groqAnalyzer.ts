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
  /(\b(?:sponsor(?:ed|ship)?|brought to you by|thanks to|special thanks|today'?s video is|partnered with|paid promotion|ad\s*read|use code|promo code|coupon code|discount|%\s*off|free trial|link (?:is )?(?:given )?in (?:the )?description|click the link|pinned comment|check out|sign up at|before (?:going|we go|entering|jumping) into the video|back to the video|let'?s get back|let'?s (?:go|get) into the video|now back to|onto the video|indha video(?:va|oda)?|videokulla|description[-\s]*la|comment[-\s]*la|keela description|is video ke)\b|ஸ்பான்சர்|விளம்பரம்|டிஸ்கிரிப்ஷன்|லிங்க|கூப்பன்|ஆஃபர்|ஆபர்|டிஸ்கவுண்ட்|வீடியோக்குள்ள|स्पॉन्सर|डिस्क्रिप्शन|लिंक|कूपन|डिस्काउंट)/i;

const DESCRIPTION_PROMO_REGEX =
  /(https?:\/\/[^\s]+|[a-z0-9-]+\.(?:com|io|gg|co|org|net|deals|tv|app|in|ai)\/[^\s]+|\b(?:sponsor|code|coupon|discount|%\s*off|free trial|brought to you by|partner|merch|paid promotion)\b)/i;

const CHAPTER_SPONSOR_REGEX =
  /\b(sponsor(?:ed|ship)?|paid promotion|ad\s*read|partner(?:ship)?|brought to you by)\b/i;

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
  maxTokens = 3800
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

  const blocks: Array<{ line: string; hasTransition: boolean }> = [];
  let blockStart = normalized[0].start;
  let blockEnd =
    normalized[0].end ??
    normalized[0].start + (normalized[0].duration && normalized[0].duration > 0 ? normalized[0].duration : 3.0);
  let blockTexts: string[] = [normalized[0].text.trim().slice(0, 600)];
  let blockHasTransition = SPONSOR_TRANSITION_REGEX.test(normalized[0].text);

  const flushBlock = () => {
    if (blockTexts.length === 0) return;
    const s = Math.max(0, blockStart).toFixed(1);
    const e = Math.max(blockStart + 0.5, blockEnd).toFixed(1);
    const combinedText = blockTexts.join(' ');
    blocks.push({
      line: `[${s} - ${e}] ${combinedText}`,
      hasTransition: blockHasTransition || SPONSOR_TRANSITION_REGEX.test(combinedText),
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

    const isTransitionCue = SPONSOR_TRANSITION_REGEX.test(cueText);
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

  // Long video handling: prioritize windows around sponsor transition keywords [-2, +8 blocks],
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
      const startIdx = Math.max(0, i - 2);
      const endIdx = Math.min(blocks.length - 1, i + 8);
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

  // 1b. Expand to full [-2, +8] sponsor transition windows
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
    if (hints.length >= 20) {
      break;
    }
  }

  return hints;
}

/**
 * Checks if video chapters explicitly label a sponsor segment.
 */
export function detectSponsorFromChapters(
  chapters?: ChapterItem[],
  duration?: number
): DetectedSegment[] {
  if (!Array.isArray(chapters) || chapters.length === 0) {
    return [];
  }

  const sorted = [...chapters]
    .filter((c) => c && typeof c.startTime === 'number' && typeof c.title === 'string')
    .sort((a, b) => a.startTime - b.startTime);

  const rawSegments: any[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const ch = sorted[i];
    if (CHAPTER_SPONSOR_REGEX.test(ch.title)) {
      const nextCh = sorted[i + 1];
      const endTime =
        typeof ch.endTime === 'number' && ch.endTime > ch.startTime
          ? ch.endTime
          : nextCh
          ? nextCh.startTime
          : duration ?? ch.startTime + 60;

      const cleanedSponsor = ch.title
        .replace(CHAPTER_SPONSOR_REGEX, '')
        .replace(/[:\-–—|()\[\]]/g, ' ')
        .trim();

      rawSegments.push({
        startTime: ch.startTime,
        endTime,
        sponsorName: cleanedSponsor || 'Sponsor',
        category: 'sponsor',
        confidence: 0.92,
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

  // Strip Qwen/DeepSeek <think>...</think> reasoning blocks if present
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
    throw new Error('Failed to parse JSON object from Groq model output');
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

    // Ignore very low confidence guesses (< 0.55)
    if (confidence < 0.55) {
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

  // Sort by startTime ascending and merge overlapping or nearly-contiguous segments (< 2s gap)
  valid.sort((a, b) => a.startTime - b.startTime);

  const merged: DetectedSegment[] = [valid[0]];
  for (let i = 1; i < valid.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = valid[i];

    if (curr.startTime <= prev.endTime + 2.0) {
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

export const GROQ_MODEL_FAILOVER_CHAIN = [
  'qwen/qwen3.8-27b',
  'qwen/qwen3-32b',
  'llama-3.3-70b-versatile',
];
const GROQ_TIMEOUT_MS = 12000;

async function callGroqChatCompletion(params: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  timeoutMs?: number;
}): Promise<string> {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: params.model,
      messages: [
        { role: 'system', content: params.systemPrompt },
        { role: 'user', content: params.userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(params.timeoutMs ?? GROQ_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errText = await response.text();
    const error = new Error(`Groq API error (${response.status}): ${errText}`) as Error & {
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

  // Build deduplicated failover chain starting with primaryModel -> qwen/qwen3-32b -> llama-3.3-70b-versatile
  const modelChain = Array.from(
    new Set([params.primaryModel, ...GROQ_MODEL_FAILOVER_CHAIN])
  );
  let totalAttempts = Math.max(maxRetries, modelChain.length);
  let modelIndex = 0;
  let hasRetriedPrimaryAfterShrink = false;
  let currentUserPrompt = params.userPrompt;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    const candidateModel = modelChain[Math.min(modelIndex, modelChain.length - 1)];
    try {
      const content = await callGroqChatCompletion({
        apiKey: params.apiKey,
        model: candidateModel,
        systemPrompt: params.systemPrompt,
        userPrompt: currentUserPrompt,
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

      // Never retry invalid API keys / auth errors
      if (status === 401 || status === 403) {
        throw err;
      }

      const isTokenLimitError =
        status === 413 ||
        /request too large|input tokens per minute|\bitpm\b|reduce your message size|context_length_exceeded|maximum context length|prompt is too long|too many tokens/i.test(
          errMsg
        );

      const isModelFailoverOrRetryable =
        isTokenLimitError ||
        status === 400 ||
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

  throw lastError || new Error('Groq API request failed after retries');
}

/**
 * Calls Groq API (`qwen/qwen3.8-27b`) to detect sponsorship segments from timestamped captions + metadata.
 */
export async function analyzeWithGroq(
  input: AnalyzeVideoInput
): Promise<AnalyzeVideoResult> {
  const model = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';
  const apiKey = process.env.GROQ_API_KEY;

  // Build compacted transcript string from whichever input format was provided
  let transcriptText = '';
  if (typeof input.transcript === 'string') {
    transcriptText = input.transcript.trim();
    if (transcriptText.length > 11000 || estimateTokens(transcriptText) > 3800) {
      transcriptText = shrinkUserPromptForRetry(transcriptText, 11000, 3800);
    }
  } else if (Array.isArray(input.transcript) && input.transcript.length > 0) {
    transcriptText = compactTranscript(input.transcript);
  } else if (Array.isArray(input.json3Events) && input.json3Events.length > 0) {
    const cues = parseJson3ToCues(input.json3Events);
    transcriptText = compactTranscript(cues);
  }

  const chapterSegments = detectSponsorFromChapters(input.chapters, input.duration);

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
    throw new Error('GROQ_API_KEY is not configured');
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
Your job is to analyze a timestamped video transcript along with video metadata (title, channel, description links, and chapters) and identify exact start and end timestamps (in seconds) for any in-video paid sponsorship reads or creator self-promotions (merch/courses/Patreon/app plugs).

CRITICAL RULES:
1. Only flag actual paid sponsor segments ("This video is sponsored by...", "Brought to you by...", "Thanks to [Brand] for sponsoring...", product pitch + call-to-action / promo code / link in description) or explicit self-promotion segments.
2. Multilingual & Regional Creator Support: The transcript may be in English, auto-translated English from a regional language (e.g., Tamil/Tanglish, Hindi/Hinglish, Telugu, Spanish), or native script. In regional or auto-translated transcripts, sponsor transitions may be phrased conversationally (e.g., "Before going into the video, let's see about [Brand]...", "If you want to learn/buy/register, check the link in the description below", "Use coupon code..."). Cross-reference with Description Links & Promo Hints and any Paid Promotion Flag.
3. Do NOT flag normal editorial content, organic news/product discussion where the main video topic itself is about that company/news (e.g., a news video about Microsoft layoffs is NOT sponsored by Microsoft), or brief 2-second thank-yous without an ad pitch.
4. startTime MUST be the exact timestamp (in seconds) where the transition into the sponsor read begins.
5. endTime MUST be the exact timestamp (in seconds) where the sponsor read ends and the creator returns to the main video topic.
6. Cross-reference the Description Links/Promos to identify the exact brand name (e.g. Surfshark, NordVPN, Squarespace, Brilliant, Ground News, BetterHelp, Skillshare, Odoo, Scalar, Guvi, NextWave, PCBWay, etc.).
7. Return ONLY a valid JSON object matching this exact schema:
{
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

  let userPrompt = `Video ID: ${input.videoId}
Title: ${String(input.title || 'Unknown').slice(0, 200)}
Channel: ${String(input.channelName || 'Unknown').slice(0, 120)}
Duration: ${input.duration ? `${input.duration}s` : 'Unknown'}${paidPromoLine}

Description Links & Promo Hints:
${descriptionHints.length > 0 ? descriptionHints.map((h) => `- ${h}`).join('\n') : 'None'}

Video Chapters:
${chapterHints}

Timestamped Transcript ([start_sec - end_sec] text):
${transcriptText}`;

  const maxTotalInputTokens = 4500;
  const maxUserTokens = Math.max(1500, maxTotalInputTokens - estimateTokens(systemPrompt));
  if (userPrompt.length > 12000 || estimateTokens(userPrompt) > maxUserTokens) {
    userPrompt = shrinkUserPromptForRetry(userPrompt, 11500, maxUserTokens);
  }

  const { content, usedModel } = await callGroqWithRetry({
    apiKey,
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
