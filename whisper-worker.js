import { pipeline, env } from './transformers.min.js';

// Bloquear peticiones de red a huggingface.co y usar la carpeta local
env.allowRemoteModels = false;
env.localModelPath = './models/';
env.useBrowserCache = false;

let transcriber = null;

async function initTranscriber() {
  if (transcriber) return transcriber;
  
  self.postMessage({ type: 'STATUS', status: 'Cargando modelo local Whisper (puede tardar unos segundos)...' });
  
  transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
  return transcriber;
}

self.addEventListener('message', async (e) => {
  const { type, audioData, msgId } = e.data;

  if (type === 'INIT') {
    try {
      await initTranscriber();
      self.postMessage({ type: 'INIT_OK', msgId });
    } catch (err) {
      self.postMessage({ type: 'INIT_ERR', msgId, error: err.message });
    }
  } else if (type === 'TRANSCRIBE') {
    try {
      const model = await initTranscriber();
      
      const result = await model(audioData, {
        chunk_length_s: 30,
        stride_length_s: 5,
        language: 'english',
        task: 'transcribe',
      });
      
      self.postMessage({ type: 'TRANSCRIBE_OK', msgId, text: result.text });
    } catch (err) {
      self.postMessage({ type: 'TRANSCRIBE_ERR', msgId, error: err.message });
    }
  }
});
