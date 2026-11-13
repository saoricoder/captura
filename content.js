/**
 * Screen Accessibility Helper — Protocolo Cero-Rastro.
 * Puente silencioso, auditoría de sensores y captura gestual/hover.
 */
(function () {
  'use strict';

  const BOOT_FLAG = '__sahResilienceBooted';
  const AUDIT_STORAGE_KEY = 'readingAuditLog';
  const CAPTURE_EVENT = '__sah_capture';
  const GESTURE_PANEL_EVENT = '__sah_gesture_panel';
  const MSG_CAPTURE_TEXT = 'CAPTURE_TEXT';
  const MSG_CAPTURE_MEDIA = 'CAPTURE_MEDIA';
  const MSG_TOGGLE_PANEL = 'TOGGLE_PANEL';
  const MSG_CLOSE_PANEL = 'CLOSE_PANEL';
  const MSG_FORCE_CLOSE_PANEL = 'FORCE_CLOSE_PANEL';
  const MSG_PANEL_DISMISSED = 'PANEL_DISMISSED';
  const MSG_PING = 'SAH_PING';
  const MSG_HEALTH_PANEL_READY = 'SAH_HEALTH_PANEL_READY';
  const REINIT_EVENT = '__sah_silent_reinit';
  const HEALTH_PANEL_CONFIRM_MS = 1500;
  const HEALTH_PANEL_RETRY_DELAY_MS = 2000;
  const MEDIA_BRIDGE_CHANNEL = '__sah_media_bridge';
  const RELOAD_DELAY_MIN_MS = 3000;
  const RELOAD_DELAY_MAX_MS = 8000;
  const HOVER_IDLE_MS = 2000;
  const HOVER_MOVE_EPS = 3;
  const MIN_TEXT_LEN = 2;
  const MAX_PARENT_HOPS = 8;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'IFRAME',
    'INPUT', 'TEXTAREA', 'SELECT', 'OBJECT', 'CANVAS',
    'BUTTON', 'A', 'LABEL', 'OPTION',
  ]);

  const MONITORED_EVENTS = [
    'blur', 'focus', 'copy', 'paste', 'contextmenu', 'visibilitychange',
  ];

  const EVENT_DESCRIPTIONS = {
    blur: 'Pérdida de foco del documento',
    focus: 'Recuperación de foco del documento',
    copy: 'Operación de copia',
    paste: 'Operación de pegado',
    contextmenu: 'Menú contextual',
    visibilitychange: 'Visibilidad de la pestaña',
    resize: 'Redimensionamiento de ventana',
    fullscreenchange: 'Cambio de pantalla completa',
    'entorno-lectura': 'Compatibilidad del entorno de lectura',
    'audio-stream': 'Captura global de flujo de audio',
    'shift-sensor': 'Sensor de tecla Shift',
    'alt-sensor': 'Sensor de tecla Alt',
    'modo-entrada': 'Modo de entrada del protocolo',
    'gesto-circular': 'Gesto circular de panel',
    'hover-captura': 'Captura por inactividad hover',
  };

  let extensionAlive = true;
  let recoveryInProgress = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let deferredReloadTimer = null;
  let lastReportedShiftActive = null;
  let lastReportedAltActive = null;
  let shiftChannelOpen = true;
  let mouseOnlyMode = false;
  let lastAudioStreamStatus = null;
  let hoverIdleTimer = null;
  /** @type {Element | null} */
  let hoverTarget = null;
  let hoverAnchorX = 0;
  let hoverAnchorY = 0;
  let lastHoverCaptureKey = '';

  /** @type {Map<string, object>} */
  const readingAuditLog = new Map();

  window.isSystemHealthy = true;

  let gestureBridgeBound = false;
  let bootContextInvalidated = false;
  let panelIsOpen = false;
  /** @type {(() => void) | null} */
  let panelReadyResolver = null;
  let panelToggleHealthPending = false;

  function reportAuditCapture(eventName, event, estado) {
    if (typeof window.__sahAudit?.capture === 'function') {
      window.__sahAudit.capture(eventName, event, estado);
    }
  }

  function isContextInvalidated(errorMessage) {
    return /context invalidated|extension context/i.test(String(errorMessage || ''));
  }

  function setSystemUnhealthy() {
    window.isSystemHealthy = false;
  }

  function reportHealthAlert(panelState, cause, suggestedAction) {
    setSystemUnhealthy();
    console.error(
      `[HEALTH CHECK ALERT]\n`
      + `- Estado Panel: ${panelState}\n`
      + `- Causa: ${cause}\n`
      + `- Acción sugerida: ${suggestedAction}`,
    );
  }

  function resolvePanelReadyWait() {
    if (panelReadyResolver) {
      const resolve = panelReadyResolver;
      panelReadyResolver = null;
      resolve(true);
    }
  }

  function waitForPanelReady(timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        panelReadyResolver = null;
        resolve(false);
      }, timeoutMs);

      panelReadyResolver = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        panelReadyResolver = null;
        resolve(true);
      };
    });
  }

  function areGestureListenersBound() {
    if (typeof window.__sahReinitGesture !== 'function') return false;
    if (!window.__sahGestureBooted) return false;
    try {
      return window.__sahReinitGesture() !== false;
    } catch {
      return false;
    }
  }

  function isSidePanelBridgeAvailable() {
    return Boolean(chrome.runtime?.id) && gestureBridgeBound;
  }

  function runBootHealthCheck() {
    const failures = [];

    if (!isSidePanelBridgeAvailable()) {
      failures.push({
        panelState: 'FALLIDO',
        cause: 'Puente SidePanel no inyectado o runtime de extensión no disponible',
        action: 'Recargar extensión en chrome://extensions',
      });
    }

    if (!areGestureListenersBound()) {
      failures.push({
        panelState: 'BLOQUEADO',
        cause: 'Listeners de gestos circulares no vinculados',
        action: 'Recargar extensión',
      });
    }

    tryPingExtension((pingOk) => {
      if (!pingOk) {
        failures.push({
          panelState: 'FALLIDO',
          cause: bootContextInvalidated
            ? 'Context invalidated detectado durante el boot'
            : 'Diagnóstico de inicialización: ping de extensión fallido',
          action: 'Recargar extensión en chrome://extensions',
        });
      }

      if (failures.length === 0) return;

      const panelState = failures.some((item) => item.panelState === 'FALLIDO') ? 'FALLIDO' : 'BLOQUEADO';
      reportHealthAlert(
        panelState,
        failures.map((item) => item.cause).join('; '),
        failures[0].action,
      );
    });
  }

  async function validatePanelOpenAfterToggle(attempt) {
    const opened = await waitForPanelReady(HEALTH_PANEL_CONFIRM_MS);
    if (opened) {
      panelIsOpen = true;
      panelToggleHealthPending = false;
      return;
    }

    if (attempt === 1) {
      window.setTimeout(() => {
        safeRuntimeSend({ type: MSG_TOGGLE_PANEL });
        validatePanelOpenAfterToggle(2);
      }, HEALTH_PANEL_RETRY_DELAY_MS);
      return;
    }

    panelToggleHealthPending = false;
    panelIsOpen = false;
    reportHealthAlert(
      'FALLIDO',
      'SidePanel API restringido por el sitio o panel no respondió tras reintento',
      'Recargar extensión y verificar permisos de Side Panel',
    );
  }

  function handleGesturePanelToggle() {
    upsertAuditEvent('gesto-circular', 'DETECTADO', 'toggle-panel');

    if (panelIsOpen) {
      panelIsOpen = false;
      safeRuntimeSend({ type: MSG_CLOSE_PANEL });
      return;
    }

    if (panelToggleHealthPending) return;
    panelToggleHealthPending = true;
    safeRuntimeSend({ type: MSG_TOGGLE_PANEL });
    validatePanelOpenAfterToggle(1);
  }

  function bindHealthDiagnostics() {
    try {
      chrome.runtime.onMessage.addListener((message) => {
        if (message?.type === MSG_HEALTH_PANEL_READY) {
          panelIsOpen = true;
          resolvePanelReadyWait();
        }
      });
    } catch (error) {
      if (isContextInvalidated(error?.message)) {
        bootContextInvalidated = true;
        setSystemUnhealthy();
      }
    }
  }

  function markExtensionDead() {
    if (!extensionAlive) return;
    extensionAlive = false;
    attemptSilentRecovery();
  }

  function randomReloadDelayMs() {
    return RELOAD_DELAY_MIN_MS
      + Math.floor(Math.random() * (RELOAD_DELAY_MAX_MS - RELOAD_DELAY_MIN_MS + 1));
  }

  function scheduleDeferredReload() {
    if (deferredReloadTimer) return;
    deferredReloadTimer = setTimeout(() => {
      deferredReloadTimer = null;
      try {
        window.location.reload();
      } catch {
        /* detención silenciosa */
      }
    }, randomReloadDelayMs());
  }

  function silentLocalReinit() {
    let ok = true;

    try {
      if (typeof window.__sahReinitGesture === 'function') {
        ok = window.__sahReinitGesture() !== false && ok;
      }
    } catch {
      ok = false;
    }

    try {
      document.dispatchEvent(new CustomEvent(REINIT_EVENT, {
        detail: { ts: Date.now(), module: 'media-cc' },
      }));
    } catch {
      ok = false;
    }

    return ok;
  }

  function tryPingExtension(callback) {
    try {
      chrome.runtime.sendMessage({ type: MSG_PING }, (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          if (isContextInvalidated(err.message)) {
            extensionAlive = false;
            bootContextInvalidated = true;
            callback(false);
            return;
          }
          callback(false);
          return;
        }
        if (response?.ok) {
          extensionAlive = true;
          callback(true);
          return;
        }
        callback(false);
      });
    } catch {
      extensionAlive = false;
      callback(false);
    }
  }

  function attemptSilentRecovery() {
    if (recoveryInProgress) return;
    recoveryInProgress = true;

    const localOk = silentLocalReinit();

    tryPingExtension((pingOk) => {
      if (pingOk) {
        recoveryInProgress = false;
        return;
      }

      if (!localOk) {
        scheduleDeferredReload();
        recoveryInProgress = false;
        return;
      }

      window.setTimeout(() => {
        tryPingExtension((pingOkRetry) => {
          recoveryInProgress = false;
          if (!pingOkRetry) scheduleDeferredReload();
        });
      }, 500);
    });
  }

  function safeRuntimeSend(message, callback) {
    if (!extensionAlive) {
      attemptSilentRecovery();
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (...args) => {
        const err = chrome.runtime.lastError;
        if (err) {
          if (isContextInvalidated(err.message)) markExtensionDead();
          return;
        }
        if (callback) callback(...args);
      });
    } catch {
      markExtensionDead();
    }
  }

  window.forceClosePanel = function forceClosePanel() {
    console.log('[GESTO] Ejecutando cierre forzado....');
    panelIsOpen = false;
    safeRuntimeSend({ type: MSG_FORCE_CLOSE_PANEL });
  };

  window.handleGesturePanelToggle = handleGesturePanelToggle;

  function loadAuditLog() {
    try {
      const raw = sessionStorage.getItem(AUDIT_STORAGE_KEY);
      if (!raw) return;
      const entries = JSON.parse(raw);
      if (!Array.isArray(entries)) return;
      for (let i = 0; i < entries.length; i += 1) {
        const pair = entries[i];
        if (Array.isArray(pair) && pair.length === 2) {
          readingAuditLog.set(pair[0], pair[1]);
        }
      }
    } catch {
      /* sesión corrupta */
    }
  }

  function persistAuditLog() {
    try {
      sessionStorage.setItem(
        AUDIT_STORAGE_KEY,
        JSON.stringify(Array.from(readingAuditLog.entries())),
      );
    } catch {
      /* storage no disponible */
    }
  }

  function upsertAuditEvent(nombre, estado, origen) {
    const now = new Date().toISOString();
    const existing = readingAuditLog.get(nombre);
    const descripcion = EVENT_DESCRIPTIONS[nombre] || 'Evento monitorizado';

    if (!existing) {
      readingAuditLog.set(nombre, {
        nombre, descripcion, estado, origen, timestamp: now,
      });
      persistAuditLog();
      return;
    }

    if (existing.estado === estado && existing.origen === origen) return;

    readingAuditLog.set(nombre, {
      ...existing, descripcion, estado, origen, timestamp: now,
    });
    persistAuditLog();
  }

  function applyInputMode() {
    mouseOnlyMode = !shiftChannelOpen;
    upsertAuditEvent(
      'modo-entrada',
      mouseOnlyMode ? 'SOLO-RATON' : 'TECLADO+RATON',
      mouseOnlyMode ? 'shift-bloqueado' : 'shift-operativo',
    );
  }

  function reportModifierAuditState(event) {
    const shiftActive = Boolean(event.shiftKey);
    const altActive = Boolean(event.altKey);

    if (lastReportedShiftActive !== shiftActive) {
      lastReportedShiftActive = shiftActive;
      upsertAuditEvent(
        'shift-sensor',
        shiftActive ? 'Activo' : 'Inactivo',
        'sensor-estado',
      );
    }

    if (lastReportedAltActive !== altActive) {
      lastReportedAltActive = altActive;
      upsertAuditEvent(
        'alt-sensor',
        altActive ? 'Activo' : 'Inactivo',
        'sensor-estado',
      );
    }
  }

  function auditKeyboardSensor(event) {
    if (!event.isTrusted) return;

    if (event.type === 'keydown') {
      reportAuditCapture('keydown', event, 'Detectado');
    }

    reportModifierAuditState(event);

    const isShiftKey = event.key === 'Shift'
      || event.code === 'ShiftLeft'
      || event.code === 'ShiftRight';

    if (isShiftKey) {
      if (event.type === 'keyup') {
        shiftChannelOpen = false;
      } else if (event.type === 'keydown') {
        shiftChannelOpen = true;
      }
      applyInputMode();
    }
  }

  function bindSecuritySensor() {
    window.addEventListener('keydown', auditKeyboardSensor, { capture: true, passive: true });
    window.addEventListener('keyup', auditKeyboardSensor, { capture: true, passive: true });
  }

  function shouldSkipElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return true;
    if (SKIP_TAGS.has(element.tagName)) return true;
    if (element.isContentEditable) return true;
    const role = element.getAttribute?.('role');
    if (role === 'button' || role === 'link' || role === 'menuitem') return true;
    return false;
  }

  function getSafeText(element) {
    if (!element) return null;
    try {
      if (element.nodeType === Node.TEXT_NODE) {
        return element.textContent || '';
      }
      if (element.nodeType !== Node.ELEMENT_NODE) return null;
      return element.innerText || element.textContent || '';
    } catch {
      return null;
    }
  }

  function isValidHoverCaptureTarget(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    if (!element.isConnected) return false;
    if (shouldSkipElement(element)) return false;
    return true;
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function extractTextFromElement(element) {
    if (!isValidHoverCaptureTarget(element)) return '';

    let node = element;
    let hops = 0;
    while (node && hops <= MAX_PARENT_HOPS) {
      if (node.nodeType === Node.ELEMENT_NODE && !shouldSkipElement(node)) {
        const raw = getSafeText(node);
        if (raw === null) {
          node = node.parentElement;
          hops += 1;
          continue;
        }
        const text = normalizeText(raw);
        if (text.length >= MIN_TEXT_LEN) return text;
      }
      node = node.parentElement;
      hops += 1;
    }
    return '';
  }

  function clearHoverIdleTimer() {
    if (hoverIdleTimer) {
      clearTimeout(hoverIdleTimer);
      hoverIdleTimer = null;
    }
  }

  function sendTextToSidePanel(text, method) {
    const sample = normalizeText(text);
    if (!sample) return;

    safeRuntimeSend({
      type: MSG_CAPTURE_TEXT,
      text: sample,
      method: method || 'hover-idle',
      ts: Date.now(),
    });
  }

  function scheduleHoverCapture(element) {
    clearHoverIdleTimer();
    if (!isValidHoverCaptureTarget(element)) return;

    const capturedElement = element;
    hoverIdleTimer = setTimeout(() => {
      hoverIdleTimer = null;
      if (!isValidHoverCaptureTarget(capturedElement)) return;
      const text = extractTextFromElement(capturedElement);
      if (!text || text === lastHoverCaptureKey) return;
      lastHoverCaptureKey = text;
      upsertAuditEvent('hover-captura', 'DISPARADO', 'inactividad-5s');
      sendTextToSidePanel(text, 'hover-idle');
    }, HOVER_IDLE_MS);
  }

  function bindHoverCapture() {
    document.addEventListener('mousemove', (event) => {
      if (!event.isTrusted) return;

      reportAuditCapture('mousemove', event, 'Detectado');

      let element = document.elementFromPoint(event.clientX, event.clientY);
      while (element && shouldSkipElement(element)) {
        element = element.parentElement;
      }

      if (!element) {
        hoverTarget = null;
        clearHoverIdleTimer();
        return;
      }

      const moved = Math.hypot(event.clientX - hoverAnchorX, event.clientY - hoverAnchorY) > HOVER_MOVE_EPS;
      if (element !== hoverTarget || moved) {
        hoverTarget = element;
        hoverAnchorX = event.clientX;
        hoverAnchorY = event.clientY;
        scheduleHoverCapture(element);
      }
    }, { capture: true, passive: true });

    document.addEventListener('mouseleave', () => {
      hoverTarget = null;
      clearHoverIdleTimer();
    }, { capture: true, passive: true });
  }

  function logAudioStreamStatus(active) {
    const label = active ? 'ACTIVO' : 'INACTIVO';
    if (lastAudioStreamStatus === label) return;
    lastAudioStreamStatus = label;
    upsertAuditEvent('audio-stream', label, 'captura-global');
  }

  function logAudioStreamDiagnostic(message) {
    const sample = String(message || '').trim();
    if (!sample) return;
    upsertAuditEvent('audio-stream', sample, 'captura-global');
  }

  function sendMediaSegment(detail) {
    if (!detail) return;

    if (detail.control === 'stream-status') {
      logAudioStreamStatus(Boolean(detail.streamActive));
    }

    if (detail.control === 'stream-diagnostic') {
      logAudioStreamDiagnostic(detail.diagnostic);
      return;
    }

    safeRuntimeSend({
      type: MSG_CAPTURE_MEDIA,
      segmentId: detail.segmentId,
      durationMs: detail.durationMs,
      mediaTag: detail.mediaTag,
      asset: detail.asset,
      control: detail.control,
      streamActive: detail.streamActive,
      text: detail.text,
      localTranslation: detail.localTranslation,
      ts: detail.ts || Date.now(),
    });
  }

  function bindMediaBridge() {
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.channel !== MEDIA_BRIDGE_CHANNEL) return;
      if (data.type !== 'MEDIA_SEGMENT' || !data.payload) return;
      sendMediaSegment(data.payload);
    }, { capture: false, passive: true });
  }

  function bindCaptureBridge() {
    document.addEventListener(CAPTURE_EVENT, (event) => {
      const detail = event?.detail;
      if (!detail?.text) return;
      sendTextToSidePanel(detail.text, detail.method || 'main-world');
    }, { capture: false, passive: true });
  }

  function bindGesturePanelBridge() {
    document.addEventListener(GESTURE_PANEL_EVENT, handleGesturePanelToggle, {
      capture: false,
      passive: true,
    });
    gestureBridgeBound = true;
  }

  function bindReadingAuditor() {
    for (let i = 0; i < MONITORED_EVENTS.length; i += 1) {
      const eventName = MONITORED_EVENTS[i];
      const target = eventName === 'visibilitychange' ? document : window;
      target.addEventListener(
        eventName,
        (event) => {
          let estado;
          let origen;

          if (eventName === 'blur') {
            estado = 'Inactivo';
            origen = 'sensor-foco';
          } else if (eventName === 'focus') {
            estado = 'Activo';
            origen = 'sensor-foco';
          } else if (eventName === 'visibilitychange') {
            estado = document.visibilityState === 'visible' ? 'Activo' : 'Inactivo';
            origen = 'sensor-foco';
          } else {
            estado = 'Detectado';
            origen = 'disparo-captura';
          }

          reportAuditCapture(eventName, event, estado);
          upsertAuditEvent(eventName, estado, origen);
        },
        { capture: true, passive: true },
      );
    }
  }

  function bindSystemSensor() {
    window.addEventListener('resize', (event) => {
      reportAuditCapture('resize', event, 'Detectado');
      upsertAuditEvent('resize', 'Detectado', 'sensor-sistema');
    }, { capture: true, passive: true });

    document.addEventListener('fullscreenchange', (event) => {
      const estado = document.fullscreenElement ? 'Activo' : 'Inactivo';
      reportAuditCapture('fullscreenchange', event, estado);
      upsertAuditEvent('fullscreenchange', estado, 'sensor-sistema');
    }, { capture: true, passive: true });
  }

  function boot() {
    if (window[BOOT_FLAG]) return;
    window[BOOT_FLAG] = true;

    loadAuditLog();
    bindSecuritySensor();
    bindReadingAuditor();
    bindSystemSensor();
    bindHoverCapture();
    bindGesturePanelBridge();
    bindMediaBridge();
    bindCaptureBridge();
    bindHealthDiagnostics();
    applyInputMode();
    window.setTimeout(runBootHealthCheck, 0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
