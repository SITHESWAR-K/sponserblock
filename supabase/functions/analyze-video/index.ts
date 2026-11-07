import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-groq-api-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const DEFAULT_GROQ_MODEL = "qwen/qwen3.8-27b";
const GROQ_MODEL_FAILOVER_CHAIN = [
  "qwen/qwen3.8-27b",
  "qwen/qwen3-32b",
  "llama-3.3-70b-versatile",
];

const SPONSOR_TRANSITION_REGEX =
  /(\b(?:sponsor(?:ed|ship)?|brought to you by|thanks to|special thanks|today'?s video is|partnered with|paid promotion|ad\s*read|use code|promo code|coupon code|discount|%\s*off|free trial|link (?:is )?(?:given )?in (?:the )?description|click the link|pinned comment|check out|sign up at|before (?:going|we go|entering|jumping) into the video|back to the video|let'?s get back|let'?s (?:go|get) into the video|now back to|onto the video|indha video(?:va|oda)?|videokulla|description[-\s]*la|comment[-\s]*la|keela description|is video ke)\b|ஸ்பான்சர்|விளம்பரம்|டிஸ்கிரிப்ஷன்|லிங்க|கூப்பன்|ஆஃபர்|ஆபர்|டிஸ்கவுண்ட்|வீடியோக்குள்ள|स्पॉन्सर|डिस्क्रिप्शन|लिंक|कूपन|डिस्काउंट)/i;

const DESCRIPTION_PROMO_REGEX =
  /(https?:\/\/[^\s]+|[a-z0-9-]+\.(?:com|io|gg|co|org|net|deals|tv|app|in|ai)\/[^\s]+|\b(?:sponsor|code|coupon|discount|%\s*off|free trial|brought to you by|partner|merch|paid promotion)\b)/i;

const CHAPTER_SPONSOR_REGEX =
  /\b(sponsor(?:ed|ship)?|paid promotion|ad\s*read|partner(?:ship)?|brought to you by)\b/i;

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
  maxTokens = 3800
): string {
  if (!Array.isArray(cues) || cues.length === 0) return "";
  const normalized = cues
    .filter((c) => c && typeof c.start === "number" && !Number.isNaN(c.start) && typeof c.text === "string" && c.text.trim())
    .sort((a, b) => a.start - b.start);
  if (normalized.length === 0) return "";

  const blocks: Array<{ line: string; hasTransition: boolean }> = [];
  let blockStart = normalized[0].start;
  let blockEnd = normalized[0].end ?? (normalized[0].start + (normalized[0].duration || 3.0));
  let blockTexts: string[] = [normalized[0].text.trim().slice(0, 600)];
  let blockHasTransition = SPONSOR_TRANSITION_REGEX.test(normalized[0].text);

  const flush = () => {
    if (!blockTexts.length) return;
    const combined = blockTexts.join(" ");
    blocks.push({
      line: `[${Math.max(0, blockStart).toFixed(1)} - ${Math.max(blockStart + 0.5, blockEnd).toFixed(1)}] ${combined}`,
      hasTransition: blockHasTransition || SPONSOR_TRANSITION_REGEX.test(combined),
    });
    blockTexts = [];
    blockHasTransition = false;
  };

  for (let i = 1; i < normalized.length; i++) {
    const cue = normalized[i];
    const cueText = cue.text.trim().slice(0, 600);
    const next = normalized[i + 1];
    const cueEnd = cue.end ?? (cue.duration ? cue.start + cue.duration : next && next.start > cue.start ? next.start : cue.start + 3.0);
    const isTransition = SPONSOR_TRANSITION_REGEX.test(cueText);
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
      for (let k = Math.max(0, i - 2); k <= Math.min(blocks.length - 1, i + 8); k++) {
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
    if (Number.isNaN(confidence) || confidence < 0.55) continue;
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
    if (prev && curr.startTime <= prev.endTime + 2.0) {
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

function detectSponsorFromChapters(chapters?: any[], duration?: number) {
  if (!Array.isArray(chapters) || chapters.length === 0) return [];
  const sorted = [...chapters]
    .filter((c) => c && typeof c.startTime === "number" && typeof c.title === "string")
    .sort((a, b) => a.startTime - b.startTime);
  const rawSegments: any[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const ch = sorted[i];
    if (CHAPTER_SPONSOR_REGEX.test(ch.title)) {
      const nextCh = sorted[i + 1];
      const endTime =
        typeof ch.endTime === "number" && ch.endTime > ch.startTime
          ? ch.endTime
          : nextCh
          ? nextCh.startTime
          : duration ?? ch.startTime + 60;
      const cleanedSponsor = ch.title
        .replace(CHAPTER_SPONSOR_REGEX, "")
        .replace(/[:\-–—|()\[\]]/g, " ")
        .trim();
      rawSegments.push({
        startTime: ch.startTime,
        endTime,
        sponsorName: cleanedSponsor || "Sponsor",
        category: "sponsor",
        confidence: 0.92,
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
    throw new Error("Failed to parse JSON object from Groq model output");
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
  primaryModel: string;
  systemPrompt: string;
  userPrompt: string;
}): Promise<{ content: string; usedModel: string }> {
  const callSingle = async (model: string, currentPrompt: string) => {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: params.systemPrompt },
          { role: "user", content: currentPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      const errText = await res.text();
      const err: any = new Error(`Groq API failed (${res.status}): ${errText}`);
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
    try {
      const content = await callSingle(candidateModel, currentUserPrompt);
      return { content, usedModel: params.primaryModel };
    } catch (err: any) {
      lastErr = err;
      const status = err?.status;
      const errMsg = String(err?.message || "");
      if (status === 401 || status === 403) throw err;

      const isTokenLimitError =
        status === 413 ||
        /request too large|input tokens per minute|\bitpm\b|reduce your message size|context_length_exceeded|maximum context length|prompt is too long|too many tokens/i.test(
          errMsg
        );

      const retryable =
        isTokenLimitError ||
        status === 400 ||
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

  throw lastErr || new Error("Groq API failed after retries");
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

    const groqModel = Deno.env.get("GROQ_MODEL") || DEFAULT_GROQ_MODEL;
    const groqApiKey =
      Deno.env.get("GROQ_API_KEY") ||
      req.headers.get("x-groq-api-key") ||
      "";

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
        if (existing.analyzed) {
          return new Response(JSON.stringify(existing), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      const duration =
        typeof body.duration === "number" && body.duration > 0
          ? body.duration
          : Number(body.duration) || undefined;

      let transcriptText = "";
      if (typeof body.transcript === "string") {
        transcriptText = body.transcript.trim();
        if (transcriptText.length > 11000 || estimateTokens(transcriptText) > 3800) {
          transcriptText = shrinkUserPromptForRetry(transcriptText, 11000, 3800);
        }
      } else if (Array.isArray(body.transcript) && body.transcript.length > 0) {
        transcriptText = compactTranscript(body.transcript);
      } else if (Array.isArray(body.json3Events) && body.json3Events.length > 0) {
        transcriptText = compactTranscript(parseJson3ToCues(body.json3Events));
      }

      const chapterSegments = detectSponsorFromChapters(body.chapters, duration);

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
        .slice(0, 20)
        .map((l) => l.slice(0, 240));

      const chapterHints =
        Array.isArray(body.chapters) && body.chapters.length > 0
          ? body.chapters
              .slice(0, 30)
              .map((c: any) => `[${c.startTime}s] ${String(c.title || "").slice(0, 100)}`)
              .join("\n")
          : "None";

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

      const paidPromoLine = body.hasPaidPromotion
        ? "\nPaid Promotion Flag: YES (Creator marked this video as including paid promotion)"
        : "";

      let userPrompt = `Video ID: ${videoId}
Title: ${String(body.title || "Unknown").slice(0, 200)}
Channel: ${String(body.channelName || "Unknown").slice(0, 120)}
Duration: ${duration ? `${duration}s` : "Unknown"}${paidPromoLine}

Description Links & Promo Hints:
${descriptionHints.length > 0 ? descriptionHints.map((h) => `- ${h}`).join("\n") : "None"}

Video Chapters:
${chapterHints}

Timestamped Transcript ([start_sec - end_sec] text):
${transcriptText}`;

      const maxTotalInputTokens = 4500;
      const maxUserTokens = Math.max(1500, maxTotalInputTokens - estimateTokens(systemPrompt));
      if (userPrompt.length > 12000 || estimateTokens(userPrompt) > maxUserTokens) {
        userPrompt = shrinkUserPromptForRetry(userPrompt, 11500, maxUserTokens);
      }

      const { content, usedModel } = await callGroqChatWithRetry({
        apiKey: groqApiKey,
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
