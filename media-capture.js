/**
 * Procesamiento pasivo de flujo multimedia — MAIN world.
 * captureStream() + AudioContext; suspendido hasta gesto circular.
 * Segmentos vía postMessage (sin getUserMedia).
 */
(function () {
  'use strict';

  const BOOT_FLAG = '__sahMediaCaptureBooted';
  const GESTURE_CAPTURE_EVENT = '__sah_gesture_capture';
  const BRIDGE_CHANNEL = '__sah_media_bridge';

  const SEGMENT_MS = 7000;
  const MIN_SEGMENT_MS = 5000;
  const MAX_SEGMENT_MS = 10000;
  const SILENCE_RMS = 0.002;
  const TARGET_SAMPLE_RATE = 16000;
  const PROCESSOR_BUFFER = 8192;

  /** @type {AudioContext | null} */
  let audioContext = null;
  /** @type {MediaStreamAudioSourceNode | null} */
  let streamSource = null;
  /** @type {ScriptProcessorNode | null} */
  let processorNode = null;
  /** @type {GainNode | null} */
  let silentGain = null;
  /** @type {HTMLMediaElement | null} */
  let boundMedia = null;
  /** @type {Float32Array[]} */
  let sampleChunks = [];
  let segmentStartedAt = 0;
  let segmentIndex = 0;
  let capturing = false;
  let flushTimer = null;

  function ensureAudioContext() {
    if (!audioContext || audioContext.state === 'closed') {
      audioContext = new AudioContext();
    }
    return audioContext;
  }

  function findMediaAtPoint(x, y) {
    let node = document.elementFromPoint(x, y);
    while (node) {
      if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') return node;
      node = node.parentElement;
    }
    return null;
  }

  function findActiveMedia() {
    const nodes = document.querySelectorAll('video, audio');
    for (let i = 0; i < nodes.length; i += 1) {
      const media = nodes[i];
      if (!media.paused && !media.ended && media.readyState >= 2) return media;
    }
    return null;
  }

  function getMediaStream(media) {
    if (typeof media.captureStream === 'function') return media.captureStream();
    if (typeof media.mozCaptureStream === 'function') return media.mozCaptureStream();
    return null;
  }

  function computeRms(samples) {
    if (!samples.length) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
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

  function postSegment(payload) {
    window.postMessage({
      channel: BRIDGE_CHANNEL,
      type: 'MEDIA_SEGMENT',
      payload,
    }, '*');
  }

  function flushSegment(force) {
    if (!sampleChunks.length) return;

    const ctx = audioContext;
    if (!ctx) return;

    const merged = mergeSamples(sampleChunks);
    sampleChunks = [];

    const durationMs = Math.round((merged.length / ctx.sampleRate) * 1000);
    if (!force && durationMs < MIN_SEGMENT_MS) {
      sampleChunks.push(merged);
      return;
    }

    const rms = computeRms(merged);
    if (rms < SILENCE_RMS) return;

    const resampled = downsampleBuffer(merged, ctx.sampleRate, TARGET_SAMPLE_RATE);
    const wavBase64 = encodeWavBase64(resampled, TARGET_SAMPLE_RATE);
    const segmentId = `${Date.now()}-${segmentIndex}`;
    segmentIndex += 1;

    postSegment({
      segmentId,
      durationMs,
      sampleRate: TARGET_SAMPLE_RATE,
      mediaTag: boundMedia?.tagName?.toLowerCase() || 'unknown',
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

  function scheduleFlushTimer() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = window.setTimeout(() => {
      flushTimer = null;
      if (capturing) {
        flushSegment(true);
        scheduleFlushTimer();
      }
    }, SEGMENT_MS);
  }

  function teardownGraph() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    if (processorNode) {
      processorNode.onaudioprocess = null;
      try { processorNode.disconnect(); } catch { /* noop */ }
      processorNode = null;
    }

    if (streamSource) {
      try { streamSource.disconnect(); } catch { /* noop */ }
      streamSource = null;
    }

    if (silentGain) {
      try { silentGain.disconnect(); } catch { /* noop */ }
      silentGain = null;
    }

    sampleChunks = [];
    boundMedia = null;
  }

  async function suspendContext() {
    const ctx = audioContext;
    if (ctx && ctx.state !== 'closed' && ctx.state !== 'suspended') {
      try {
        await ctx.suspend();
      } catch {
        /* context ya cerrado */
      }
    }
  }

  async function stopCapture() {
    capturing = false;
    flushSegment(true);
    teardownGraph();

    if (boundMedia) {
      boundMedia.removeEventListener('pause', onMediaPaused);
      boundMedia.removeEventListener('ended', onMediaEnded);
    }

    await suspendContext();
  }

  function onMediaPaused() {
    if (capturing) flushSegment(true);
  }

  function onMediaEnded() {
    stopCapture();
  }

  async function startCapture(media) {
    if (!media) return false;

    const stream = getMediaStream(media);
    if (!stream) return false;

    const tracks = stream.getAudioTracks();
    if (!tracks.length) return false;

    if (capturing) await stopCapture();

    const ctx = ensureAudioContext();
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        return false;
      }
    }

    streamSource = ctx.createMediaStreamSource(stream);
    processorNode = ctx.createScriptProcessor(PROCESSOR_BUFFER, 1, 1);
    silentGain = ctx.createGain();
    silentGain.gain.value = 0;

    segmentStartedAt = Date.now();
    sampleChunks = [];
    boundMedia = media;
    capturing = true;

    processorNode.onaudioprocess = (event) => {
      if (!capturing) return;
      const input = event.inputBuffer.getChannelData(0);
      sampleChunks.push(new Float32Array(input));

      const elapsed = Date.now() - segmentStartedAt;
      if (elapsed >= MIN_SEGMENT_MS && elapsed <= MAX_SEGMENT_MS) {
        flushSegment(true);
        segmentStartedAt = Date.now();
      }
    };

    streamSource.connect(processorNode);
    processorNode.connect(silentGain);
    silentGain.connect(ctx.destination);

    media.addEventListener('pause', onMediaPaused, { passive: true });
    media.addEventListener('ended', onMediaEnded, { passive: true });

    scheduleFlushTimer();
    return true;
  }

  async function toggleCaptureAtPoint(x, y) {
    if (capturing) {
      await stopCapture();
      postSegment({
        segmentId: `ctrl-${Date.now()}`,
        control: 'capture-stopped',
        ts: Date.now(),
      });
      return;
    }

    const media = findMediaAtPoint(x, y) || findActiveMedia();
    if (!media) return;

    const started = await startCapture(media);
    if (started) {
      postSegment({
        segmentId: `ctrl-${Date.now()}`,
        control: 'capture-started',
        mediaTag: media.tagName.toLowerCase(),
        ts: Date.now(),
      });
    }
  }

  function onGestureCapture(event) {
    const detail = event?.detail;
    const x = detail?.x;
    const y = detail?.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    toggleCaptureAtPoint(x, y);
  }

  function boot() {
    if (window[BOOT_FLAG]) return;
    window[BOOT_FLAG] = true;

    ensureAudioContext().suspend().catch(() => {});

    document.addEventListener(GESTURE_CAPTURE_EVENT, onGestureCapture, {
      capture: false,
      passive: true,
    });

    // Auto-capture playing media
    const tryAutoCapture = async (media) => {
      if (capturing || !media) return;
      const started = await startCapture(media);
      if (started) {
        postSegment({
          segmentId: `ctrl-${Date.now()}`,
          control: 'capture-started',
          mediaTag: media.tagName.toLowerCase(),
          ts: Date.now(),
        });
      }
    };

    document.addEventListener('play', (e) => {
      if (e.target && (e.target.tagName === 'AUDIO' || e.target.tagName === 'VIDEO')) {
        tryAutoCapture(e.target);
      }
    }, true);

    const active = findActiveMedia();
    if (active) {
      tryAutoCapture(active);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
