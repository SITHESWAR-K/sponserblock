import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-groq-api-key, x-nvidia-api-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const DEFAULT_AI_MODEL = "nvidia/nemotron-3.5-super-vl-120b-a12b";
const GROQ_MODEL_FAILOVER_CHAIN = [
  "nvidia/nemotron-3.5-super-vl-120b-a12b",
  "openai/gpt-oss-120b",
  "qwen/qwen3.8-27b",
  "openai/gpt-oss-20b",
];

function isNvidiaModel(model: string): boolean {
  return typeof model === "string" && model.toLowerCase().startsWith("nvidia/");
}

const SPONSOR_TRANSITION_REGEX =
  /(\b(?:sponsor(?:ed|ship)?|sponser(?:ed|ship)?|brought to you by|thanks to|thank you to|special thanks|huge thanks to|big thanks to|today'?s (?:video is|sponsor)|video sponsor|partnered with|paid promotion|ad\s*read|quick word from|portion of this video|segment of this video|support the channel|use code|promo code|coupon code|discount|%\s*off|free trial|money[-\s]*back guarantee|cancel anytime|scan the qr code|first \d+[\d,]* people|link (?:is )?(?:given )?(?:in|down in|below in) (?:the )?description|link below|use my link|use our link|click the link|pinned comment|check out|sign up at|download the app|before (?:going|we go|entering|jumping|diving) into the video|back to the video|let'?s get back|let'?s (?:go|get|dive|jump) into the video|now back to|onto the video|indha video(?:va|oda)?|videokulla|description[-\s]*la|comment[-\s]*la|keela description|link keela|check out pannunga|register pannunga|download pannunga|is video ke|link niche|description mein)\b|ஸ்பான்சர்|விளம்பரம்|டிஸ்கிரிப்ஷன்|லிங்க|கூப்பன்|ஆஃபர்|ஆபர்|டிஸ்கவுண்ட்|வீடியோக்குள்ள|स्पॉन्सर|डिस्क्रिप्शन|लिंक|कूपन|डिस्काउंट)/i;

const DESCRIPTION_PROMO_REGEX =
  /(https?:\/\/[^\s]+|[a-z0-9-]+\.(?:com|io|gg|co|org|net|deals|tv|app|in|ai|me|xyz|dev|shop|store|tech)\/[^\s]*|\b(?:sponsor(?:ed)?|sponser|code|coupon|discount|%\s*off|free trial|brought to you by|partner(?:ed)?|merch|paid promotion|special thanks|thanks to|check out)\b)/i;

const CHAPTER_SPONSOR_REGEX =
  /\b(sponsor(?:ed|ship)?|sponser(?:ed|ship)?|paid promotion|ad\s*read|partner(?:ship)?|brought to you by|thanks to|special thanks)\b/i;

const IGNORED_BRAND_DOMAINS = new Set([
  "youtube",
  "youtu",
  "google",
  "instagram",
  "twitter",
  "x",
  "facebook",
  "fb",
  "discord",
  "tiktok",
  "patreon",
  "github",
  "gitlab",
  "linkedin",
  "reddit",
  "twitch",
  "threads",
  "bsky",
  "mastodon",
  "telegram",
  "whatsapp",
  "spotify",
  "apple",
  "amzn",
  "amazon",
  "bit",
  "tinyurl",
  "linktr",
  "beacons",
  "ko-fi",
  "buymeacoffee",
  "substack",
  "medium",
  "wikipedia",
]);

function extractBrandKeywordsFromDescription(description?: string): string[] {
  if (!description || typeof description !== "string") return [];
  const keywords = new Set<string>();
  const urlRegex = /(?:https?:\/\/)?(?:www\.)?([a-z0-9-]{3,})\.(?:com|io|gg|co|org|net|deals|tv|app|in|ai|me|xyz|dev|shop|store|tech)(?:\/[^\s)]*)?/gi;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(description)) !== null) {
    const domainStem = match[1].toLowerCase().replace(/[^a-z0-9]/g, "");
    if (domainStem.length >= 3 && !IGNORED_BRAND_DOMAINS.has(domainStem)) {
      keywords.add(domainStem);
      const alphaStem = domainStem.replace(/\d+$/, "");
      if (alphaStem.length >= 4 && !IGNORED_BRAND_DOMAINS.has(alphaStem)) {
        keywords.add(alphaStem);
      }
    }
  }
  const brandPhraseRegex =
    /\b(?:sponsor(?:ed)? by|brought to you by|thanks to|partnered with|check out)\s+([A-Z][A-Za-z0-9.+_-]{2,24})/g;
  while ((match = brandPhraseRegex.exec(description)) !== null) {
    const candidate = match[1].toLowerCase().replace(/[^a-z0-9]/g, "");
    if (
      candidate.length >= 3 &&
      !IGNORED_BRAND_DOMAINS.has(candidate) &&
      !["our", "the", "this", "today", "my", "their", "new", "video"].includes(candidate)
    ) {
      keywords.add(candidate);
    }
  }
  return Array.from(keywords).slice(0, 15);
}

function textMatchesBrandKeywords(text: string, brandKeywords: string[]): boolean {
  if (!text || !Array.isArray(brandKeywords) || brandKeywords.length === 0) return false;
  const lower = text.toLowerCase();
  for (const kw of brandKeywords) {
    if (kw.length >= 3 && lower.includes(kw)) return true;
  }
  return false;
}

function parseJson3ToCues(events: any[]): any[] {
  if (!Array.isArray(events) || events.length === 0) return [];
  const rawCues: Array<{ start: number; duration?: number; text: string }> = [];
  for (const ev of events) {
    if (typeof ev?.tStartMs !== "number" || !Array.isArray(ev.segs)) continue;
    const rawText = ev.segs
      .map((s: any) => (typeof s?.utf8 === "string" ? s.utf8 : ""))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!rawText || /^[♪♫\s\[\]()]+$/.test(rawText)) continue;
    rawCues.push({
      start: Math.round((ev.tStartMs / 1000) * 100) / 100,
      duration:
        typeof ev.dDurationMs === "number" && ev.dDurationMs > 0
          ? Math.round((ev.dDurationMs / 1000) * 100) / 100
          : undefined,
      text: rawText,
    });
  }
  return rawCues.map((cue, idx) => {
    const nextCue = rawCues[idx + 1];
    const endSec =
      nextCue && nextCue.start > cue.start
        ? cue.duration
          ? Math.min(cue.start + cue.duration, nextCue.start)
          : nextCue.start
        : cue.start + (cue.duration ?? 3.0);
    const clampedEnd = Math.round(Math.max(endSec, cue.start + 0.5) * 100) / 100;
    return {
      start: cue.start,
      end: clampedEnd,
      duration: Math.round((clampedEnd - cue.start) * 100) / 100,
      text: cue.text,
    };
  });
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    tokens += text.charCodeAt(i) > 127 ? 1.5 : 0.35;
  }
  return Math.ceil(tokens);
}

function compactTranscript(
  cues: any[],
  windowSeconds = 8,
  maxChars = 11000,
  maxTokens = 3800,
  brandKeywords: string[] = []
): string {
  if (!Array.isArray(cues) || cues.length === 0) return "";
  const normalized = cues
    .filter((c) => c && typeof c.start === "number" && !Number.isNaN(c.start) && typeof c.text === "string" && c.text.trim())
    .sort((a, b) => a.start - b.start);
  if (normalized.length === 0) return "";

  const matchesSponsorSignal = (text: string): boolean =>
    SPONSOR_TRANSITION_REGEX.test(text) || textMatchesBrandKeywords(text, brandKeywords);

  const blocks: Array<{ line: string; hasTransition: boolean }> = [];
  let blockStart = normalized[0].start;
  let blockEnd = normalized[0].end ?? (normalized[0].start + (normalized[0].duration || 3.0));
  let blockTexts: string[] = [normalized[0].text.trim().slice(0, 600)];
  let blockHasTransition = matchesSponsorSignal(normalized[0].text);

  const flush = () => {
    if (!blockTexts.length) return;
    const combined = blockTexts.join(" ");
    blocks.push({
      line: `[${Math.max(0, blockStart).toFixed(1)} - ${Math.max(blockStart + 0.5, blockEnd).toFixed(1)}] ${combined}`,
      hasTransition: blockHasTransition || matchesSponsorSignal(combined),
    });
    blockTexts = [];
    blockHasTransition = false;
  };

  for (let i = 1; i < normalized.length; i++) {
    const cue = normalized[i];
    const cueText = cue.text.trim().slice(0, 600);
    const next = normalized[i + 1];
    const cueEnd = cue.end ?? (cue.duration ? cue.start + cue.duration : next && next.start > cue.start ? next.start : cue.start + 3.0);
    const isTransition = matchesSponsorSignal(cueText);
    if (isTransition || cueEnd - blockStart > windowSeconds) {
      if (cue.start > blockStart && cue.start < blockEnd + 2.0) blockEnd = cue.start;
      flush();
      blockStart = cue.start;
      blockEnd = cueEnd;
      blockTexts = [cueText];
      blockHasTransition = isTransition;
    } else {
      blockEnd = Math.max(blockEnd, cueEnd);
      blockTexts.push(cueText);
    }
  }
  flush();

  const fullText = blocks.map((b) => b.line).join("\n");
  if (fullText.length <= maxChars && estimateTokens(fullText) <= maxTokens) {
    return fullText;
  }

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
      for (let k = Math.max(0, i - 3); k <= Math.min(blocks.length - 1, i + 14); k++) {
        transitionWindowIndices.add(k);
      }
    }
  }

  const introOutroIndices = new Set<number>();
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

  for (const idx of transitionCoreIndices) {
    tryAddBlock(idx);
  }
  for (const idx of Array.from(transitionWindowIndices).sort((a, b) => a - b)) {
    tryAddBlock(idx);
  }
  for (const idx of Array.from(introOutroIndices).sort((a, b) => a - b)) {
    tryAddBlock(idx);
  }
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
    .join("\n");
}

function validateAndNormalizeSegments(rawSegments: any[], duration?: number) {
  if (!Array.isArray(rawSegments)) return [];
  const valid: any[] = [];
  for (const item of rawSegments) {
    if (!item || typeof item !== "object") continue;
    let startTime = Number(item?.startTime ?? item?.start_time ?? item?.start);
    let endTime = Number(item?.endTime ?? item?.end_time ?? item?.end);
    if (Number.isNaN(startTime) || Number.isNaN(endTime)) continue;
    startTime = Math.max(0, Math.round(startTime * 100) / 100);
    if (typeof duration === "number" && duration > 0) {
      endTime = Math.min(duration, Math.round(endTime * 100) / 100);
    } else {
      endTime = Math.round(endTime * 100) / 100;
    }
    if (endTime - startTime < 5) continue;
    const confidence = Math.max(0, Math.min(1, Number(item?.confidence ?? 0.85)));
    if (Number.isNaN(confidence) || confidence < 0.50) continue;
    const rawCategory = String(item?.category || "sponsor").toLowerCase();
    valid.push({
      startTime,
      endTime,
      sponsorName: String(item?.sponsorName || item?.sponsor_name || "Sponsor").trim().slice(0, 80),
      category: rawCategory === "selfpromo" || rawCategory === "interaction" ? rawCategory : "sponsor",
      confidence: Math.round(confidence * 100) / 100,
      reason: String(item?.reason || "Detected sponsor read").trim().slice(0, 300),
      source: item?.source || "groq_ai",
    });
  }
  valid.sort((a, b) => a.startTime - b.startTime);
  const merged: any[] = [];
  for (const curr of valid) {
    const prev = merged[merged.length - 1];
    if (prev && curr.startTime <= prev.endTime + 2.5) {
      prev.endTime = Math.max(prev.endTime, curr.endTime);
      prev.confidence = Math.max(prev.confidence, curr.confidence);
      if (prev.sponsorName === "Sponsor" && curr.sponsorName !== "Sponsor") {
        prev.sponsorName = curr.sponsorName;
      }
    } else {
      merged.push(curr);
    }
  }
  return merged;
}

function detectSponsorFromChapters(chapters?: any[], duration?: number, description?: string) {
  if (!Array.isArray(chapters) || chapters.length === 0) return [];
  const brandKeywords = extractBrandKeywordsFromDescription(description);
  const sorted = [...chapters]
    .filter((c) => c && typeof c.startTime === "number" && typeof c.title === "string")
    .sort((a, b) => a.startTime - b.startTime);
  const rawSegments: any[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const ch = sorted[i];
    const isExplicit = CHAPTER_SPONSOR_REGEX.test(ch.title);
    const matchedBrand = !isExplicit
      ? brandKeywords.find((kw) => {
          if (kw.length < 4) return false;
          const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          return new RegExp(`\\b${escaped}\\b`, "i").test(ch.title);
        })
      : undefined;

    if (isExplicit || matchedBrand) {
      const nextCh = sorted[i + 1];
      const endTime =
        typeof ch.endTime === "number" && ch.endTime > ch.startTime
          ? ch.endTime
          : nextCh
          ? nextCh.startTime
          : duration ?? ch.startTime + 60;
      const cleanedSponsor = isExplicit
        ? ch.title
            .replace(CHAPTER_SPONSOR_REGEX, "")
            .replace(/[:\-–—|()\[\]]/g, " ")
            .trim()
        : ch.title.trim();
      rawSegments.push({
        startTime: ch.startTime,
        endTime,
        sponsorName: cleanedSponsor || matchedBrand || "Sponsor",
        category: "sponsor",
        confidence: isExplicit ? 0.92 : 0.88,
        reason: `Explicitly marked in video chapter: "${ch.title}"`,
        source: "chapters",
      });
    }
  }
  return validateAndNormalizeSegments(rawSegments, duration);
}

function extractJsonFromModelOutput(rawContent: string): any {
  if (!rawContent || typeof rawContent !== "string") {
    return { hasSponsors: false, segments: [] };
  }
  const cleaned = rawContent
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    }
    throw new Error("Failed to parse JSON object from AI model output");
  }
}

function shrinkUserPromptForRetry(
  userPrompt: string,
  customMaxChars?: number,
  customMaxTokens?: number
): string {
  if (!userPrompt) return "";

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
      .join("\n");
  };

  const marker = "Timestamped Transcript ([start_sec - end_sec] text):";
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

    const body = userPrompt.slice(markerIdx + marker.length).replace(/^\r?\n/, "");
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

async function callGroqChatWithRetry(params: {
  apiKey: string;
  nvidiaApiKey?: string;
  groqApiKey?: string;
  primaryModel: string;
  systemPrompt: string;
  userPrompt: string;
}): Promise<{ content: string; usedModel: string }> {
  const callSingle = async (model: string, currentPrompt: string) => {
    const useNvidia = isNvidiaModel(model);
    const endpoint = useNvidia
      ? "https://integrate.api.nvidia.com/v1/chat/completions"
      : "https://api.groq.com/openai/v1/chat/completions";
    const effectiveKey = useNvidia
      ? params.nvidiaApiKey || params.apiKey
      : params.groqApiKey || params.apiKey;

    const reqBody: Record<string, any> = {
      model,
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: currentPrompt },
      ],
      temperature: 0.1,
    };

    if (useNvidia) {
      reqBody.max_tokens = 1200;
      reqBody.chat_template_kwargs = { enable_thinking: false };
    } else {
      reqBody.response_format = { type: "json_object" };
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${effectiveKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(reqBody),
      signal: AbortSignal.timeout(useNvidia ? 24000 : 14000),
    });
    if (!res.ok) {
      const errText = await res.text();
      const err: any = new Error(
        `${useNvidia ? "NVIDIA" : "Groq"} API failed (${res.status}): ${errText}`
      );
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    return String(data?.choices?.[0]?.message?.content || "{}");
  };

  const modelChain = Array.from(
    new Set([params.primaryModel, ...GROQ_MODEL_FAILOVER_CHAIN])
  );
  let totalAttempts = modelChain.length;
  let modelIndex = 0;
  let hasRetriedPrimaryAfterShrink = false;
  let currentUserPrompt = params.userPrompt;
  let lastErr: any = null;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    const candidateModel = modelChain[Math.min(modelIndex, modelChain.length - 1)];
    const promptForAttempt =
      !isNvidiaModel(candidateModel) &&
      (currentUserPrompt.length > 11500 || estimateTokens(currentUserPrompt) > 3600)
        ? shrinkUserPromptForRetry(currentUserPrompt, 11000, 3500)
        : currentUserPrompt;

    try {
      const content = await callSingle(candidateModel, promptForAttempt);
      return { content, usedModel: params.primaryModel };
    } catch (err: any) {
      lastErr = err;
      const status = err?.status;
      const errMsg = String(err?.message || "");
      if (status === 401 || status === 403) {
        const hasAlternateProviderKey =
          isNvidiaModel(candidateModel) &&
          Boolean(params.groqApiKey && params.groqApiKey !== params.nvidiaApiKey);
        if (!hasAlternateProviderKey) throw err;
      }

      const isTokenLimitError =
        status === 413 ||
        /request too large|input tokens per minute|\bitpm\b|\btpm\b|reduce your message size|context_length_exceeded|maximum context length|prompt is too long|too many tokens/i.test(
          errMsg
        );

      const retryable =
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
        err?.name === "TimeoutError" ||
        err?.name === "AbortError" ||
        /over capacity|rate limit|timeout|fetch failed|model.*not.*found|decommissioned|unavailable/i.test(
          errMsg
        );
      if (!retryable) throw err;

      if (isTokenLimitError) {
        currentUserPrompt = shrinkUserPromptForRetry(currentUserPrompt);
        if (modelIndex === 0 && !hasRetriedPrimaryAfterShrink) {
          hasRetriedPrimaryAfterShrink = true;
          totalAttempts = Math.max(totalAttempts, modelChain.length + 1);
        } else {
          modelIndex = Math.min(modelIndex + 1, modelChain.length - 1);
        }
      } else {
        modelIndex = Math.min(modelIndex + 1, modelChain.length - 1);
      }
    }
  }

  throw lastErr || new Error("AI API failed after retries");
}

async function lookupCachedVideo(supabase: any, videoId: string) {
  const { data: video } = await supabase
    .from("videos")
    .select("*")
    .eq("video_id", videoId)
    .maybeSingle();

  if (!video) {
    return {
      videoId,
      analyzed: false,
      hasSponsors: false,
      source: null,
      analyzedAt: null,
      duration: null,
      segments: [],
    };
  }

  const { data: rows } = await supabase
    .from("sponsor_segments")
    .select("*")
    .eq("video_id", videoId)
    .eq("is_hidden", false)
    .order("start_time", { ascending: true });

  const segments = (rows || []).map((row: any) => ({
    id: row.id,
    videoId: row.video_id,
    startTime: Number(row.start_time),
    endTime: Number(row.end_time),
    sponsorName: row.sponsor_name || "Sponsor",
    category: row.category || "sponsor",
    confidence: Number(row.confidence ?? 0.9),
    reason: row.reason || "",
    source: video.source || "groq_ai",
    upvotes: Number(row.upvotes ?? 0),
    downvotes: Number(row.downvotes ?? 0),
  }));

  return {
    videoId,
    analyzed: true,
    hasSponsors: Boolean(video.has_sponsors && segments.length > 0),
    source: video.source || "groq_ai",
    analyzedAt: video.analyzed_at,
    duration: video.duration !== null && video.duration !== undefined ? Number(video.duration) : null,
    segments,
    cached: true,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
      Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const groqModel =
      Deno.env.get("NVIDIA_MODEL") ||
      DEFAULT_AI_MODEL;
    const nvidiaApiKey =
      Deno.env.get("NVIDIA_API_KEY") ||
      req.headers.get("x-nvidia-api-key") ||
      "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";
    const groqApiKey =
      Deno.env.get("GROQ_API_KEY") ||
      req.headers.get("x-groq-api-key") ||
      "";
    const primaryApiKey = isNvidiaModel(groqModel)
      ? nvidiaApiKey || groqApiKey
      : groqApiKey || nvidiaApiKey;

    // 1. Health check
    if (req.method === "GET" && pathname.endsWith("/health")) {
      return new Response(
        JSON.stringify({
          status: "ok",
          runtime: "supabase-edge",
          model: groqModel,
          timestamp: new Date().toISOString(),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. GET /api/segments/:videoId or ?videoId=...
    const segMatch = pathname.match(/\/segments\/([^/]+)$/);
    const queryVideoId = url.searchParams.get("videoId");
    if (req.method === "GET" && (segMatch || queryVideoId)) {
      const videoId = decodeURIComponent(segMatch ? segMatch[1] : queryVideoId!).trim();
      if (!videoId || videoId.length < 5 || videoId.length > 32) {
        return new Response(JSON.stringify({ error: "Invalid videoId parameter" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const cached = await lookupCachedVideo(supabase, videoId);
      return new Response(JSON.stringify(cached), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. POST /api/vote
    if (req.method === "POST" && pathname.endsWith("/vote")) {
      const body = await req.json();
      if (!body?.segmentId || (body?.vote !== "upvote" && body?.vote !== "downvote")) {
        return new Response(JSON.stringify({ error: "Invalid segmentId or vote" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data, error } = await supabase.rpc("vote_segment", {
        p_segment_id: body.segmentId,
        p_vote: body.vote,
      });
      if (error) throw error;
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 4. POST /api/segments/sync-sponsorblock
    if (req.method === "POST" && pathname.endsWith("/sync-sponsorblock")) {
      const body = await req.json();
      const videoId = String(body?.videoId || "").trim();
      if (!videoId || videoId.length < 5 || videoId.length > 32) {
        return new Response(JSON.stringify({ error: "Missing or invalid videoId" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const normalized = validateAndNormalizeSegments(body.segments || [], body.duration);
      const { data, error } = await supabase.rpc("save_video_analysis", {
        p_video_id: videoId,
        p_title: body.title ?? null,
        p_channel_name: body.channelName ?? null,
        p_duration: body.duration ?? null,
        p_has_sponsors: normalized.length > 0,
        p_source: "sponsorblock",
        p_segments: normalized,
      });
      if (error) throw error;
      return new Response(
        JSON.stringify({
          videoId,
          analyzed: true,
          hasSponsors: normalized.length > 0,
          source: "sponsorblock",
          duration: body.duration ?? null,
          segments: data?.segments || [],
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 5. POST /api/analyze (default POST handler)
    if (req.method === "POST") {
      const body = await req.json();
      const videoId = String(body.videoId || "").trim();
      if (!videoId || videoId.length < 5 || videoId.length > 32) {
        return new Response(JSON.stringify({ error: "Invalid videoId" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (!body.forceRefresh) {
        const existing = await lookupCachedVideo(supabase, videoId);
        if (existing.analyzed && (existing.hasSponsors || !body.hasPaidPromotion)) {
          return new Response(JSON.stringify(existing), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      const duration =
        typeof body.duration === "number" && body.duration > 0
          ? body.duration
          : Number(body.duration) || undefined;

      const brandKeywords = extractBrandKeywordsFromDescription(body.description);
      const useLargeContext = isNvidiaModel(groqModel);
      const transcriptMaxChars = useLargeContext ? 48000 : 11000;
      const transcriptMaxTokens = useLargeContext ? 16000 : 3800;

      let transcriptText = "";
      if (typeof body.transcript === "string") {
        transcriptText = body.transcript.trim();
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
      } else if (Array.isArray(body.transcript) && body.transcript.length > 0) {
        transcriptText = compactTranscript(
          body.transcript,
          8,
          transcriptMaxChars,
          transcriptMaxTokens,
          brandKeywords
        );
      } else if (Array.isArray(body.json3Events) && body.json3Events.length > 0) {
        transcriptText = compactTranscript(
          parseJson3ToCues(body.json3Events),
          8,
          transcriptMaxChars,
          transcriptMaxTokens,
          brandKeywords
        );
      }

      const chapterSegments = detectSponsorFromChapters(
        body.chapters,
        duration,
        body.description
      );

      if (!transcriptText) {
        if (chapterSegments.length === 0) {
          // Do not poison Supabase cache as "analyzed & clean" when no captions/chapters exist yet
          return new Response(
            JSON.stringify({
              videoId,
              analyzed: false,
              hasSponsors: false,
              source: null,
              duration: duration ?? null,
              segments: [],
              model: groqModel,
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const { data } = await supabase.rpc("save_video_analysis", {
          p_video_id: videoId,
          p_title: body.title ?? null,
          p_channel_name: body.channelName ?? null,
          p_duration: duration ?? null,
          p_has_sponsors: true,
          p_source: "chapters",
          p_segments: chapterSegments,
        });
        return new Response(
          JSON.stringify({
            videoId,
            analyzed: true,
            hasSponsors: true,
            source: "chapters",
            duration: duration ?? null,
            segments: data?.segments || chapterSegments,
            model: groqModel,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const descriptionHints = String(body.description || "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && DESCRIPTION_PROMO_REGEX.test(l))
        .slice(0, 25)
        .map((l) => l.slice(0, 240));

      const chapterHints =
        Array.isArray(body.chapters) && body.chapters.length > 0
          ? body.chapters
              .slice(0, 30)
              .map((c: any) => `[${c.startTime}s] ${String(c.title || "").slice(0, 100)}`)
              .join("\n")
          : "None";

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

      const paidPromoLine = body.hasPaidPromotion
        ? "\nPaid Promotion Flag: YES (Creator marked this video as including paid promotion)"
        : "";
      const brandCandidatesLine =
        brandKeywords.length > 0
          ? `\nDetected Brand Candidates from Description: ${brandKeywords.join(", ")}`
          : "";

      let userPrompt = `Video ID: ${videoId}
Title: ${String(body.title || "Unknown").slice(0, 200)}
Channel: ${String(body.channelName || "Unknown").slice(0, 120)}
Duration: ${duration ? `${duration}s` : "Unknown"}${paidPromoLine}${brandCandidatesLine}

Description Links & Promo Hints:
${descriptionHints.length > 0 ? descriptionHints.map((h) => `- ${h}`).join("\n") : "None"}

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

      const { content, usedModel } = await callGroqChatWithRetry({
        apiKey: primaryApiKey,
        nvidiaApiKey,
        groqApiKey,
        primaryModel: groqModel,
        systemPrompt,
        userPrompt,
      });

      const parsed = extractJsonFromModelOutput(content);
      const groqSegments = validateAndNormalizeSegments(parsed?.segments || [], duration);
      const segments =
        chapterSegments.length > 0
          ? validateAndNormalizeSegments([...groqSegments, ...chapterSegments], duration)
          : groqSegments;

      const { data: saved, error: saveError } = await supabase.rpc("save_video_analysis", {
        p_video_id: videoId,
        p_title: body.title ?? null,
        p_channel_name: body.channelName ?? null,
        p_duration: duration ?? null,
        p_has_sponsors: segments.length > 0,
        p_source: "groq_ai",
        p_segments: segments,
      });

      if (saveError) throw saveError;

      return new Response(
        JSON.stringify({
          videoId,
          analyzed: true,
          hasSponsors: segments.length > 0,
          source: "groq_ai",
          duration: duration ?? null,
          model: usedModel,
          segments: saved?.segments || segments,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err?.message || "Internal error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
