/**
 * Screen Accessibility Helper — Auditoría en tiempo real (state-change).
 * Boot silencioso; reporta solo en captura, bloqueo o cambio de categoría.
 */
(function () {
  'use strict';

  const SIGNAL = '__sah_audit_signal';
  const BOOT_FLAG = '__sahAuditLiveBooted';

  const STYLE_EVENT = 'color:#334155;font-family:Consolas,Monaco,monospace;font-size:12px;';
  const STYLE_CAT = 'color:#1e3a5f;font-family:Consolas,Monaco,monospace;font-size:12px;font-weight:bold;';
  const STYLE_ALERT = 'color:#b91c1c;font-family:Consolas,Monaco,monospace;font-size:12px;font-weight:bold;';

  const CATEGORY_LABELS = {
    1: 'Foco/Visibilidad',
    2: 'Interacción',
    3: 'Portapapeles',
    4: 'Sistema',
    5: 'Integridad DOM',
  };

  const EVENT_TO_CATEGORY = {
    blur: 1,
    focus: 1,
    visibilitychange: 1,
    mousemove: 2,
    mousedown: 2,
    keydown: 2,
    copy: 3,
    paste: 3,
    resize: 4,
    fullscreenchange: 4,
    'dom-mutation': 5,
  };

  const TRUSTED_ONLY = new Set(['mousemove', 'mousedown', 'keydown']);

  const GUARD_TARGETS = [
    { name: 'blur', target: () => window },
    { name: 'focus', target: () => window },
    { name: 'visibilitychange', target: () => document },
    { name: 'copy', target: () => document },
    { name: 'paste', target: () => document },
    { name: 'mousemove', target: () => document },
    { name: 'mousedown', target: () => document },
    { name: 'keydown', target: () => window },
    { name: 'resize', target: () => window },
    { name: 'fullscreenchange', target: () => document },
  ];

  /** @type {Record<string, string | null>} */
  const healthByEvent = Object.create(null);
  /** @type {Record<string, string | null>} */
  const lastOperational = Object.create(null);
  /** @type {Record<number, string | null>} */
  const categoryHealth = Object.create(null);
  /** @type {Map<symbol, { eventName: string, reported: boolean, blocked: boolean }>} */
  const pendingTokens = new Map();

  function isMainWorld() {
    return !(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
  }

  function isIsolatedWorld() {
    return !isMainWorld();
  }

  function eventsInCategory(categoryId) {
    return Object.keys(EVENT_TO_CATEGORY).filter((k) => EVENT_TO_CATEGORY[k] === categoryId);
  }

  function aggregateCategoryHealth(categoryId) {
    const names = eventsInCategory(categoryId);
    let hasBlocked = false;
    let hasPartial = false;
    let hasOk = false;

    for (let i = 0; i < names.length; i += 1) {
      const h = healthByEvent[names[i]];
      if (h === 'BLOQUEADO') hasBlocked = true;
      else if (h === 'PARCIAL') hasPartial = true;
      else if (h === 'OK') hasOk = true;
    }

    if (hasBlocked) return 'BLOQUEADO';
    if (hasOk && !hasPartial) return 'OK';
    if (hasOk || hasPartial) return 'PARCIAL';
    return null;
  }

  function updateCategoryHealth(categoryId) {
    const next = aggregateCategoryHealth(categoryId);
    const prev = categoryHealth[categoryId];
    if (next === prev || next === null) return;
    categoryHealth[categoryId] = next;
    console.log(
      `%c[AUDIT] Categoría ${categoryId} (${CATEGORY_LABELS[categoryId]}): [${next}]`,
      STYLE_CAT,
    );
  }

  function emitSignal(detail) {
    try {
      document.dispatchEvent(new CustomEvent(SIGNAL, { detail }));
    } catch {
      /* puente no disponible */
    }
  }

  function processCapture(eventName, estado) {
    const categoryId = EVENT_TO_CATEGORY[eventName];
    if (!categoryId) return;

    const prevOp = lastOperational[eventName];
    if (estado !== undefined && prevOp !== estado) {
      lastOperational[eventName] = estado;
      console.log(`%c[AUDIT] ${eventName} | ${estado}`, STYLE_EVENT);
    }

    const prevHealth = healthByEvent[eventName];
    if (prevHealth !== 'OK') {
      healthByEvent[eventName] = 'OK';
      updateCategoryHealth(categoryId);
    }
  }

  function processBlocked(eventName) {
    const categoryId = EVENT_TO_CATEGORY[eventName];
    if (!categoryId) return;

    const prevHealth = healthByEvent[eventName];
    if (prevHealth === 'BLOQUEADO') return;

    healthByEvent[eventName] = 'BLOQUEADO';
    console.log(
      `%c[AUDIT ALERT] Categoría ${categoryId}: BLOQUEADO (Evento: ${eventName})`,
      STYLE_ALERT,
    );
    updateCategoryHealth(categoryId);
  }

  function markReported(event) {
    const token = event && event.__sahAuditToken;
    if (!token) return;
    const pending = pendingTokens.get(token);
    if (pending) pending.reported = true;
  }

  function capture(eventName, event, estado) {
    markReported(event);
    if (isMainWorld()) {
      processCapture(eventName, estado);
      return;
    }
    emitSignal({ type: 'capture', eventName, estado });
  }

  function reportBlocked(eventName) {
    if (isMainWorld()) {
      processBlocked(eventName);
      return;
    }
    emitSignal({ type: 'blocked', eventName });
  }

  function installGuard(def) {
    const node = def.target();
    if (!node || !node.addEventListener) return;

    node.addEventListener(def.name, (event) => {
      const token = Symbol('sahAudit');
      event.__sahAuditToken = token;
      pendingTokens.set(token, {
        eventName: def.name,
        reported: false,
        blocked: false,
        trusted: Boolean(event.isTrusted),
      });

      const nativeStop = event.stopImmediatePropagation;
      if (typeof nativeStop === 'function') {
        event.stopImmediatePropagation = function interceptedStop(...args) {
          const pending = pendingTokens.get(token);
          if (pending) pending.blocked = true;
          return nativeStop.apply(event, args);
        };
      }

      queueMicrotask(() => {
        const pending = pendingTokens.get(token);
        pendingTokens.delete(token);
        if (!pending) return;
        if (TRUSTED_ONLY.has(pending.eventName) && !pending.trusted) return;
        if (pending.blocked || !pending.reported) {
          reportBlocked(pending.eventName);
        }
      });
    }, { capture: true, passive: true });
  }

  function installIsolatedGuards() {
    for (let i = 0; i < GUARD_TARGETS.length; i += 1) {
      installGuard(GUARD_TARGETS[i]);
    }
  }

  function bindSignalBridge() {
    document.addEventListener(SIGNAL, (event) => {
      const detail = event && event.detail;
      if (!detail || !detail.eventName) return;
      if (detail.type === 'capture') {
        processCapture(detail.eventName, detail.estado);
      } else if (detail.type === 'blocked') {
        processBlocked(detail.eventName);
      }
    }, { capture: false, passive: true });
  }

  function boot() {
    if (window[BOOT_FLAG]) return;
    window[BOOT_FLAG] = true;

    if (isIsolatedWorld()) {
      installIsolatedGuards();
    }

    if (isMainWorld()) {
      bindSignalBridge();
    }

    window.__sahAudit = {
      capture,
      reportBlocked,
      domMutation(estado) {
        capture('dom-mutation', null, estado || 'Detectado');
      },
    };
  }

  boot();
})();
