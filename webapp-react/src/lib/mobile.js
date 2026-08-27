/**
 * Mobile-first helpers for Omnicee Charts (no extra npm deps).
 * - useMediaQuery / useIsMobile: responsive breakpoints
 * - useSwipe: horizontal swipe (threshold + velocity)
 * - bindSwipe: attach to a DOM node via ref callback
 */

import { useState, useEffect, useRef, useCallback } from 'react';

export function useMediaQuery(query) {
  const get = () =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else mql.addListener(onChange);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange);
      else mql.removeListener(onChange);
    };
  }, [query]);
  return matches;
}

/** Phone / narrow tablet — primary UX target */
export function useIsMobile() {
  return useMediaQuery('(max-width: 899px)');
}

/**
 * Horizontal swipe detector.
 * @param {{ onLeft?: () => void, onRight?: () => void, threshold?: number, maxVertical?: number }} opts
 * @returns {{ onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onPointerLeave }}
 */
export function useSwipe(opts = {}) {
  const {
    onLeft,
    onRight,
    threshold = 48,
    maxVertical = 72,
    enabled = true,
  } = opts;
  const start = useRef(null);

  const clear = () => { start.current = null; };

  const onPointerDown = useCallback((e) => {
    if (!enabled) return;
    // ignore multi-touch / right-click
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    start.current = {
      x: e.clientX,
      y: e.clientY,
      t: Date.now(),
      id: e.pointerId,
    };
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch (_) {}
  }, [enabled]);

  const onPointerMove = useCallback(() => {
    /* intentional: decide on up for less jitter with TV iframes */
  }, []);

  const finish = useCallback((e) => {
    const s = start.current;
    if (!s || !enabled) { clear(); return; }
    if (s.id != null && e.pointerId != null && s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    const dt = Math.max(1, Date.now() - s.t);
    const vx = Math.abs(dx) / dt;
    clear();
    if (Math.abs(dy) > maxVertical && Math.abs(dy) > Math.abs(dx)) return;
    const farEnough = Math.abs(dx) >= threshold || (Math.abs(dx) >= 28 && vx > 0.35);
    if (!farEnough) return;
    if (dx < 0) onLeft?.();
    else onRight?.();
  }, [enabled, maxVertical, threshold, onLeft, onRight]);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: finish,
    onPointerCancel: clear,
    onPointerLeave: (e) => {
      // only clear if we lost the pointer without up
      if (start.current && e.pointerType === 'touch') clear();
    },
  };
}

/** Cycle index in a list (wrap). */
export function cycleIndex(list, current, delta) {
  if (!list?.length) return current;
  const i = list.indexOf(current);
  const base = i < 0 ? 0 : i;
  const next = (base + delta + list.length) % list.length;
  return list[next];
}
