/**
 * Scroll reveal with an initially-visible fallback.
 *
 * Content is visible by default. Only an element that is below the fold when
 * it mounts gets the pending state, and an IntersectionObserver releases it.
 * Without observer support, with reduced motion, or if the element is already
 * on screen, nothing is ever hidden — so the page can never depend on JS to be
 * readable.
 */
import { useEffect, useRef, useState } from 'react';

export interface RevealState {
  ref: React.RefObject<HTMLElement | null>;
  state: 'rest' | 'pending' | 'visible';
}

export function useReveal<T extends HTMLElement = HTMLElement>(enabled = true): { ref: React.RefObject<T | null>; state: RevealState['state'] } {
  const ref = useRef<T>(null);
  const [state, setState] = useState<RevealState['state']>('rest');

  useEffect(() => {
    if (!enabled) return;
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver !== 'function') return;
    // https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const rect = element.getBoundingClientRect();
    if (rect.top < window.innerHeight * 0.85) return;

    setState('pending');
    // https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setState('visible');
            observer.disconnect();
          }
        }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.05 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled]);

  return { ref, state };
}
