-- 001_init_schema.sql
-- AI-Powered YouTube Sponsorship Blocker Schema

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.videos (
  video_id TEXT PRIMARY KEY CHECK (char_length(video_id) >= 5 AND char_length(video_id) <= 32),
  title TEXT,
  channel_name TEXT,
  duration NUMERIC CHECK (duration IS NULL OR duration >= 0),
  has_sponsors BOOLEAN NOT NULL DEFAULT false,
  source TEXT NOT NULL DEFAULT 'groq_ai' CHECK (source IN ('groq_ai', 'sponsorblock', 'chapters', 'manual')),
  analyzed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sponsor_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id TEXT NOT NULL REFERENCES public.videos(video_id) ON DELETE CASCADE,
  start_time NUMERIC NOT NULL CHECK (start_time >= 0),
  end_time NUMERIC NOT NULL CHECK (end_time > start_time),
  sponsor_name TEXT,
  category TEXT NOT NULL DEFAULT 'sponsor' CHECK (category IN ('sponsor', 'selfpromo', 'interaction')),
  confidence NUMERIC NOT NULL DEFAULT 0.9 CHECK (confidence >= 0 AND confidence <= 1),
  reason TEXT,
  upvotes INTEGER NOT NULL DEFAULT 0 CHECK (upvotes >= 0),
  downvotes INTEGER NOT NULL DEFAULT 0 CHECK (downvotes >= 0),
  is_hidden BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_segments_video_id
  ON public.sponsor_segments(video_id)
  WHERE is_hidden = false;

-- Enable Row Level Security
ALTER TABLE public.videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sponsor_segments ENABLE ROW LEVEL SECURITY;

-- Policies for public read and backend/extension write access
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'videos' AND policyname = 'Allow public read on videos'
  ) THEN
    CREATE POLICY "Allow public read on videos"
      ON public.videos FOR SELECT
      TO anon, authenticated
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'videos' AND policyname = 'Allow insert on videos'
  ) THEN
    CREATE POLICY "Allow insert on videos"
      ON public.videos FOR INSERT
      TO anon, authenticated
      WITH CHECK (char_length(video_id) >= 5 AND char_length(video_id) <= 32);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'videos' AND policyname = 'Allow update on videos'
  ) THEN
    CREATE POLICY "Allow update on videos"
      ON public.videos FOR UPDATE
      TO anon, authenticated
      USING (true)
      WITH CHECK (char_length(video_id) >= 5 AND char_length(video_id) <= 32);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'sponsor_segments' AND policyname = 'Allow public read on sponsor_segments'
  ) THEN
    CREATE POLICY "Allow public read on sponsor_segments"
      ON public.sponsor_segments FOR SELECT
      TO anon, authenticated
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'sponsor_segments' AND policyname = 'Allow insert on sponsor_segments'
  ) THEN
    CREATE POLICY "Allow insert on sponsor_segments"
      ON public.sponsor_segments FOR INSERT
      TO anon, authenticated
      WITH CHECK (end_time > start_time AND start_time >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'sponsor_segments' AND policyname = 'Allow update on sponsor_segments'
  ) THEN
    CREATE POLICY "Allow update on sponsor_segments"
      ON public.sponsor_segments FOR UPDATE
      TO anon, authenticated
      USING (true)
      WITH CHECK (end_time > start_time AND start_time >= 0);
  END IF;
END $$;

-- Atomic community voting RPC function
-- Increments upvotes/downvotes and hides segments flagged as inaccurate (downvotes >= 3 and downvotes > upvotes * 2)
CREATE OR REPLACE FUNCTION public.vote_segment(
  p_segment_id UUID,
  p_vote TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_segment public.sponsor_segments%ROWTYPE;
BEGIN
  IF p_vote NOT IN ('upvote', 'downvote') THEN
    RAISE EXCEPTION 'Invalid vote type: %. Must be upvote or downvote.', p_vote;
  END IF;

  UPDATE public.sponsor_segments
  SET
    upvotes = CASE WHEN p_vote = 'upvote' THEN upvotes + 1 ELSE upvotes END,
    downvotes = CASE WHEN p_vote = 'downvote' THEN downvotes + 1 ELSE downvotes END,
    is_hidden = CASE
      WHEN p_vote = 'downvote' AND (downvotes + 1) >= 3 AND (downvotes + 1) > (upvotes * 2) THEN true
      ELSE is_hidden
    END
  WHERE id = p_segment_id
  RETURNING * INTO v_segment;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Segment % not found', p_segment_id;
  END IF;

  RETURN jsonb_build_object(
    'id', v_segment.id,
    'videoId', v_segment.video_id,
    'upvotes', v_segment.upvotes,
    'downvotes', v_segment.downvotes,
    'isHidden', v_segment.is_hidden
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.vote_segment(UUID, TEXT) TO anon, authenticated, service_role;

-- Atomic save_video_analysis RPC function
CREATE OR REPLACE FUNCTION public.save_video_analysis(
  p_video_id TEXT,
  p_title TEXT DEFAULT NULL,
  p_channel_name TEXT DEFAULT NULL,
  p_duration NUMERIC DEFAULT NULL,
  p_has_sponsors BOOLEAN DEFAULT false,
  p_source TEXT DEFAULT 'groq_ai',
  p_segments JSONB DEFAULT '[]'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seg JSONB;
  v_saved_segments JSONB := '[]'::jsonb;
  v_inserted public.sponsor_segments%ROWTYPE;
BEGIN
  IF p_video_id IS NULL OR char_length(trim(p_video_id)) < 5 THEN
    RAISE EXCEPTION 'Invalid video_id';
  END IF;

  INSERT INTO public.videos (video_id, title, channel_name, duration, has_sponsors, source, analyzed_at)
  VALUES (
    p_video_id,
    p_title,
    p_channel_name,
    p_duration,
    COALESCE(p_has_sponsors, jsonb_array_length(COALESCE(p_segments, '[]'::jsonb)) > 0),
    COALESCE(p_source, 'groq_ai'),
    now()
  )
  ON CONFLICT (video_id) DO UPDATE SET
    title = COALESCE(EXCLUDED.title, public.videos.title),
    channel_name = COALESCE(EXCLUDED.channel_name, public.videos.channel_name),
    duration = COALESCE(EXCLUDED.duration, public.videos.duration),
    has_sponsors = EXCLUDED.has_sponsors,
    source = EXCLUDED.source,
    analyzed_at = now();

  UPDATE public.sponsor_segments
  SET is_hidden = true
  WHERE video_id = p_video_id AND is_hidden = false;

  IF p_segments IS NOT NULL AND jsonb_typeof(p_segments) = 'array' THEN
    FOR v_seg IN SELECT * FROM jsonb_array_elements(p_segments)
    LOOP
      INSERT INTO public.sponsor_segments (
        video_id,
        start_time,
        end_time,
        sponsor_name,
        category,
        confidence,
        reason
      )
      VALUES (
        p_video_id,
        (v_seg->>'startTime')::NUMERIC,
        (v_seg->>'endTime')::NUMERIC,
        COALESCE(v_seg->>'sponsorName', 'Sponsor'),
        COALESCE(v_seg->>'category', 'sponsor'),
        COALESCE((v_seg->>'confidence')::NUMERIC, 0.9),
        COALESCE(v_seg->>'reason', '')
      )
      RETURNING * INTO v_inserted;

      v_saved_segments := v_saved_segments || jsonb_build_array(
        jsonb_build_object(
          'id', v_inserted.id,
          'videoId', v_inserted.video_id,
          'startTime', v_inserted.start_time,
          'endTime', v_inserted.end_time,
          'sponsorName', v_inserted.sponsor_name,
          'category', v_inserted.category,
          'confidence', v_inserted.confidence,
          'reason', v_inserted.reason,
          'upvotes', v_inserted.upvotes,
          'downvotes', v_inserted.downvotes,
          'source', COALESCE(p_source, 'groq_ai')
        )
      );
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'videoId', p_video_id,
    'hasSponsors', COALESCE(p_has_sponsors, jsonb_array_length(v_saved_segments) > 0),
    'source', COALESCE(p_source, 'groq_ai'),
    'segments', v_saved_segments
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_video_analysis(TEXT, TEXT, TEXT, NUMERIC, BOOLEAN, TEXT, JSONB) TO anon, authenticated, service_role;
