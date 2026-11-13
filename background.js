/**
 * Puente silencioso — Protocolo Cero-Rastro. Sin ruido en consola del service worker.
 */
const MSG_CAPTURE_TEXT = 'CAPTURE_TEXT';
const MSG_CAPTURE_MEDIA = 'CAPTURE_MEDIA';
const MSG_TRANSLATE = 'TRANSLATE_TEXT';
const MSG_MEDIA_SEGMENT = 'MEDIA_SEGMENT';
const MSG_OPEN_PANEL = 'OPEN_PANEL';
const MSG_CLOSE_PANEL = 'CLOSE_PANEL';
const MSG_TOGGLE_PANEL = 'TOGGLE_PANEL';
const MSG_PANEL_DISMISSED = 'PANEL_DISMISSED';
const MSG_FORCE_CLOSE_PANEL = 'FORCE_CLOSE_PANEL';
const MSG_PING = 'SAH_PING';
const SESSION_MIRROR = 'mirrorPayload';
const SESSION_MEDIA = 'mediaSegmentPayload';

/** @type {Set<number>} */
const openPanelTabs = new Set();

function silentCatch(promise) {
  if (!promise || typeof promise.catch !== 'function') return promise;
  return promise.catch(() => {});
}

async function openPanelForTab(tabId, windowId) {
  if (!tabId && !windowId) return;

  try {
    if (tabId) {
      await chrome.sidePanel.setOptions({
        tabId,
        path: 'sidepanel.html',
        enabled: true,
      });
    }
    if (windowId) {
      await chrome.sidePanel.open({ windowId });
    } else {
      await chrome.sidePanel.open({ tabId });
    }
    if (tabId) openPanelTabs.add(tabId);
  } catch (err) {
    console.error('[PANEL_STATUS] Intento de apertura fallido:', err);
  }
}

function closePanelForTab(tabId) {
  if (tabId) openPanelTabs.delete(tabId);
  silentCatch(chrome.runtime.sendMessage({ type: MSG_CLOSE_PANEL }));
}

async function resolveActiveTabId(preferredTabId) {
  if (preferredTabId) return preferredTabId;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

async function forceClosePanel(tabId) {
  const targetTabId = await resolveActiveTabId(tabId);
  console.log('[PANEL] Cierre forzado iniciado.');

  try {
    if (targetTabId) {
      // NOTA: No hacemos `enabled: false` porque rompe el botón de la extensión 
      // y obliga a hacer dos clics para volver a abrirlo.
      // Solo borramos el tabId de la lista de abiertos.
      openPanelTabs.delete(targetTabId);
    }
  } catch (err) {
    console.error('[PANEL] Manejo de estado falló:', err);
  }

  try {
    await chrome.runtime.sendMessage({ type: MSG_CLOSE_PANEL });
  } catch (err) {
    console.error('[PANEL] Mensaje CLOSE_PANEL falló:', err);
  }
}

async function togglePanelForTab(tabId) {
  if (!tabId) return;

  if (openPanelTabs.has(tabId)) {
    closePanelForTab(tabId);
    return;
  }

  await openPanelForTab(tabId);
}

function forwardToSidePanel(message) {
  silentCatch(chrome.runtime.sendMessage(message));
}

function relayCapturedText(message) {
  const payload = {
    type: MSG_TRANSLATE,
    text: message.text.trim(),
    method: message.method || 'unknown',
    ts: message.ts || Date.now(),
  };

  silentCatch(chrome.storage.session.set({ [SESSION_MIRROR]: payload }));
  forwardToSidePanel(payload);
  return payload;
}

function relayCapturedMedia(message) {
  const payload = {
    type: MSG_MEDIA_SEGMENT,
    segmentId: message.segmentId,
    durationMs: message.durationMs,
    mediaTag: message.mediaTag,
    asset: message.asset,
    control: message.control,
    streamActive: message.streamActive,
    text: message.text,
    localTranslation: message.localTranslation,
    _senderTabId: message._senderTabId,
    ts: message.ts || Date.now(),
  };

  silentCatch(chrome.storage.session.set({ [SESSION_MEDIA]: payload }));
  forwardToSidePanel(payload);
  return payload;
}

async function initSidePanelBehavior() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch (err) {
    console.error('[DEBUG] SidePanel no disponible:', err);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  initSidePanelBehavior();
});

chrome.runtime.onStartup.addListener(() => {
  initSidePanelBehavior();
});

chrome.action.onClicked.addListener((tab) => {
  try {
    if (tab.id) {
      // Configuramos las opciones de forma asíncrona pero sin bloquear
      chrome.sidePanel.setOptions({
        tabId: tab.id,
        path: 'sidepanel.html',
        enabled: true,
      }).catch(() => {});
    }
    // Abrimos el panel inmediatamente para no perder el token del user gesture
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(err => {
      console.error('[PANEL_STATUS] Fallo al abrir:', err);
    });
    if (tab.id) openPanelTabs.add(tab.id);
  } catch (err) {
    console.error('[PANEL_STATUS] Intento de apertura fallido:', err);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === MSG_PING) {
    sendResponse({ ok: true, ts: Date.now() });
    return false;
  }

  if (message?.type === MSG_OPEN_PANEL) {
    const tabId = sender.tab?.id;
    openPanelForTab(tabId).catch(() => {}).finally(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === MSG_FORCE_CLOSE_PANEL) {
    const tabId = sender.tab?.id;
    forceClosePanel(tabId).catch(() => {}).finally(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === MSG_CLOSE_PANEL) {
    const tabId = sender.tab?.id;
    closePanelForTab(tabId);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === MSG_TOGGLE_PANEL) {
    const tabId = sender.tab?.id;
    togglePanelForTab(tabId).catch(() => {}).finally(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === MSG_PANEL_DISMISSED) {
    const tabId = sender.tab?.id;
    if (tabId) openPanelTabs.delete(tabId);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === MSG_CAPTURE_TEXT && typeof message.text === 'string') {
    relayCapturedText(message);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === MSG_CAPTURE_MEDIA && message.segmentId) {
    message._senderTabId = sender.tab?.id;
    relayCapturedMedia(message);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
