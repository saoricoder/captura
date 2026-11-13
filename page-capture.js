/**
 * Captura en MAIN world — texto pasivo y conexión forzada de flujo multimedia.
 * Búsqueda recursiva (Shadow DOM + iFrames), captureStream inmediato, re-vinculación persistente.
 */
(function () {
  'use strict';

  const BOOT_FLAG = '__sahPageCaptureBooted';
  const REINIT_EVENT = '__sah_silent_reinit';
  const CAPTURE_EVENT = '__sah_capture';
  const BRIDGE_CHANNEL = '__sah_media_bridge';
  const MIN_TEXT_LEN = 2;
  const MAX_PARENT_HOPS = 8;
  const API_BLOCKED_MSG = 'Audio/Video API bloqueada por la plataforma';

  const SEGMENT_MS = 5000;
  const MIN_SEGMENT_MS = 3000;
  const MAX_SEGMENT_MS = 10000;
  const SILENCE_RMS = 0.0001;
  const TARGET_SAMPLE_RATE = 16000;
  const PROCESSOR_BUFFER = 8192;
  const PLAYBACK_POLL_MS = 250;
  const BUFFER_REINIT_MS = 2000;
  const FORCE_REBIND_MS = 1000;
  const MAX_CONNECTION_ATTEMPTS = 3;
  const TIME_ADVANCE_EPS = 0.005;
  const SUBTITLE_POLL_MS = 200;
  const LIVE_CAPTION_SELECTORS = [
    '.ytp-caption-segment',
    '.captions-text',
    '.vjs-text-track-cue',
    '.vjs-text-track-display',
    'div[role="caption"]'
  ];
  const NO_TRACKS_MSG = 'Contenido sin pistas de texto detectadas. Por favor, asegúrese de que los subtítulos (CC) estén habilitados en el reproductor';

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'IFRAME',
    'INPUT', 'TEXTAREA', 'SELECT', 'OBJECT', 'CANVAS',
  ]);

  let boundMedia = null;
  /** @type {WeakMap<HTMLMediaElement, number>} */
  const mediaLastTime = new WeakMap();
  let segmentStartedAt = 0;
  let capturing = false;
  let mediaApiAvailable = true;
  let playbackPollTimer = null;
  /** @type {MutationObserver | null} */
  let mediaObserver = null;
  let subtitlePollTimer = null;
  let liveCaptionActive = false;
  let noTextTracksPosted = false;
  /** @type {Set<string>} */
  const processedCueKeys = new Set();

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function shouldSkipElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return true;
    if (SKIP_TAGS.has(element.tagName)) return true;
    if (element.isContentEditable) return true;
    return false;
  }

  function emitCapture(text, method) {
    const sample = normalizeText(text);
    if (sample.length < MIN_TEXT_LEN) return;

    document.dispatchEvent(new CustomEvent(CAPTURE_EVENT, {
      detail: { text: sample, method, ts: Date.now() },
    }));
  }

  function postSegment(payload) {
    window.postMessage({
      channel: BRIDGE_CHANNEL,
      type: 'MEDIA_SEGMENT',
      payload,
    }, '*');
  }

  /**
   * Recorre Shadow DOM, hijos y iFrames accesibles; vincula cada HTMLMediaElement encontrado.
   * @returns {HTMLMediaElement[]}
   */
  function findAndBindMedia(root, iframeBlockedRefs) {
    /** @type {HTMLMediaElement[]} */
    const found = [];

    function walk(node) {
      if (!node) return;

      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = /** @type {Element} */ (node);

        if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') {
          const media = /** @type {HTMLMediaElement} */ (el);
          found.push(media);
          bindMediaElement(media);
        }

        if (el.shadowRoot) walk(el.shadowRoot);

        if (el.tagName === 'IFRAME') {
          try {
            const frame = /** @type {HTMLIFrameElement} */ (el);
            const frameDoc = frame.contentDocument;
            if (frameDoc) {
              walk(frameDoc.documentElement || frameDoc.body);
            }
          } catch {
            if (iframeBlockedRefs) iframeBlockedRefs.push(el);
          }
        }

        for (let i = 0; i < el.children.length; i += 1) {
          walk(el.children[i]);
        }
        return;
      }

      if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE || node.nodeType === Node.DOCUMENT_NODE) {
        const doc = /** @type {Document | DocumentFragment} */ (node);
        if ('documentElement' in doc && doc.documentElement) {
          walk(doc.documentElement);
        } else {
          for (let i = 0; i < doc.childNodes.length; i += 1) {
            walk(doc.childNodes[i]);
          }
        }
      }
    }

    walk(root || document.documentElement);
    return found;
  }

  function collectAllMediaElements() {
    const blockedIframes = [];
    const elements = findAndBindMedia(document.documentElement, blockedIframes);
    return elements;
  }

  async function forceConnectMedia(media) {
    if (!media) return false;
    bindMediaElement(media);
    mediaLastTime.set(media, media.currentTime);
    return attachGlobalCapture(media);
  }

  function isMediaPlaying(media) {
    return Boolean(media && !media.paused && !media.ended && media.readyState >= 2);
  }

  function isMediaTimeAdvancing(media) {
    if (!isMediaPlaying(media)) return false;
    const prev = mediaLastTime.get(media) ?? media.currentTime;
    const now = media.currentTime;
    mediaLastTime.set(media, now);
    return now - prev >= TIME_ADVANCE_EPS;
  }

  function findAdvancingMedia() {
    const nodes = collectAllMediaElements();
    let best = null;
    let bestDelta = 0;

    for (let i = 0; i < nodes.length; i += 1) {
      const media = nodes[i];
      if (!isMediaPlaying(media)) {
        mediaLastTime.set(media, media.currentTime);
        continue;
      }

      const prev = mediaLastTime.get(media) ?? media.currentTime;
      const now = media.currentTime;
      mediaLastTime.set(media, now);
      const delta = now - prev;

      if (delta >= TIME_ADVANCE_EPS && delta > bestDelta) {
        bestDelta = delta;
        best = media;
      }
    }

    return best;
  }

  function findPlayingMediaList() {
    return collectAllMediaElements().filter(isMediaPlaying);
  }

  async function attachGlobalCapture(media) {
    if (!media) return false;

    if (boundMedia && boundMedia !== media) {
      await stopCapture();
    } else if (boundMedia === media && capturing) {
      return true;
    }

    segmentStartedAt = Date.now();
    boundMedia = media;
    capturing = true;

    postSegment({
      segmentId: `ctrl-${Date.now()}`,
      control: 'capture-started',
      mediaTag: media.tagName.toLowerCase(),
      ts: Date.now(),
    });

    return true;
  }

  async function onPlaybackIdle() {
    if (!capturing) return;
    capturing = false;
    
    postSegment({
      segmentId: `ctrl-${Date.now()}`,
      control: 'capture-stopped',
      ts: Date.now(),
    });
    
    boundMedia = null;
  }

  async function pollPlaybackActivity() {
    const advancing = findAdvancingMedia();

    if (advancing) {
      if (advancing !== boundMedia || !capturing) {
        await forceConnectMedia(advancing);
      }
      return;
    }

    const playing = findPlayingMediaList();
    if (playing.length > 0 && !capturing) {
      await forceConnectMedia(playing[0]);
      return;
    }

    await onPlaybackIdle();
  }

  function primeMediaSnapshots() {
    const nodes = collectAllMediaElements();
    for (let i = 0; i < nodes.length; i += 1) {
      mediaLastTime.set(nodes[i], nodes[i].currentTime);
    }
  }

  function scheduleBufferHealthCheck() {
    // Ya no es necesario el chequeo de buffer
  }

  function scheduleForceRebindWhilePlaying() {
    // Ya no es necesario el rebind del flujo de buffer
  }

  function startPlaybackMonitor() {
    if (playbackPollTimer) return;
    primeMediaSnapshots();
    playbackPollTimer = window.setInterval(() => {
      pollPlaybackActivity().catch(() => {});
    }, PLAYBACK_POLL_MS);
    scheduleBufferHealthCheck();
    scheduleForceRebindWhilePlaying();
  }

  async function onMediaPlay(event) {
    const media = event.currentTarget;
    if (!media || (media.tagName !== 'VIDEO' && media.tagName !== 'AUDIO')) return;
    mediaLastTime.set(media, media.currentTime);
    await forceConnectMedia(media);
    startLiveCaptionStream(media);
  }

  function stopLiveCaptionStreamIfIdle() {
    const playing = findPlayingMediaList();
    if (playing.length > 0) return;
    liveCaptionActive = false;
    if (subtitlePollTimer) {
      clearInterval(subtitlePollTimer);
      subtitlePollTimer = null;
    }
  }

  async function onMediaPause(event) {
    const media = event.currentTarget;
    if (!media || boundMedia !== media) return;

    window.setTimeout(async () => {
      const stillPlaying = findPlayingMediaList();
      if (stillPlaying.length > 0) {
        const target = stillPlaying[0];
        if (target !== boundMedia) await forceConnectMedia(target);
        return;
      }
      await onPlaybackIdle();
      stopLiveCaptionStreamIfIdle();
    }, PLAYBACK_POLL_MS);
  }

  async function onMediaEnded(event) {
    const media = event.currentTarget;
    if (!media || boundMedia !== media) return;

    const next = findAdvancingMedia() || findPlayingMediaList()[0];
    if (next) {
      await forceConnectMedia(next);
      return;
    }

    await stopCapture();

    postSegment({
      segmentId: `ctrl-${Date.now()}`,
      control: 'capture-stopped',
      ts: Date.now(),
    });
  }

  function bindMediaElement(media) {
    if (!media || media.__sahPlayBound) return;

    try {
      // Inyectar permiso CORS si es necesario para evitar que el navegador silencie el audio
      if (!media.crossOrigin || media.crossOrigin === '') {
        media.crossOrigin = 'anonymous';
      }

      media.__sahPlayBound = true;
      mediaLastTime.set(media, media.currentTime);

      media.addEventListener('play', onMediaPlay, { passive: true });
      media.addEventListener('pause', onMediaPause, { passive: true });
      media.addEventListener('ended', onMediaEnded, { passive: true });
      media.addEventListener('timeupdate', () => {
        mediaLastTime.set(media, media.currentTime);
      }, { passive: true });

      bindTextTracks(media);

      if (isMediaPlaying(media)) {
        forceConnectMedia(media).catch(() => {});
        startLiveCaptionStream(media);
      }
    } catch {
      /* reproductor incompatible o sin pistas accesibles */
    }
  }

  function scanAndBindMedia(root) {
    try {
      findAndBindMedia(root && root.nodeType === Node.ELEMENT_NODE ? root : document.documentElement);
    } catch {
      /* ignorar nodos multimedia incompatibles */
    }
  }

  function observeMediaElements() {
    scanAndBindMedia(document);

    if (typeof MutationObserver === 'undefined') return;

    mediaObserver = new MutationObserver((mutations) => {
      if (typeof window.__sahAudit?.domMutation === 'function') {
        window.__sahAudit.domMutation('Detectado');
      }
      try {
        for (let i = 0; i < mutations.length; i += 1) {
          const mutation = mutations[i];
          for (let j = 0; j < mutation.addedNodes.length; j += 1) {
            const node = mutation.addedNodes[j];
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            scanAndBindMedia(node);
          }
        }
      } catch {
        /* ignorar mutaciones en reproductores sin pistas */
      }
    });

    const root = document.documentElement || document.body;
    if (root) {
      mediaObserver.observe(root, { childList: true, subtree: true });
    }
  }

  function translateLocalOffline(text) {
    if (typeof SAH_translateLocal === 'function') {
      return SAH_translateLocal(text);
    }
    return null;
  }

  function flashChromeTranslateSpan(text, allowEmpty) {
    let sample = String(text || '').replace(/\s+/g, ' ').trim();
    if (!sample && allowEmpty) sample = 'caption';
    if (!sample) return;

    const host = document.body || document.documentElement;
    if (!host) return;

    const span = document.createElement('span');
    span.setAttribute('lang', 'en');
    span.setAttribute('translate', 'yes');
    span.setAttribute('aria-hidden', 'true');
    span.style.setProperty('position', 'fixed', 'important');
    span.style.setProperty('width', '1px', 'important');
    span.style.setProperty('height', '1px', 'important');
    span.style.setProperty('opacity', '0', 'important');
    span.style.setProperty('pointer-events', 'none', 'important');
    span.style.setProperty('overflow', 'hidden', 'important');
    span.style.setProperty('left', '0', 'important');
    span.style.setProperty('top', '0', 'important');
    span.textContent = sample;

    host.appendChild(span);
    requestAnimationFrame(() => {
      span.remove();
    });
  }

  function postSubtitleCue(text, meta) {
    const sample = normalizeText(text);
    if (!sample) return;

    const cueKey = meta?.cueKey || sample;
    if (processedCueKeys.has(cueKey)) return;
    processedCueKeys.add(cueKey);
    if (processedCueKeys.size > 240) {
      const first = processedCueKeys.values().next().value;
      processedCueKeys.delete(first);
    }

    const localTranslation = translateLocalOffline(sample);
    flashChromeTranslateSpan(sample);

    postSegment({
      segmentId: `cue-${Date.now()}-${segmentIndex}`,
      control: 'subtitle-cue',
      text: sample,
      localTranslation: localTranslation || undefined,
      mediaTag: meta?.mediaTag || 'video',
      trackLabel: meta?.trackLabel || '',
      ts: Date.now(),
    });
    segmentIndex += 1;
  }

  function postNoTextTracksDiagnosis() {
    if (noTextTracksPosted) return;
    noTextTracksPosted = true;
    postSegment({
      segmentId: `notracks-${Date.now()}`,
      control: 'no-text-tracks',
      text: NO_TRACKS_MSG,
      ts: Date.now(),
    });
  }

  function resetNoTextTracksDiagnosis() {
    noTextTracksPosted = false;
  }

  /**
   * Recorre el DOM (Shadow DOM + iFrames) buscando elementos <track>.
   * @returns {HTMLTrackElement[]}
   */
  function findAllTrackElements(root, iframeBlockedRefs) {
    /** @type {HTMLTrackElement[]} */
    const found = [];
    /** @type {Set<HTMLTrackElement>} */
    const seen = new Set();

    function walk(node) {
      if (!node) return;

      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = /** @type {Element} */ (node);

        if (el.tagName === 'TRACK') {
          const trackEl = /** @type {HTMLTrackElement} */ (el);
          if (!seen.has(trackEl)) {
            seen.add(trackEl);
            found.push(trackEl);
          }
        }

        if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') {
          const tracks = el.querySelectorAll('track');
          for (let i = 0; i < tracks.length; i += 1) {
            const trackEl = /** @type {HTMLTrackElement} */ (tracks[i]);
            if (!seen.has(trackEl)) {
              seen.add(trackEl);
              found.push(trackEl);
            }
          }
        }

        if (el.shadowRoot) walk(el.shadowRoot);

        if (el.tagName === 'IFRAME') {
          try {
            const frameDoc = /** @type {HTMLIFrameElement} */ (el).contentDocument;
            if (frameDoc) walk(frameDoc.documentElement || frameDoc.body);
          } catch {
            if (iframeBlockedRefs) iframeBlockedRefs.push(el);
          }
        }

        for (let i = 0; i < el.children.length; i += 1) {
          walk(el.children[i]);
        }
        return;
      }

      if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE || node.nodeType === Node.DOCUMENT_NODE) {
        const doc = /** @type {Document | DocumentFragment} */ (node);
        if ('documentElement' in doc && doc.documentElement) {
          walk(doc.documentElement);
        } else {
          for (let i = 0; i < doc.childNodes.length; i += 1) {
            walk(doc.childNodes[i]);
          }
        }
      }
    }

    walk(root || document.documentElement);
    return found;
  }

  function activateTextTrackForReading(textTrack) {
    if (!textTrack) return;
    if (textTrack.mode === 'disabled') {
      textTrack.mode = 'hidden';
    }
  }

  function extractActiveCuesFromMedia(media) {
    /** @type {Array<{ text: string, cueKey: string, trackLabel: string }>} */
    const cues = [];
    if (!media?.textTracks) return cues;

    try {
      const list = media.textTracks;
      for (let i = 0; i < list.length; i += 1) {
        const track = list[i];
        if (!track) continue;
        if (track.kind !== 'subtitles' && track.kind !== 'captions' && track.kind !== 'metadata') {
          continue;
        }

        activateTextTrackForReading(track);

        if (track.mode !== 'showing' && track.mode !== 'hidden') continue;

        const active = track.activeCues;
        if (!active || active.length === 0) continue;

        for (let j = 0; j < active.length; j += 1) {
          const cue = active[j];
          const text = normalizeText(cue.text);
          if (!text) continue;
          cues.push({
            text,
            cueKey: `${media.tagName}|${track.label}|${cue.startTime}|${cue.endTime}|${text}`,
            trackLabel: track.label || track.language || '',
          });
        }
      }
    } catch {
      /* pistas inaccesibles en este reproductor */
    }

    return cues;
  }

  function collectMediaWithTracks() {
    const blocked = [];
    const trackElements = findAllTrackElements(document.documentElement, blocked);
    const mediaElements = collectAllMediaElements();
    /** @type {HTMLMediaElement[]} */
    const withTracks = [];

    for (let i = 0; i < mediaElements.length; i += 1) {
      const media = mediaElements[i];
      const hasTrackEl = media.querySelector('track') !== null;
      const hasTextTrack = media.textTracks && media.textTracks.length > 0;
      if (hasTrackEl || hasTextTrack) withTracks.push(media);
    }

    for (let i = 0; i < trackElements.length; i += 1) {
      const trackEl = trackElements[i];
      const parent = trackEl.parentElement;
      if (parent && (parent.tagName === 'VIDEO' || parent.tagName === 'AUDIO')) {
        if (!withTracks.includes(/** @type {HTMLMediaElement} */ (parent))) {
          withTracks.push(/** @type {HTMLMediaElement} */ (parent));
        }
      }
    }

    return { trackElements, mediaWithTracks: withTracks, blockedIframes: blocked };
  }

  function extractDomSubtitleTexts(root) {
    /** @type {Array<{ text: string, cueKey: string }>} */
    const results = [];
    const seen = new Set();

    function walk(node) {
      if (!node) return;

      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = /** @type {Element} */ (node);

        for (let s = 0; s < LIVE_CAPTION_SELECTORS.length; s += 1) {
          if (el.matches && el.matches(LIVE_CAPTION_SELECTORS[s])) {
            const text = normalizeText(el.innerText || el.textContent);
            if (text.length >= MIN_TEXT_LEN && !seen.has(text)) {
              seen.add(text);
              results.push({
                text,
                cueKey: `dom|${LIVE_CAPTION_SELECTORS[s]}|${text}`,
              });
            }
          }
        }

        if (el.shadowRoot) walk(el.shadowRoot);

        if (el.tagName === 'IFRAME') {
          try {
            const frameDoc = /** @type {HTMLIFrameElement} */ (el).contentDocument;
            if (frameDoc) walk(frameDoc.documentElement || frameDoc.body);
          } catch {
            /* iframe bloqueado */
          }
        }

        for (let i = 0; i < el.children.length; i += 1) {
          walk(el.children[i]);
        }
      } else if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE || node.nodeType === Node.DOCUMENT_NODE) {
        const doc = /** @type {Document | DocumentFragment} */ (node);
        if ('documentElement' in doc && doc.documentElement) walk(doc.documentElement);
        else {
          for (let i = 0; i < doc.childNodes.length; i += 1) {
            walk(doc.childNodes[i]);
          }
        }
      }
    }

    walk(root || document.documentElement);
    return results;
  }

  function startLiveCaptionStream(media) {
    liveCaptionActive = true;
    bindTextTracks(media);
    pollSubtitleCues();
    if (subtitlePollTimer) clearInterval(subtitlePollTimer);
    subtitlePollTimer = window.setInterval(pollSubtitleCues, SUBTITLE_POLL_MS);
  }

  function bindTextTracks(media) {
    if (!media || media.__sahTrackBound) return;

    try {
      media.__sahTrackBound = true;

      const list = media.textTracks;
      if (!list || list.length === 0) return;

      for (let i = 0; i < list.length; i += 1) {
        const track = list[i];
        if (!track || typeof track.addEventListener !== 'function') continue;
        track.addEventListener('cuechange', () => {
          pollSubtitleCues();
        }, { passive: true });
      }
    } catch {
      /* reproductor sin pistas de subtítulos accesibles */
    }
  }

  let lastEmittedCues = new Map();

  function pollSubtitleCues() {
    try {
      const scan = collectMediaWithTracks();
      const domCaptions = extractDomSubtitleTexts(document.documentElement);
      let emitted = false;
      const currentCues = new Map();

      for (let i = 0; i < scan.mediaWithTracks.length; i += 1) {
        const media = scan.mediaWithTracks[i];
        bindTextTracks(media);
        const cues = extractActiveCuesFromMedia(media);
        for (let j = 0; j < cues.length; j += 1) {
          const cue = cues[j];
          currentCues.set(cue.cueKey, { text: cue.text, mediaTag: media.tagName.toLowerCase(), trackLabel: cue.trackLabel });
        }
      }

      for (let k = 0; k < domCaptions.length; k += 1) {
        const cap = domCaptions[k];
        currentCues.set(cap.cueKey, { text: cap.text, mediaTag: 'caption-div', trackLabel: 'dom' });
      }

      for (const [key, data] of currentCues.entries()) {
        if (!lastEmittedCues.has(key) || lastEmittedCues.get(key).text !== data.text) {
          emitted = true;
          postSubtitleCue(data.text, {
            cueKey: key,
            mediaTag: data.mediaTag,
            trackLabel: data.trackLabel,
          });
        }
      }
      
      lastEmittedCues = currentCues;

      if (emitted) {
        resetNoTextTracksDiagnosis();
        return;
      }

      if (liveCaptionActive && scan.trackElements.length === 0 && domCaptions.length === 0) {
        return;
      }
    } catch {
      /* ignorar reproductores sin pistas CC */
    }
  }

  function startSubtitleMonitor() {
    pollSubtitleCues();
  }

  function silentReinitCcObserver() {
    try {
      scanAndBindMedia(document);
      startSubtitleMonitor();

      const playing = findPlayingMediaList();
      for (let i = 0; i < playing.length; i += 1) {
        startLiveCaptionStream(playing[i]);
      }
      return true;
    } catch {
      return false;
    }
  }

  function bindSilentReinitListener() {
    document.addEventListener(REINIT_EVENT, () => {
      silentReinitCcObserver();
    }, { capture: false, passive: true });
  }

  async function bootMediaCapture() {
    observeMediaElements();
    startPlaybackMonitor();
    startSubtitleMonitor();
    bindSilentReinitListener();
    findAndBindMedia(document.documentElement);

    window.__sahReinitMediaCapture = silentReinitCcObserver;
  }

  function boot() {
    if (window[BOOT_FLAG]) return;
    window[BOOT_FLAG] = true;

    bootMediaCapture();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
