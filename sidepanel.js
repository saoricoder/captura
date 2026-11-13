(function () {
  'use strict';

  const MSG_TRANSLATE = 'TRANSLATE_TEXT';
  const MSG_MEDIA_SEGMENT = 'MEDIA_SEGMENT';
  const MSG_CLOSE_PANEL = 'CLOSE_PANEL';
  const MSG_PANEL_DISMISSED = 'PANEL_DISMISSED';
  const MSG_HEALTH_PANEL_READY = 'SAH_HEALTH_PANEL_READY';
  const MSG_HEALTH_QUERY = 'SAH_HEALTH_QUERY';
  const LANG_OPTS = { sourceLanguage: 'en', targetLanguage: 'es' };
  const AUTO_CLEAR_MS = 7000;
  const NO_TRACKS_MSG = 'Contenido sin pistas de texto detectadas. Por favor, asegúrese de que los subtítulos (CC) estén habilitados en el reproductor';
  const SPANISH_WORD_RE = /\b(el|la|los|las|de|que|en|un|una|es|por|con|para|del|al|como|pero|más|muy|este|esta|hay|ser|estar|también|qué|cuando|donde|porque|hola|gracias|señor|señora|nos|son|fue|era|tiene|tengo|puede|puedo|está|estoy|soy|eres|somos|ellos|ellas|quien|quienes|algo|nada|todo|todos|todas|aquí|allí|ahora|después|antes|mismo|misma|muy|bien|mal|día|año|años|vez|veces|hacer|hecho|decir|dice|dijo|voy|vas|van|vamos|ir|ver|veo|ves|ven|sabe|saber|quiere|quiero|quieren|creo|crees|creemos|porqué|porque|aunque|mientras|desde|hasta|sobre|bajo|entre|contra|sin|según|hacia|donde|cuál|cuales|cuales|cuánto|cuánta|cuántos|cuántas|ningún|ninguna|algún|alguna|otro|otra|otros|otras|muy|poco|mucha|mucho|pocos|pocas|gente|persona|personas|mundo|vida|tiempo|parte|partes|país|país|ciudad|caso|casos|forma|formas|mano|manos|hecho|hechos|momento|momento|momento|lugar|lugares|nombre|nombres|trabajo|trabajos|grupo|grupos|problema|problemas|hecho|hechos|hecho|hechos)\b/gi;
  const SPANISH_CHAR_RE = /[ñáéíóúü¿¡]/i;

  const sourceEl = document.getElementById('source-text');
  const resultEl = document.getElementById('result-text');
  const mediaTranscriptEl = document.getElementById('media-transcript');
  const mediaTranslationEl = document.getElementById('media-translation');
  const statusEl = document.getElementById('status');

  let translator = null;
  let translatorPromise = null;
  let nativeTranslatorUnavailable = false;
  let nativeTranscriberUnavailable = false;

  let whisperWorker = null;
  let whisperMsgId = 0;
  const whisperPending = new Map();

  function initWhisperWorker() {
    if (!whisperWorker) {
      whisperWorker = new Worker('whisper-worker.js', { type: 'module' });
      whisperWorker.addEventListener('message', (e) => {
        const data = e.data;
        if (data.type === 'STATUS') {
          setStatus(data.status, false);
        } else if (data.msgId !== undefined && whisperPending.has(data.msgId)) {
          const { resolve, reject } = whisperPending.get(data.msgId);
          whisperPending.delete(data.msgId);
          if (data.error) reject(new Error(data.error));
          else resolve(data);
        }
      });
      // Iniciar carga del modelo en background
      whisperWorker.postMessage({ type: 'INIT', msgId: ++whisperMsgId });
    }
    return whisperWorker;
  }

  let activeTextRequest = 0;
  let lastProcessedTextTs = 0;
  /** @type {Map<string, boolean>} */
  const processedSegments = new Map();
  /** @type {Array<object>} */
  const mediaQueue = [];
  let mediaProcessing = false;
  let mediaClearTimer = null;
  let skipTranslationForSession = false;

  function setStatus(message, isError) {
    if (!message) {
      statusEl.classList.add('status--hidden');
      return;
    }
    statusEl.textContent = message;
    statusEl.classList.toggle('status--error', Boolean(isError));
    statusEl.classList.remove('status--hidden');
  }

  function isValidTranslateMessage(message) {
    return message?.type === MSG_TRANSLATE
      && typeof message.text === 'string'
      && message.text.trim().length > 0;
  }

  function isValidMediaMessage(message) {
    return message?.type === MSG_MEDIA_SEGMENT && typeof message.segmentId === 'string';
  }

  function isTranslationAllowed(result) {
    if (result === false || result === 'no' || result === 'unavailable') return false;
    if (result === true || result === 'yes' || result === 'readily') return true;
    if (result === 'available' || result === 'downloadable') return true;
    return result !== 'no';
  }

  function base64ToUint8Array(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async function ensureNativeTranslator() {
    if (nativeTranslatorUnavailable) {
      return { instance: null, error: 'Traductor nativo no disponible en esta sesión' };
    }
    if (translator) return { instance: translator, error: null };
    if (translatorPromise) return translatorPromise;

    translatorPromise = (async () => {
      try {
        if (!window.translation?.createTranslator && typeof Translator === 'undefined') {
          return { instance: null, error: 'API de traducción nativa no presente' };
        }

        if (window.translation?.createTranslator) {
          let canTranslate = 'yes';
          if (window.translation.canTranslate) {
            canTranslate = await window.translation.canTranslate(LANG_OPTS);
          }
          if (!isTranslationAllowed(canTranslate)) {
            return { instance: null, error: `canTranslate: ${String(canTranslate)}` };
          }
          translator = await window.translation.createTranslator(LANG_OPTS);
          if (translator?.translate) return { instance: translator, error: null };
        }

        if (typeof Translator !== 'undefined' && Translator.create) {
          let availability = 'readily';
          if (Translator.availability) {
            availability = await Translator.availability(LANG_OPTS);
          }
          if (!isTranslationAllowed(availability)) {
            return { instance: null, error: `availability: ${String(availability)}` };
          }
          translator = await Translator.create({
            ...LANG_OPTS,
            monitor(m) {
              m.addEventListener('downloadprogress', () => {});
            },
          });
          if (translator?.translate) return { instance: translator, error: null };
        }

        return { instance: null, error: 'Instancia de traducción no usable' };
      } catch (error) {
        return { instance: null, error: error?.message || String(error) };
      } finally {
        translatorPromise = null;
      }
    })();

    const outcome = await translatorPromise;
    if (!outcome?.instance) nativeTranslatorUnavailable = true;
    return outcome;
  }

  async function translateWithNative(text) {
    const { instance, error } = await ensureNativeTranslator();
    if (!instance?.translate) {
      return { ok: false, text: null, detail: error || 'Traductor nativo no disponible' };
    }

    try {
      const output = await instance.translate(text);
      const trimmed = output?.trim() || '';
      if (!trimmed) return { ok: false, text: null, detail: 'Traducción nativa vacía' };
      return { ok: true, text: trimmed, source: 'native', detail: null };
    } catch (error) {
      nativeTranslatorUnavailable = true;
      return { ok: false, text: null, detail: error?.message || String(error) };
    }
  }

  function translateWithLocalDictionary(text) {
    if (typeof SAH_translateLocal === 'function') {
      const hit = SAH_translateLocal(text);
      if (hit) {
        return { ok: true, text: hit, source: 'local-dict', detail: null };
      }
    }
    return { ok: false, text: null, detail: null };
  }

  function normalizeCompareText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function logTraductor(label, value) {
    console.log(`[TRADUCTOR] ${label}: ${value}`);
  }

  async function translateWithGoogleFetch(text) {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=es&dt=t&q=${encodeURIComponent(text)}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!Array.isArray(data?.[0])) return null;

    const output = data[0]
      .map((segment) => (Array.isArray(segment) ? segment[0] : ''))
      .join('')
      .trim();

    return output || null;
  }

  async function translateWithBrowserBridge(text) {
    const bridge = document.getElementById('browser-translate-bridge');
    if (!bridge) return null;

    bridge.lang = 'en';
    bridge.setAttribute('translate', 'yes');
    bridge.textContent = text;

    await new Promise((resolve) => {
      window.setTimeout(resolve, 120);
    });

    const output = String(bridge.textContent || '').trim();
    if (!output || normalizeCompareText(output) === normalizeCompareText(text)) {
      return null;
    }

    return output;
  }

  async function translateText(text) {
    const original = String(text || '').replace(/\s+/g, ' ').trim();
    if (!original) {
      return { ok: false, text: null, detail: 'Texto vacío' };
    }

    logTraductor('Texto original', original);
    console.log('[TRADUCTOR] Procesando...');

    let result = null;
    let source = null;

    try {
      result = await translateWithGoogleFetch(original);
      if (result) source = 'google-fetch';
    } catch (error) {
      console.warn('[TRADUCTOR] Fetch a Google falló:', error);
      /* fetch bloqueado o sin red */
    }

    if (!result) {
      const nativeOutcome = await translateWithNative(original);
      if (nativeOutcome.ok && nativeOutcome.text) {
        result = nativeOutcome.text;
        source = 'native';
      }
    }

    if (!result) {
      result = await translateWithBrowserBridge(original);
      if (result) source = 'browser-bridge';
    }

    if (!result) {
      const localOutcome = translateWithLocalDictionary(original);
      if (localOutcome.ok && localOutcome.text) {
        result = localOutcome.text;
        source = 'local-dict';
      }
    }

    if (!result) {
      console.error('[TRADUCTOR ERROR] Fallo en motor de traducción.');
      return {
        ok: false,
        text: null,
        detail: 'Motor de traducción sin respuesta',
      };
    }

    logTraductor('Resultado', result);

    if (normalizeCompareText(result) === normalizeCompareText(original)) {
      console.log(`[TRADUCTOR] La traducción es idéntica al texto original: "${original}". Se usará de todos modos.`);
    }

    return {
      ok: true,
      text: result,
      source: source || 'unknown',
      detail: null,
    };
  }

  async function transcribeWithNative(asset) {
    if (nativeTranscriberUnavailable) {
      return { ok: false, text: null, detail: 'Transcripción local no disponible' };
    }

    try {
      const worker = initWhisperWorker();
      const bytes = base64ToUint8Array(asset.data);
      const pcmData = new Int16Array(bytes.buffer, bytes.byteOffset + 44);
      const float32Array = new Float32Array(pcmData.length);
      for (let i = 0; i < pcmData.length; i++) {
        float32Array[i] = pcmData[i] / 32768.0;
      }
      
      const msgId = ++whisperMsgId;
      return new Promise((resolve) => {
        whisperPending.set(msgId, { resolve: (res) => resolve(res), reject: (err) => resolve({ error: err }) });
        worker.postMessage({ type: 'TRANSCRIBE', msgId, audioData: float32Array });
      }).then((result) => {
        if (result.error) throw result.error;
        const text = String(result.text || '').trim();
        if (text) {
          setStatus(null, false); // Limpiar mensaje de estado si lo hubiera
          return { ok: true, text, source: 'local-whisper', detail: null };
        }
        return { ok: false, text: null, detail: '(Silencio o audio sin voz)' };
      });
    } catch (error) {
      nativeTranscriberUnavailable = true;
      console.error('[WHISPER ERROR]', error);
      return { ok: false, text: null, detail: error?.message || String(error) };
    }
  }

  function hasNativeTranslationApi() {
    return Boolean(window.translation?.createTranslator)
      || typeof Translator !== 'undefined';
  }

  async function transcribeAsset(asset) {
    const nativeOutcome = await transcribeWithNative(asset);
    if (nativeOutcome.ok) return nativeOutcome;

    return {
      ok: false,
      text: null,
      detail: nativeOutcome.detail || NO_TRACKS_MSG,
    };
  }

  function setMediaFragment(targetEl, text) {
    targetEl.textContent = text || '';
    targetEl.scrollTop = 0;
  }

  function wipeDisplayBuffers() {
    sourceEl.innerHTML = '';
    resultEl.innerHTML = '';
    mediaTranscriptEl.innerHTML = '';
    mediaTranslationEl.innerHTML = '';
    setStatus(null);
  }

  function scheduleMemoryWipe() {
    if (mediaClearTimer) clearTimeout(mediaClearTimer);
    mediaClearTimer = setTimeout(() => {
      mediaClearTimer = null;
      wipeDisplayBuffers();
    }, AUTO_CLEAR_MS);
  }

  function isLikelySpanish(text) {
    const sample = String(text || '').trim();
    if (!sample) return false;
    if (SPANISH_CHAR_RE.test(sample)) return true;

    const words = sample.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return false;

    const matches = sample.match(SPANISH_WORD_RE);
    const hitCount = matches ? matches.length : 0;
    return hitCount / words.length >= 0.2;
  }

  async function detectSpanish(text) {
    if (isLikelySpanish(text)) return true;

    try {
      if (typeof LanguageDetector !== 'undefined' && LanguageDetector.create) {
        const detector = await LanguageDetector.create();
        if (detector?.detect) {
          const result = await detector.detect(text.slice(0, 512));
          const lang = result?.language || result?.detectedLanguage || result?.[0]?.detectedLanguage;
          if (lang && String(lang).toLowerCase().startsWith('es')) return true;
        }
      }

      if (window.ai?.language?.detect) {
        const result = await window.ai.language.detect(text.slice(0, 512));
        const lang = result?.language || result?.detectedLanguage;
        if (lang && String(lang).toLowerCase().startsWith('es')) return true;
      }
    } catch {
      /* detector nativo no disponible */
    }

    return false;
  }

  async function processSubtitleCue(message) {
    const text = String(message.text || '').trim();
    if (!text) return;
    if (processedSegments.has(message.segmentId)) return;
    processedSegments.set(message.segmentId, true);
    if (processedSegments.size > 120) {
      const firstKey = processedSegments.keys().next().value;
      processedSegments.delete(firstKey);
    }

    setMediaFragment(mediaTranscriptEl, text);
    setStatus('Subtítulo extraído de pista local (<track>).');

    if (message.localTranslation) {
      setMediaFragment(mediaTranslationEl, message.localTranslation);
      setStatus('Traducción offline (diccionario local).');
      scheduleMemoryWipe();
      return;
    }

    const translationOutcome = await translateText(text);
    if (translationOutcome.ok && translationOutcome.text) {
      setMediaFragment(mediaTranslationEl, translationOutcome.text);
      const trSource = translationOutcome.source === 'local-dict'
        ? 'diccionario local'
        : 'traductor nativo';
      setStatus(`Traducción offline (${trSource}).`);
    } else {
      setMediaFragment(
        mediaTranslationEl,
        translationOutcome.detail || 'Traducción offline no disponible',
      );
      setStatus('Subtítulo capturado; traducción offline pendiente.', true);
    }
    scheduleMemoryWipe();
  }

  async function processMediaControl(message) {
    if (message.control === 'no-text-tracks') {
      setMediaFragment(mediaTranscriptEl, message.text || NO_TRACKS_MSG);
      setMediaFragment(mediaTranslationEl, '');
      if (mediaClearTimer) {
        clearTimeout(mediaClearTimer);
        mediaClearTimer = null;
      }
      setStatus(null);
      return;
    }

    if (message.control === 'subtitle-cue') {
      await processSubtitleCue(message);
      return;
    }

    if (message.control === 'capture-started') {
      skipTranslationForSession = false;
      setMediaFragment(mediaTranscriptEl, 'Capturando audio…');
      setMediaFragment(mediaTranslationEl, '');
      if (mediaClearTimer) {
        clearTimeout(mediaClearTimer);
        mediaClearTimer = null;
      }
      setStatus('Captura global de audio activa.');
      return;
    }

    if (message.control === 'stream-status') {
      if (message.streamActive) {
        setMediaFragment(mediaTranscriptEl, 'Capturando audio…');
        setStatus('Flujo de audio recibido.');
        if (mediaClearTimer) {
          clearTimeout(mediaClearTimer);
          mediaClearTimer = null;
        }
      } else {
        setMediaFragment(mediaTranscriptEl, 'Sin segmentos de audio activos.');
        setStatus(null);
      }
      return;
    }

    if (message.control === 'capture-stopped') {
      skipTranslationForSession = false;
      setMediaFragment(mediaTranscriptEl, 'Sin segmentos de audio activos.');
      setMediaFragment(mediaTranslationEl, '');
      if (mediaClearTimer) {
        clearTimeout(mediaClearTimer);
        mediaClearTimer = null;
      }
      setStatus('Transcripción multimedia detenida.');
    }
  }

  async function processMediaSegment(message) {
    if (message.control) {
      await processMediaControl(message, message._senderTabId);
      return;
    }

    if (!message.asset?.data) return;
    if (processedSegments.has(message.segmentId)) return;
    processedSegments.set(message.segmentId, true);
    if (processedSegments.size > 120) {
      const firstKey = processedSegments.keys().next().value;
      processedSegments.delete(firstKey);
    }

    setStatus(`Procesando segmento (${message.durationMs || '?'} ms)…`);

    const transcriptOutcome = await transcribeAsset(message.asset);
    if (!transcriptOutcome.ok || !transcriptOutcome.text) {
      setMediaFragment(mediaTranscriptEl, transcriptOutcome.detail || 'Transcripción fallida');
      setMediaFragment(mediaTranslationEl, '');
      scheduleMemoryWipe();
      if (transcriptOutcome.detail === '(Silencio o audio sin voz)') {
        setStatus('Segmento de audio en silencio.', false);
      } else {
        setStatus('Fallo de transcripción en segmento.', true);
      }
      return;
    }

    setMediaFragment(mediaTranscriptEl, transcriptOutcome.text);
    scheduleMemoryWipe();

    // Restricción de idioma desactivada a petición del usuario.
    // La aplicación traducirá el audio/texto capturado sin importar el idioma origen.
    skipTranslationForSession = false;

    const translationOutcome = await translateText(transcriptOutcome.text);
    if (!translationOutcome.ok || !translationOutcome.text) {
      setMediaFragment(mediaTranslationEl, translationOutcome.detail || 'Traducción fallida');
      scheduleMemoryWipe();
      setStatus('Transcripción OK; traducción fallida.', true);
      return;
    }

    setMediaFragment(mediaTranslationEl, translationOutcome.text);
    scheduleMemoryWipe();

    const sttSource = transcriptOutcome.source === 'native-stt' ? 'nativa' : 'offline';
    const trSource = translationOutcome.source === 'google-fetch'
      ? 'Google Translate'
      : (translationOutcome.source === 'native'
        ? 'nativa'
        : (translationOutcome.source === 'local-dict' ? 'diccionario local' : 'offline'));
    setStatus(`Segmento: STT ${sttSource}, traducción ${trSource}.`);
  }

  function enqueueMediaSegment(message) {
    mediaQueue.push(message);
    if (!mediaProcessing) drainMediaQueue();
  }

  async function drainMediaQueue() {
    mediaProcessing = true;
    while (mediaQueue.length > 0) {
      const next = mediaQueue.shift();
      if (!next) continue;
      await processMediaSegment(next);
    }
    mediaProcessing = false;
  }

  async function processText(message) {
    if (!isValidTranslateMessage(message)) return;

    const sample = message.text.trim();
    const sourceTs = message.ts || Date.now();
    if (sourceTs <= lastProcessedTextTs) return;
    lastProcessedTextTs = sourceTs;

    const requestId = ++activeTextRequest;

    sourceEl.textContent = sample;
    resultEl.textContent = 'Traduciendo…';
    setStatus(`Captura: ${message.method || 'desconocido'}`);

    const outcome = await translateText(sample);
    if (requestId !== activeTextRequest) return;

    if (!outcome.ok || !outcome.text) {
      resultEl.textContent = outcome.detail || 'Error de traducción';
      setStatus('Fallo de traducción.', true);
      scheduleMemoryWipe();
      return;
    }

    resultEl.textContent = outcome.text;
    const statusLabel = outcome.source === 'google-fetch'
      ? 'Traducción (Google Translate).'
      : (outcome.source === 'local-dict'
        ? 'Traducción offline (diccionario local).'
        : (outcome.source === 'browser-bridge'
          ? 'Traducción (puente del navegador).'
          : (outcome.source === 'native' ? 'Traducción nativa offline.' : null)));
    setStatus(statusLabel);
    scheduleMemoryWipe();
  }

  function announceHealthReady() {
    try {
      chrome.runtime.sendMessage({ type: MSG_HEALTH_PANEL_READY, ts: Date.now() }, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      /* detención silenciosa */
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === MSG_HEALTH_QUERY) {
      sendResponse({ ok: true, sidePanelInjected: true, ts: Date.now() });
      return false;
    }

    if (message?.type === MSG_CLOSE_PANEL) {
      window.close();
      sendResponse({ ok: true });
      return false;
    }

    if (isValidTranslateMessage(message)) {
      processText(message);
      sendResponse({ ok: true, received: true });
      return false;
    }

    if (isValidMediaMessage(message)) {
      if (_sender && _sender.tab) message._senderTabId = _sender.tab.id;
      enqueueMediaSegment(message);
      sendResponse({ ok: true, received: true });
      return false;
    }

    return false;
  });

  announceHealthReady();

  // --- NUEVA LÓGICA DE CAPTURA DE AUDIO (TABCAPTURE) ---

  const TARGET_SAMPLE_RATE = 16000;
  const SEGMENT_MS = 5000;
  const MIN_SEGMENT_MS = 3000;
  const PROCESSOR_BUFFER = 8192;

  let tabCaptureStream = null;
  let audioContext = null;
  let audioWorkletNode = null;
  let silentGain = null;
  let streamSource = null;
  let workletInitPromise = null;
  
  let sampleChunks = [];
  let flushTimer = null;
  let capturingAudio = false;
  let segmentIndex = 0;
  let activeTabId = null;

  function floatTo16BitPCM(floatSamples) {
    const output = new Int16Array(floatSamples.length);
    for (let i = 0; i < floatSamples.length; i += 1) {
      const clamped = Math.max(-1, Math.min(1, floatSamples[i]));
      output[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
    return output;
  }

  function encodeWavBase64(floatSamples, sampleRate) {
    const pcm = floatTo16BitPCM(floatSamples);
    const byteRate = sampleRate * 2;
    const blockAlign = 2;
    const dataSize = pcm.length * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    function writeString(offset, text) {
      for (let i = 0; i < text.length; i += 1) {
        view.setUint8(offset + i, text.charCodeAt(i));
      }
    }

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    let writeOffset = 44;
    for (let i = 0; i < pcm.length; i += 1) {
      view.setInt16(writeOffset, pcm[i], true);
      writeOffset += 2;
    }

    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const slice = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, slice);
    }
    return btoa(binary);
  }

  function mergeSamples(chunks) {
    let total = 0;
    for (let i = 0; i < chunks.length; i += 1) total += chunks[i].length;
    const merged = new Float32Array(total);
    let offset = 0;
    for (let i = 0; i < chunks.length; i += 1) {
      merged.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    return merged;
  }

  function downsampleBuffer(buffer, inputRate, outputRate) {
    if (outputRate >= inputRate) return buffer;
    const ratio = inputRate / outputRate;
    const newLength = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLength);
    for (let i = 0; i < newLength; i += 1) {
      const idx = i * ratio;
      const lo = Math.floor(idx);
      const hi = Math.min(lo + 1, buffer.length - 1);
      const weight = idx - lo;
      result[i] = buffer[lo] * (1 - weight) + buffer[hi] * weight;
    }
    return result;
  }

  function flushTabSegment(force) {
    if (!sampleChunks.length) return;
    if (!audioContext) return;

    const merged = mergeSamples(sampleChunks);
    const overlapSamples = 10 * audioContext.sampleRate;
    let nextSampleChunks = [];
    
    if (!force) {
      if (merged.length > overlapSamples) {
        nextSampleChunks = [merged.slice(merged.length - overlapSamples)];
      } else {
        nextSampleChunks = [merged];
      }
    }

    const durationMs = Math.round((merged.length / audioContext.sampleRate) * 1000);
    if (!force && durationMs < MIN_SEGMENT_MS) {
      sampleChunks = [merged];
      return;
    }
    
    sampleChunks = nextSampleChunks;

    const resampled = downsampleBuffer(merged, audioContext.sampleRate, TARGET_SAMPLE_RATE);
    const wavBase64 = encodeWavBase64(resampled, TARGET_SAMPLE_RATE);
    const segmentId = `${Date.now()}-${segmentIndex}`;
    segmentIndex += 1;

    // Directamente encolar el mensaje simulando que llegó de la página
    enqueueMediaSegment({
      type: MSG_MEDIA_SEGMENT,
      segmentId,
      durationMs,
      sampleRate: TARGET_SAMPLE_RATE,
      mediaTag: 'tab-audio',
      asset: {
        type: 'audio/wav',
        encoding: 'base64',
        disposition: 'attachment',
        name: `segment-${segmentId}.wav`,
        data: wavBase64,
      },
      ts: Date.now(),
    });
  }

  function scheduleTabFlushTimer() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = window.setTimeout(() => {
      flushTimer = null;
      if (capturingAudio) {
        flushTabSegment(false);
        scheduleTabFlushTimer();
      }
    }, SEGMENT_MS);
  }

  async function buildTabAudioGraph(stream) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioContext = new Ctx();

    streamSource = audioContext.createMediaStreamSource(stream);

    if (!workletInitPromise) {
      const workletCode = `
        class CaptureProcessor extends AudioWorkletProcessor {
          constructor() {
            super();
            this.bufferSize = 8192;
            this.buffer = new Float32Array(this.bufferSize);
            this.offset = 0;
          }
          process(inputs, outputs, parameters) {
            const input = inputs[0];
            if (input && input.length > 0) {
              const channelData = input[0];
              for (let i = 0; i < channelData.length; i++) {
                this.buffer[this.offset] = channelData[i];
                this.offset++;
                if (this.offset >= this.bufferSize) {
                  this.port.postMessage(new Float32Array(this.buffer));
                  this.offset = 0;
                }
              }
            }
            return true;
          }
        }
        registerProcessor('capture-processor', CaptureProcessor);
      `;
      const blob = new Blob([workletCode], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(blob);
      workletInitPromise = audioContext.audioWorklet.addModule(workletUrl);
    }
    
    await workletInitPromise;
    
    audioWorkletNode = new AudioWorkletNode(audioContext, 'capture-processor');
    silentGain = audioContext.createGain();
    // IMPORTANTE: tabCapture mutea la pestaña original. Para que el usuario 
    // escuche el audio, debemos emitirlo desde el sidepanel con ganancia 1.
    silentGain.gain.value = 1;

    audioWorkletNode.port.onmessage = (event) => {
      if (!capturingAudio) return;
      sampleChunks.push(event.data);
    };

    streamSource.connect(audioWorkletNode);
    audioWorkletNode.connect(silentGain);
    silentGain.connect(audioContext.destination);

    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
      
      const checkState = () => {
        if (audioContext.state === 'suspended') {
          setStatus('⚠️ Haz clic en cualquier parte de este panel lateral para activar la transcripción de audio.', true);
          const resumeOnInteract = () => {
            if (audioContext && audioContext.state === 'suspended') {
              audioContext.resume().then(() => {
                setStatus('Capturando audio nativo de la pestaña...');
              });
            }
            document.removeEventListener('click', resumeOnInteract);
          };
          document.addEventListener('click', resumeOnInteract);
        }
      };
      // Dar un pequeño margen para ver si se reanuda inmediatamente
      setTimeout(checkState, 100);
    }
  }

  function teardownTabGraph() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (audioWorkletNode) {
      audioWorkletNode.port.onmessage = null;
      try { audioWorkletNode.disconnect(); } catch {}
      audioWorkletNode = null;
    }
    if (streamSource) {
      try { streamSource.disconnect(); } catch {}
      streamSource = null;
    }
    if (silentGain) {
      try { silentGain.disconnect(); } catch {}
      silentGain = null;
    }
    if (audioContext && audioContext.state !== 'closed') {
      try { audioContext.close(); } catch {}
    }
    audioContext = null;
    if (tabCaptureStream) {
      tabCaptureStream.getTracks().forEach(t => t.stop());
      tabCaptureStream = null;
    }
    sampleChunks = [];
  }

  async function startTabCapture(tabId) {
    if (tabCaptureStream && activeTabId === tabId) return;
    
    teardownTabGraph();
    activeTabId = tabId;
    capturingAudio = true;
    
    try {
      const streamId = await new Promise((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(id);
        });
      });

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId
          }
        },
        video: false
      });

      tabCaptureStream = stream;
      
      // Manejar si el stream se detiene por el navegador
      stream.getTracks()[0].onended = () => {
        if (capturingAudio) stopTabCapture();
      };

      await buildTabAudioGraph(stream);
      scheduleTabFlushTimer();
      
      setStatus('Capturando audio nativo de la pestaña...');
    } catch (error) {
      console.error('Error al iniciar tabCapture:', error);
      setStatus('Error al iniciar captura nativa. ¿Falta recargar la extensión?', true);
      capturingAudio = false;
    }
  }

  function stopTabCapture() {
    if (!capturingAudio) return;
    capturingAudio = false;
    flushTabSegment(true);
    teardownTabGraph();
    setStatus('Captura nativa detenida.');
  }

  // Se eliminó tabCapture para restaurar el flujo pasivo original de media-capture


  window.addEventListener('pagehide', () => {
    stopTabCapture();
    try {
      chrome.runtime.sendMessage({ type: MSG_PANEL_DISMISSED }, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      /* detención silenciosa */
    }
  }, { capture: true });
})();
