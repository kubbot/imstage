/**
 * React driver for the authored Wukang playback.
 *
 * One autoplay, only while the story stage is both on screen and in a visible
 * document. This module owns the timers and the environment; the decision rules
 * live in `story.ts` (`nextPlaybackAction`) so every combination of hidden,
 * off-screen, manual and reduced-motion inputs is unit-tested.
 *
 * A manual pause is never auto-resumed; an environmental pause (off-screen or
 * hidden tab) resumes only when both conditions hold again. Every reset
 * (replay, language switch, scenario switch, unmount) clears the pending timer,
 * so no stale beat can resolve after the story changed.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  BEATS,
  HOST_VISIBLE_RATIO,
  STORY_LEAD_IN_MS,
  nextPlaybackAction,
  pauseReasonFor,
  storyCompleteFrame,
  storyFrame,
  type StoryFrame,
} from './story';

export type StoryStatus = 'idle' | 'playing' | 'paused' | 'done';
export type StoryPauseReason = 'manual' | 'offscreen' | 'hidden' | null;

export interface StoryPlaybackOptions {
  /** Changes whenever the language or scenario changes, which restarts the story. */
  storyKey: string;
  /** Reduced motion starts on the complete, static result and never autoplays. */
  reducedMotion: boolean;
  /** The visible stage element; autoplay waits until it is on screen. */
  hostRef: RefObject<HTMLElement | null>;
}

export interface StoryPlayback {
  frame: StoryFrame;
  status: StoryStatus;
  toggle: () => void;
  pause: () => void;
  resume: () => void;
  replay: () => void;
  showResult: () => void;
}

const LAST_BEAT = BEATS.length - 1;

export function useStoryPlayback({ storyKey, reducedMotion, hostRef }: StoryPlaybackOptions): StoryPlayback {
  const [status, setStatus] = useState<StoryStatus>(() => (reducedMotion ? 'done' : 'idle'));
  const [beatIndex, setBeatIndex] = useState(() => (reducedMotion ? LAST_BEAT : -1));
  const [hostVisible, setHostVisible] = useState(false);
  const [documentVisible, setDocumentVisible] = useState(() => (typeof document === 'undefined' ? true : document.visibilityState !== 'hidden'));
  const pauseReason = useRef<StoryPauseReason>(null);

  // One pending timeout for the current beat. Cleaning up on every dependency
  // change also covers unmount, replay and locale/scenario resets.
  useEffect(() => {
    if (status !== 'playing') return;
    const duration = beatIndex < 0 ? STORY_LEAD_IN_MS : BEATS[beatIndex].duration;
    const timer = window.setTimeout(() => {
      if (beatIndex < 0) setBeatIndex(0);
      else if (beatIndex >= LAST_BEAT) setStatus('done');
      else setBeatIndex(beatIndex + 1);
    }, duration);
    return () => window.clearTimeout(timer);
  }, [status, beatIndex, storyKey]);

  // A new story restarts from the beginning; the environment effect below
  // autoplays it again only if the stage is actually eligible.
  useEffect(() => {
    pauseReason.current = null;
    setBeatIndex(reducedMotion ? LAST_BEAT : -1);
    setStatus(reducedMotion ? 'done' : 'idle');
  }, [storyKey]); // `reducedMotion` is handled by its own effect.

  useEffect(() => {
    if (!reducedMotion) return;
    pauseReason.current = null;
    setBeatIndex(LAST_BEAT);
    setStatus('done');
  }, [reducedMotion]);

  // Track the stage's actual intersection ratio; `isIntersecting` alone would
  // start playback for a sliver of the stage.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof IntersectionObserver !== 'function') {
      setHostVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setHostVisible(entry.isIntersecting && entry.intersectionRatio >= HOST_VISIBLE_RATIO);
      },
      { threshold: [0, HOST_VISIBLE_RATIO, 1] },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, [hostRef, storyKey]);

  useEffect(() => {
    const onChange = () => setDocumentVisible(document.visibilityState !== 'hidden');
    onChange();
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  // The single automatic transition: hidden and off-screen conditions are
  // conjunctive for both starting and resuming.
  useEffect(() => {
    const action = nextPlaybackAction({ status, pauseReason: pauseReason.current, hostVisible, documentVisible, reducedMotion });
    if (action === 'play' || action === 'resume') {
      pauseReason.current = null;
      setStatus('playing');
    } else if (action === 'pause') {
      pauseReason.current = pauseReasonFor(hostVisible, documentVisible);
      setStatus('paused');
    }
  }, [status, hostVisible, documentVisible, reducedMotion, storyKey]);

  const pause = useCallback(() => {
    if (status !== 'playing') return;
    pauseReason.current = 'manual';
    setStatus('paused');
  }, [status]);

  const resume = useCallback(() => {
    if (status !== 'paused') return;
    pauseReason.current = null;
    setStatus('playing');
  }, [status]);

  const replay = useCallback(() => {
    pauseReason.current = null;
    setBeatIndex(-1);
    setStatus('playing');
  }, []);

  const showResult = useCallback(() => {
    pauseReason.current = null;
    setBeatIndex(LAST_BEAT);
    setStatus('done');
  }, []);

  const toggle = useCallback(() => {
    if (status === 'playing') pause();
    else if (status === 'paused') resume();
    else if (status === 'idle') {
      pauseReason.current = null;
      setStatus('playing');
    } else replay();
  }, [pause, replay, resume, status]);

  const frame = useMemo(() => (status === 'done' ? storyCompleteFrame() : storyFrame(beatIndex)), [beatIndex, status]);

  return { frame, status, toggle, pause, resume, replay, showResult };
}
