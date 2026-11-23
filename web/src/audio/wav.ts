/** WAV-кодирование для воспроизведения на камере: PCM s16le, mono, 16000 Гц (спецификация 50 §4). */

export const TARGET_SAMPLE_RATE = 16_000;
export const MAX_DURATION_MS = 30_000;

export function encodeWav(pcm: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  let clipped = false;
  for (let i = 0; i < pcm.length; i += 1) {
    const value = pcm[i] ?? 0;
    if (value < -1 || value > 1) clipped = true;
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, value)) * 0x7fff, true);
  }
  void clipped;
  return new Blob([buffer], { type: 'audio/wav' });
}

/** Декодирует любой поддерживаемый браузером аудиофайл в WAV 16 кГц mono. */
export async function audioDataToWav(data: ArrayBuffer): Promise<{ blob: Blob; durationMs: number }> {
  const decodeCtx = new AudioContext();
  try {
    const decoded = await decodeAudioCompat(decodeCtx, data);
    const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE));
    const offline = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    const pcm = rendered.getChannelData(0);
    return { blob: encodeWav(pcm, TARGET_SAMPLE_RATE), durationMs: Math.round(decoded.duration * 1000) };
  } finally {
    void decodeCtx.close();
  }
}

function decodeAudioCompat(ctx: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    ctx.decodeAudioData(
      data,
      (buffer) => resolve(buffer),
      (error) => reject(error ?? new Error('decode failed')),
    );
  });
}
