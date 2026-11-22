// Worker: lê o vídeo direto do disco do aparelho (nada é enviado para a
// internet). Tem três tarefas, comandadas por js/app.js:
//   analyze → ouve o áudio, acha as batidas, os rallies e as velocidades
//   render  → grava uma parte dos trechos com a placa de velocidade
//             (várias partes rodam em paralelo, uma por worker)
//   merge   → junta as partes num arquivo só, sem recomprimir

import {
  Input, ALL_FORMATS, BlobSource, Output, Mp4OutputFormat, StreamTarget, BufferTarget,
  AudioSampleSink, CanvasSink, EncodedPacketSink, VideoSampleSource, EncodedAudioPacketSource,
  EncodedVideoPacketSource, EncodedPacket, VideoSample,
} from '../vendor/mediabunny.min.mjs';
import {
  EnvelopeBuilder, detectHits, analyzeRallies, buildSegments, summarize, makeSpeedLookup,
} from './analysis.js';

const post = (msg) => self.postMessage(msg);
let cancelled = false;

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'cancel') { cancelled = true; return; }
  cancelled = false;
  try {
    if (msg.type === 'analyze') await analyze(msg.file, msg.settings);
    else if (msg.type === 'render') await render(msg);
    else if (msg.type === 'merge') await merge(msg);
  } catch (err) {
    console.error(err);
    post({ type: 'error', message: cancelled ? 'Cancelado.' : String(err?.message || err) });
  }
};

function checkCancel() {
  if (cancelled) throw new Error('Cancelado.');
}

function openInput(file) {
  return new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
}

// ===================================================================== analyze
async function analyze(file, settings) {
  const t0 = performance.now();
  const input = openInput(file);
  const videoTrack = await input.getPrimaryVideoTrack();
  const audioTrack = await input.getPrimaryAudioTrack();
  if (!videoTrack) throw new Error('Não encontrei vídeo nesse arquivo.');
  if (!audioTrack) throw new Error('O vídeo não tem áudio. O corte automático usa o som das batidas.');
  if (!(await videoTrack.canDecode())) {
    const codec = await videoTrack.getCodec();
    throw new Error(
      `Este navegador não consegue ler vídeo ${String(codec).toUpperCase()}. ` +
      'Use o Chrome ou Edge atualizado no computador, ou o Safari no iPhone/Mac. ' +
      'No iPhone também dá para gravar em Ajustes → Câmera → Formatos → "Mais Compatível".');
  }
  if (!(await audioTrack.canDecode())) throw new Error('Este navegador não consegue ler o áudio deste vídeo.');

  const duration = await input.computeDuration();
  const srcW = await videoTrack.getDisplayWidth();
  const srcH = await videoTrack.getDisplayHeight();
  const stats = await videoTrack.computePacketStats(120);
  const srcFps = stats.averagePacketRate || 30;

  const sampleRate = await audioTrack.getSampleRate();
  const env = new EnvelopeBuilder(sampleRate);
  let mono = new Float32Array(0), plane = new Float32Array(0);
  let lastReport = 0;
  for await (const sample of new AudioSampleSink(audioTrack).samples()) {
    const n = sample.numberOfFrames, ch = sample.numberOfChannels;
    if (mono.length < n) { mono = new Float32Array(n); plane = new Float32Array(n); }
    const m = mono.subarray(0, n), p = plane.subarray(0, n);
    sample.copyTo(m, { planeIndex: 0, format: 'f32-planar' });
    for (let c = 1; c < ch; c++) {
      sample.copyTo(p, { planeIndex: c, format: 'f32-planar' });
      for (let i = 0; i < n; i++) m[i] += p[i];
    }
    env.push(m, sample.timestamp);
    const ts = sample.timestamp;
    sample.close();
    const now = performance.now();
    if (now - lastReport > 250) {
      lastReport = now;
      checkCancel();
      post({ type: 'progress', fraction: Math.min(1, ts / duration) });
    }
  }

  const hits = detectHits(env.result(), { sensitivity: settings.sensitivity });
  const { rallies, shots } = analyzeRallies(hits, {
    distance: settings.distance, maxGap: settings.maxGap, minHits: settings.minHits,
  });
  const segments = buildSegments(rallies, duration, { pre: settings.pre, post: settings.post });
  post({
    type: 'analysis',
    duration, srcW, srcH, srcFps, size: file.size,
    hits: hits.length, rallies: rallies.length, segments, shots,
    keptDuration: segments.reduce((a, s) => a + s.end - s.start, 0),
    summary: summarize(shots),
    seconds: (performance.now() - t0) / 1000,
  });
  input.dispose();
}

// ====================================================================== render
async function render({ file, settings, segments, shots, outName, video }) {
  const input = openInput(file);
  const videoTrack = await input.getPrimaryVideoTrack();
  const audioTrack = await input.getPrimaryAudioTrack();
  const { outW, outH, outFps, srcFps, bitrate, codec } = video;

  const { target, finish } = await makeTarget(outName);
  const output = new Output({ format: mp4Format(target), target });
  const videoSource = new VideoSampleSource({
    codec, bitrate, keyFrameInterval: 2, latencyMode: 'quality', sizeChangeBehavior: 'fill',
  });
  // sem frameRate: os instantes ficam exatos nas emendas entre trechos
  output.addVideoTrack(videoSource);

  const audioCodec = await audioTrack.getCodec();
  let audioSource = null;
  if (new Mp4OutputFormat().getSupportedAudioCodecs().includes(audioCodec)) {
    audioSource = new EncodedAudioPacketSource(audioCodec);
    output.addAudioTrack(audioSource);
  }
  await output.start();

  const audioPackets = new EncodedPacketSink(audioTrack);
  const audioMeta = { decoderConfig: await audioTrack.getDecoderConfig() };
  let firstAudio = true;

  const canvasSink = new CanvasSink(videoTrack, { width: outW, height: outH, fit: 'fill', poolSize: 2 });
  const lookup = makeSpeedLookup(shots);
  const overlay = new Overlay(outW, outH, settings);

  let framesDone = 0, framesReported = 0, outTime = 0, lastReport = 0;

  for (const seg of segments) {
    checkCancel();
    // Áudio do trecho, copiado sem recomprimir. O vídeo acompanha exatamente
    // a duração do áudio, para não perder a sincronia ao longo do jogo.
    let srcStart = seg.start, segDur = seg.end - seg.start;
    if (audioSource) {
      const list = [];
      let p = await audioPackets.getPacket(seg.start);
      if (p && p.timestamp < seg.start - 1e-3) p = await audioPackets.getNextPacket(p);
      while (p && p.timestamp < seg.end) { list.push(p); p = await audioPackets.getNextPacket(p); }
      if (list.length) {
        srcStart = list[0].timestamp;
        segDur = list.reduce((a, q) => a + q.duration, 0);
        for (const q of list) {
          const pk = new EncodedPacket(q.data, q.type, outTime + (q.timestamp - srcStart), q.duration);
          await audioSource.add(pk, firstAudio ? audioMeta : undefined);
          firstAudio = false;
        }
      }
    }

    // Quadros do trecho, numa grade fixa de tempo (60 fps → 30 fps pula metade).
    // o último quadro começa pelo menos meio quadro antes do fim do trecho,
    // para nunca encostar no primeiro quadro do trecho seguinte
    const n = Math.max(1, Math.floor(segDur * outFps - 0.5) + 1);
    const times = [];
    for (let k = 0; k < n; k++) times.push(srcStart + k / outFps + 0.25 / srcFps);
    let k = 0;
    for await (const wrapped of canvasSink.canvasesAtTimestamps(times)) {
      const ts = outTime + k / outFps;
      const dur = k === n - 1 ? Math.max(1 / outFps / 4, outTime + segDur - ts) : 1 / outFps;
      const srcT = times[k];
      k++;
      if (!wrapped) continue;
      overlay.draw(wrapped.canvas.getContext('2d'), lookup(srcT));
      const vs = new VideoSample(wrapped.canvas, { timestamp: ts, duration: dur });
      await videoSource.add(vs);
      vs.close();
      framesDone++;
      const now = performance.now();
      if (now - lastReport > 250) {
        lastReport = now;
        checkCancel();
        post({ type: 'frames', count: framesDone - framesReported });
        framesReported = framesDone;
      }
    }
    outTime += segDur;
  }
  post({ type: 'frames', count: framesDone - framesReported });
  await output.finalize();
  post({ type: 'rendered', ...(await finish()), duration: outTime });
  input.dispose();
}

// ======================================================================= merge
async function merge({ parts, outName }) {
  const { target, finish } = await makeTarget(outName);
  const output = new Output({ format: mp4Format(target), target });
  const root = await navigator.storage.getDirectory();
  const inputs = [];
  for (const p of parts) {
    const f = p.blob ?? await (await root.getFileHandle(p.name)).getFile();
    inputs.push({ input: openInput(f), duration: p.duration });
  }
  const v0 = await inputs[0].input.getPrimaryVideoTrack();
  const a0 = await inputs[0].input.getPrimaryAudioTrack();
  const videoSource = new EncodedVideoPacketSource(await v0.getCodec());
  output.addVideoTrack(videoSource);
  let audioSource = null;
  if (a0) {
    audioSource = new EncodedAudioPacketSource(await a0.getCodec());
    output.addAudioTrack(audioSource);
  }
  await output.start();

  let offset = 0, first = true, lastReport = 0, done = 0;
  const total = parts.reduce((a, p) => a + p.duration, 0);
  for (const { input, duration } of inputs) {
    checkCancel();
    const vt = await input.getPrimaryVideoTrack();
    const at = await input.getPrimaryAudioTrack();
    const vMeta = first ? { decoderConfig: await vt.getDecoderConfig() } : undefined;
    const aMeta = first && at ? { decoderConfig: await at.getDecoderConfig() } : undefined;
    const vIt = new EncodedPacketSink(vt).packets();
    const aIt = at ? new EncodedPacketSink(at).packets() : null;
    let v = (await vIt.next()).value, a = aIt ? (await aIt.next()).value : null;
    let firstV = true, firstA = true;
    // intercala áudio e vídeo pela ordem de tempo
    while (v || a) {
      if (v && (!a || v.timestamp <= a.timestamp)) {
        await videoSource.add(shift(v, offset), firstV ? vMeta : undefined);
        firstV = false;
        v = (await vIt.next()).value;
      } else {
        if (audioSource) await audioSource.add(shift(a, offset), firstA ? aMeta : undefined);
        firstA = false;
        a = (await aIt.next()).value;
      }
      const now = performance.now();
      if (now - lastReport > 250) {
        lastReport = now;
        checkCancel();
        const t = Math.min(v?.timestamp ?? duration, a?.timestamp ?? duration);
        post({ type: 'progress', fraction: Math.min(1, (done + t) / total) });
      }
    }
    offset += duration;
    done += duration;
    first = false;
    input.dispose();
  }
  await output.finalize();
  for (const p of parts) {
    if (!p.blob) try { await root.removeEntry(p.name); } catch { /* ignora */ }
  }
  post({ type: 'merged', ...(await finish()), duration: offset });
}

const shift = (p, off) => new EncodedPacket(p.data, p.type, p.timestamp + off, p.duration);

// ===================================================================== saída
function mp4Format(target) {
  return new Mp4OutputFormat({ fastStart: target instanceof BufferTarget ? 'in-memory' : false });
}

/**
 * Grava no armazenamento privado do navegador (OPFS), direto no disco, para
 * não estourar a memória com jogos longos. Se não houver suporte, usa a memória.
 */
async function makeTarget(name) {
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(name, { create: true });
    const handle = await fh.createSyncAccessHandle();
    handle.truncate(0);
    const writable = new WritableStream({
      write(chunk) { handle.write(chunk.data, { at: chunk.position }); },
      close() { handle.flush(); handle.close(); },
      abort() { try { handle.close(); } catch { /* já fechado */ } },
    });
    return {
      target: new StreamTarget(writable, { chunked: true, chunkSize: 8 * 1024 * 1024 }),
      finish: async () => ({ storage: 'opfs', name }),
    };
  } catch (err) {
    console.warn('OPFS indisponível, gravando na memória', err);
    const target = new BufferTarget();
    return {
      target,
      finish: async () => ({ storage: 'blob', name, blob: new Blob([target.buffer], { type: 'video/mp4' }) }),
    };
  }
}

// ==================================================================== placa
/** Placa de velocidade no canto superior direito. */
class Overlay {
  constructor(w, h, settings) {
    this.u = Math.min(w, h) / 720; // unidade proporcional ao tamanho do vídeo
    this.w = w;
    this.names = { near: settings.nearName, far: settings.farName };
    this.factor = settings.exitSpeed ? 1.35 : 1;
    this.unit = settings.exitSpeed ? 'km/h (estim. raquete)' : 'km/h (média)';
    this.colors = { near: '#2dd4bf', far: '#fbbf24' };
    this.font = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  }

  draw(ctx, shot) {
    if (!shot) return;
    const u = this.u;
    const boxW = 250 * u, boxH = 124 * u, m = 22 * u;
    const x = this.w - boxW - m, y = m, right = x + boxW - 18 * u;
    const color = this.colors[shot.player] || '#e5e7eb';
    ctx.save();
    ctx.fillStyle = 'rgba(10, 12, 16, 0.62)';
    roundRect(ctx, x, y, boxW, boxH, 16 * u);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillRect(x, y + 14 * u, 6 * u, boxH - 28 * u);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${58 * u}px ${this.font}`;
    ctx.fillText(String(Math.round(shot.speed * this.factor)), right, y + 66 * u);
    ctx.font = `500 ${17 * u}px ${this.font}`;
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(this.unit, right, y + 90 * u);
    ctx.fillStyle = color;
    ctx.font = `600 ${18 * u}px ${this.font}`;
    ctx.fillText(this.names[shot.player] || 'Batida', right, y + 112 * u);
    ctx.restore();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
