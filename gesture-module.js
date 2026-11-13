/**
 * Reconocimiento de bucle por trayectoria — requiere intención circular, ignora scroll vertical.
 */
(function () {
  'use strict';

  const BOOT_FLAG = '__sahGestureBooted';

  const MAX_GESTURE_MS = 600;
  const MIN_SAMPLE_PX = 3;
  const MIN_POINTS = 6;
  const MIN_SEGMENT_GAP = 4;
  const COOLDOWN_MS = 600;
  const SCROLL_BLOCK_MS = 450;
  const CLOSURE_MIN_PX = 10;
  const CLOSURE_MAX_PX = 48;
  const CLOSURE_BBOX_RATIO = 0.24;
  const MIN_PATH_ABS_PX = 16;
  const MIN_PATH_BBOX_RATIO = 0.3;
  const EPS = 1e-6;

  const INTENT_MOVE_PX = 16;
  const AXIS_X_TOLERANCE_PX = 10;
  const VERTICAL_DOMINANCE_RATIO = 2.2;
  const MIN_HORIZONTAL_INTENT_PX = 12;
  const MIN_CURVE_DEVIATION_PX = 8;
  const MAX_VERTICAL_ASPECT_RATIO = 2.4;
  const MIN_HORIZONTAL_SPAN_PX = 18;

  const CAPTURE_OPTS = { capture: true, passive: false };

  /** @type {'idle' | 'probing' | 'tracking'} */
  let phase = 'idle';
  let listenersBound = false;
  let cooldownUntil = 0;
  let scrollBlockedUntil = 0;
  let strokeStartTime = 0;
  let anchorX = 0;
  let anchorY = 0;
  let scrollLogged = false;
  /** @type {{ x: number, y: number, t: number }[]} */
  let points = [];

  function resetStroke() {
    phase = 'idle';
    points = [];
    strokeStartTime = 0;
    scrollLogged = false;
  }

  function abortAsScroll() {
    if (!scrollLogged) {
      console.log('[GESTO] Scroll detectado. Gesto ignorado.');
      scrollLogged = true;
    }
    scrollBlockedUntil = Date.now() + SCROLL_BLOCK_MS;
    resetStroke();
  }

  function shieldGesture(event) {
    if (phase !== 'tracking') return;
    event.preventDefault();
    event.stopPropagation();
  }

  function triggerLoopToggle() {
    cooldownUntil = Date.now() + COOLDOWN_MS;
    console.log('[GESTO] Bucle detectado (Escala: Libre).');

    if (typeof window.handleGesturePanelToggle === 'function') {
      window.handleGesturePanelToggle();
    } else {
      try {
        chrome.runtime.sendMessage({ type: 'TOGGLE_PANEL' }, () => {
          void chrome.runtime.lastError;
        });
      } catch {
        /* detención silenciosa */
      }
    }

    resetStroke();
  }

  function bboxSize(pts) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < pts.length; i += 1) {
      const p = pts[i];
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }

    return {
      width: maxX - minX,
      height: maxY - minY,
      diagonal: Math.hypot(maxX - minX, maxY - minY),
    };
  }

  function isVerticalDominant(dx, dy) {
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);

    if (absY >= INTENT_MOVE_PX && absX <= AXIS_X_TOLERANCE_PX) return true;
    if (absY < INTENT_MOVE_PX) return false;
    return absY >= absX * VERTICAL_DOMINANCE_RATIO;
  }

  function hasHorizontalIntent(dx, dy) {
    return Math.abs(dx) >= MIN_HORIZONTAL_INTENT_PX;
  }

  function pointLineDistance(point, lineStart, lineEnd) {
    const lineLen = Math.hypot(lineEnd.x - lineStart.x, lineEnd.y - lineStart.y);
    if (lineLen < EPS) {
      return Math.hypot(point.x - lineStart.x, point.y - lineStart.y);
    }

    const t = Math.max(0, Math.min(1, (
      ((point.x - lineStart.x) * (lineEnd.x - lineStart.x))
      + ((point.y - lineStart.y) * (lineEnd.y - lineStart.y))
    ) / (lineLen * lineLen)));

    const projX = lineStart.x + t * (lineEnd.x - lineStart.x);
    const projY = lineStart.y + t * (lineEnd.y - lineStart.y);
    return Math.hypot(point.x - projX, point.y - projY);
  }

  function hasDeliberateCurve(pts) {
    if (pts.length < 4) return false;

    const start = pts[0];
    const end = pts[pts.length - 1];
    const span = Math.hypot(end.x - start.x, end.y - start.y);
    if (span < INTENT_MOVE_PX) return false;

    let maxDeviation = 0;
    for (let i = 1; i < pts.length - 1; i += 1) {
      maxDeviation = Math.max(maxDeviation, pointLineDistance(pts[i], start, end));
    }

    const { width, height } = bboxSize(pts);
    return maxDeviation >= MIN_CURVE_DEVIATION_PX && width >= AXIS_X_TOLERANCE_PX;
  }

  function isPredominantlyVerticalPath(pts) {
    const { width, height } = bboxSize(pts);
    if (width >= MIN_HORIZONTAL_SPAN_PX) return false;
    return height >= width * MAX_VERTICAL_ASPECT_RATIO && height >= INTENT_MOVE_PX;
  }

  function evaluateProbeIntent() {
    if (points.length < 2) return 'pending';

    const latest = points[points.length - 1];
    const dx = latest.x - anchorX;
    const dy = latest.y - anchorY;
    const moved = Math.hypot(dx, dy);

    if (moved < INTENT_MOVE_PX) return 'pending';
    if (isVerticalDominant(dx, dy)) return 'scroll';
    if (hasHorizontalIntent(dx, dy) || hasDeliberateCurve(points)) return 'circular';
    if (moved >= INTENT_MOVE_PX * 1.6 && Math.abs(dy) > Math.abs(dx)) return 'scroll';

    return 'pending';
  }

  function closureTolerance(pts) {
    const { diagonal } = bboxSize(pts);
    if (diagonal < 1) return CLOSURE_MIN_PX;
    return Math.min(CLOSURE_MAX_PX, Math.max(CLOSURE_MIN_PX, diagonal * CLOSURE_BBOX_RATIO));
  }

  function totalPathLength(pts) {
    let sum = 0;
    for (let i = 1; i < pts.length; i += 1) {
      sum += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    return sum;
  }

  function orientation(a, b, c) {
    const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
    if (Math.abs(value) < EPS) return 0;
    return value > 0 ? 1 : 2;
  }

  function onSegment(a, b, c) {
    return b.x <= Math.max(a.x, c.x) + EPS
      && b.x + EPS >= Math.min(a.x, c.x)
      && b.y <= Math.max(a.y, c.y) + EPS
      && b.y + EPS >= Math.min(a.y, c.y);
  }

  function segmentsIntersect(a, b, c, d) {
    const o1 = orientation(a, b, c);
    const o2 = orientation(a, b, d);
    const o3 = orientation(c, d, a);
    const o4 = orientation(c, d, b);

    if (o1 !== o2 && o3 !== o4) return true;

    if (o1 === 0 && onSegment(a, c, b)) return true;
    if (o2 === 0 && onSegment(a, d, b)) return true;
    if (o3 === 0 && onSegment(c, a, d)) return true;
    if (o4 === 0 && onSegment(c, b, d)) return true;

    return false;
  }

  function hasSelfIntersection(pts) {
    const count = pts.length;
    if (count < MIN_POINTS) return false;

    const tailA = pts[count - 2];
    const tailB = pts[count - 1];

    for (let i = 0; i < count - MIN_SEGMENT_GAP - 1; i += 1) {
      const segA = pts[i];
      const segB = pts[i + 1];
      if (segmentsIntersect(tailA, tailB, segA, segB)) return true;
    }

    return false;
  }

  function hasProximityClosure(pts) {
    const count = pts.length;
    if (count < MIN_POINTS) return false;

    const current = pts[count - 1];
    const tolerance = closureTolerance(pts);

    for (let i = 0; i < count - MIN_SEGMENT_GAP; i += 1) {
      if (Math.hypot(current.x - pts[i].x, current.y - pts[i].y) <= tolerance) {
        return true;
      }
    }

    return false;
  }

  function hasEnoughMotion(pts) {
    const { diagonal } = bboxSize(pts);
    const pathLen = totalPathLength(pts);
    const minPath = Math.max(MIN_PATH_ABS_PX, diagonal * MIN_PATH_BBOX_RATIO);
    return pathLen >= minPath;
  }

  function detectLoop(pts) {
    if (pts.length < MIN_POINTS) return false;
    if (isPredominantlyVerticalPath(pts)) return false;
    if (!hasEnoughMotion(pts)) return false;

    const latest = pts[pts.length - 1];
    const dx = latest.x - anchorX;
    const dy = latest.y - anchorY;
    if (!hasHorizontalIntent(dx, dy) && !hasDeliberateCurve(pts)) {
      return false;
    }

    return hasSelfIntersection(pts) || hasProximityClosure(pts);
  }

  function appendPoint(x, y, now) {
    if (points.length > 0) {
      const prev = points[points.length - 1];
      if (Math.hypot(x - prev.x, y - prev.y) < MIN_SAMPLE_PX) return false;
    }
    points.push({ x, y, t: now });
    return true;
  }

  function onMouseDown(event) {
    if (!event.isTrusted) return;

    if (event.button === 1) {
      event.preventDefault();
      if (typeof window.forceClosePanel === 'function') {
        window.forceClosePanel();
      } else {
        try {
          chrome.runtime.sendMessage({ type: 'FORCE_CLOSE_PANEL' }, () => {
            void chrome.runtime.lastError;
          });
        } catch { /* ignore */ }
      }
      return;
    }

    if (event.button !== 0) return;

    const now = Date.now();
    if (now < cooldownUntil || now < scrollBlockedUntil) return;

    resetStroke();
    phase = 'probing';
    strokeStartTime = now;
    anchorX = event.clientX;
    anchorY = event.clientY;
    points = [{ x: anchorX, y: anchorY, t: now }];
  }

  function onMouseMove(event) {
    if (!event.isTrusted) return;

    const now = Date.now();
    if (now < cooldownUntil) return;

    if (event.buttons === 0) {
      if (phase !== 'idle') resetStroke();
      return;
    }

    if (phase === 'idle') return;

    const x = event.clientX;
    const y = event.clientY;

    if (phase === 'probing') {
      if (!appendPoint(x, y, now)) return;

      const intent = evaluateProbeIntent();
      if (intent === 'scroll') {
        abortAsScroll();
        return;
      }
      if (intent === 'circular') {
        phase = 'tracking';
        strokeStartTime = now;
        shieldGesture(event);
      }
      return;
    }

    if (phase === 'tracking') {
      shieldGesture(event);

      if (now - strokeStartTime > MAX_GESTURE_MS) {
        resetStroke();
        return;
      }

      if (!appendPoint(x, y, now)) return;

      if (isPredominantlyVerticalPath(points)) {
        abortAsScroll();
        return;
      }

      if (detectLoop(points)) {
        triggerLoopToggle();
      }
    }
  }

  function onMouseUp(event) {
    if (!event.isTrusted) return;
    if (phase === 'idle') return;
    if (phase === 'tracking') shieldGesture(event);
    resetStroke();
  }

  function onBlur() {
    resetStroke();
  }

  function bindGestureRecognizer() {
    if (listenersBound) return;
    listenersBound = true;
    window.addEventListener('mousedown', onMouseDown, CAPTURE_OPTS);
    window.addEventListener('mousemove', onMouseMove, CAPTURE_OPTS);
    window.addEventListener('mouseup', onMouseUp, CAPTURE_OPTS);
    window.addEventListener('blur', onBlur, { capture: true, passive: true });
  }

  function silentReinitGesture() {
    try {
      resetStroke();
      bindGestureRecognizer();
      return true;
    } catch {
      return false;
    }
  }

  function boot() {
    if (window[BOOT_FLAG]) {
      bindGestureRecognizer();
      return;
    }
    window[BOOT_FLAG] = true;
    bindGestureRecognizer();
  }

  window.__sahReinitGesture = silentReinitGesture;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
