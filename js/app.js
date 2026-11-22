// Tela do app. O trabalho pesado roda em js/worker.js.

const $ = (id) => document.getElementById(id);
const els = {
  file: $('file'), drop: $('drop'), fileLabel: $('fileLabel'), go: $('go'), estimate: $('estimate'),
  pick: $('pick'), work: $('work'), done: $('done'), err: $('err'),
  stage: $('stage'), barFill: $('barFill'), elapsed: $('elapsed'), eta: $('eta'),
  analysisBox: $('analysisBox'), stats: $('stats'), cancel: $('cancel'),
  doneText: $('doneText'), preview: $('preview'), download: $('download'), share: $('share'),
  csv: $('csv'), again: $('again'), finalStats: $('finalStats'), shotTable: $('shotTable'),
};

let file = null;
let lastAnalysis = null;
let outFile = null;
let objectUrl = null;

if (!('VideoEncoder' in window) || !('Worker' in window)) {
  showError('Este navegador não tem os recursos de vídeo necessários. Use o Chrome ou Edge atualizado no computador, ou o Safari atualizado no iPhone/Mac.');
}

// ---------------------------------------------------------------- escolha do arquivo
function setFile(f) {
  if (!f) return;
  file = f;
  els.fileLabel.textContent = `${f.name} · ${fmtBytes(f.size)}`;
  els.go.disabled = false;
  updateEstimate();
}
els.file.addEventListener('change', () => setFile(els.file.files[0]));
['dragenter', 'dragover'].forEach((ev) => els.drop.addEventListener(ev, (e) => {
  e.preventDefault(); els.drop.classList.add('over');
}));
['dragleave', 'drop'].forEach((ev) => els.drop.addEventListener(ev, (e) => {
  e.preventDefault(); els.drop.classList.remove('over');
}));
els.drop.addEventListener('drop', (e) => setFile(e.dataTransfer.files[0]));
['resolution', 'quality', 'keep60'].forEach((id) => $(id).addEventListener('change', updateEstimate));

function readSettings() {
  const num = (id) => parseFloat($(id).value);
  const base = file ? file.name.replace(/\.[^.]+$/, '') : 'tenis';
  return {
    resolution: num('resolution'),
    bitsPerPixel: num('quality'),
    exitSpeed: $('speedMode').value === 'exit',
    sensitivity: num('sensitivity'),
    nearName: $('nearName').value.trim() || 'Perto da câmera',
    farName: $('farName').value.trim() || 'Fundo',
    distance: num('distance') || 25,
    maxGap: num('maxGap') || 3,
    pre: num('pre') || 0,
    post: num('post') || 0,
    minHits: Math.max(1, Math.round(num('minHits') || 2)),
    keep60: $('keep60').checked,
    outName: `${base.replace(/[^\w.-]+/g, '_')}_cortado.mp4`,
  };
}

function updateEstimate() {
  const s = readSettings();
  const short = s.resolution;
  const fps = s.keep60 ? 60 : 30;
  const mbPerMin = (short * short * (16 / 9) * fps * s.bitsPerPixel * 60) / 8 / 1e6 + 1;
  els.estimate.textContent = `Tamanho aproximado do vídeo final: ${Math.round(mbPerMin)} MB por minuto de jogo que sobrar.`;
}
updateEstimate();

// ---------------------------------------------------------------- processamento
els.go.addEventListener('click', () => start().catch((e) => showError(String(e?.message || e))));
els.cancel.addEventListener('click', () => { stopWorkers(); reset(); });
els.again.addEventListener('click', reset);

let workers = [];
let t0 = 0;

function newWorker() {
  const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  w.onerror = (e) => showError(`Erro no processamento: ${e.message || 'desconhecido'}`);
  workers.push(w);
  return w;
}
function stopWorkers() {
  workers.forEach((w) => { w.postMessage({ type: 'cancel' }); w.terminate(); });
  workers = [];
}
/** Manda uma tarefa e devolve a mensagem final; as intermediárias vão para onMsg. */
function runTask(w, msg, finalType, onMsg = () => {}) {
  return new Promise((resolve, reject) => {
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === finalType) resolve(m);
      else if (m.type === 'error') reject(new Error(m.message));
      else onMsg(m);
    };
    w.postMessage(msg);
  });
}

function setProgress(stage, total, extra = '') {
  els.stage.textContent = stage;
  els.barFill.style.width = `${(Math.min(1, total) * 100).toFixed(1)}%`;
  els.elapsed.textContent = `Tempo: ${fmtTime((performance.now() - t0) / 1000)}`;
  els.eta.textContent = extra;
}

/** Quantas partes processar ao mesmo tempo, conforme o aparelho. */
function parallelism(keptSeconds) {
  const cores = navigator.hardwareConcurrency || 4;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  const max = mobile ? 2 : Math.min(4, Math.max(1, Math.floor(cores / 2)));
  return Math.max(1, Math.min(max, Math.floor(keptSeconds / 45)));
}

/** Divide os trechos em `n` grupos seguidos com durações parecidas. */
function splitSegments(segments, n) {
  const total = segments.reduce((a, s) => a + s.end - s.start, 0);
  const groups = [[]];
  let acc = 0;
  for (const s of segments) {
    const target = (total * groups.length) / n;
    if (acc >= target && groups.length < n) groups.push([]);
    groups[groups.length - 1].push(s);
    acc += s.end - s.start;
  }
  return groups.filter((g) => g.length);
}

async function cleanStorage() {
  try {
    const root = await navigator.storage.getDirectory();
    for await (const key of root.keys()) {
      try { await root.removeEntry(key); } catch { /* em uso */ }
    }
  } catch { /* sem OPFS */ }
}

async function start() {
  if (!file) return;
  hide(els.err); hide(els.pick); hide(els.done); show(els.work); hide(els.analysisBox);
  stopWorkers();
  lastAnalysis = null;
  t0 = performance.now();
  setProgress('Abrindo o vídeo…', 0);
  const settings = readSettings();
  await cleanStorage();

  // 1. análise do áudio (~10% da barra)
  const a = await runTask(newWorker(), { type: 'analyze', file, settings }, 'analysis', (m) => {
    if (m.type === 'progress') setProgress('Ouvindo as batidas (1 de 2)…', m.fraction * 0.1);
  });
  lastAnalysis = a;
  show(els.analysisBox);
  els.stats.innerHTML = statsHtml(a);
  stopWorkers();
  if (!a.segments.length) throw new Error('Não encontrei batidas no áudio. Tente aumentar a sensibilidade.');

  // 2. parâmetros do vídeo final
  const outFps = settings.keep60 || a.srcFps < 45 ? a.srcFps : a.srcFps / 2;
  const scale = Math.min(1, settings.resolution / Math.min(a.srcW, a.srcH));
  const even = (x) => Math.max(2, Math.round(x / 2) * 2);
  const outW = even(a.srcW * scale), outH = even(a.srcH * scale);
  const bitrate = Math.round(outW * outH * outFps * settings.bitsPerPixel);
  const { getFirstEncodableVideoCodec } = await import('../vendor/mediabunny.min.mjs');
  const codec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: outW, height: outH, bitrate });
  if (!codec) throw new Error('Este navegador não consegue gravar vídeo. Use o Chrome, Edge ou Safari atualizado.');
  const video = { outW, outH, outFps, srcFps: a.srcFps, bitrate, codec };

  // 3. gravação em partes paralelas (~85% da barra)
  const groups = splitSegments(a.segments, parallelism(a.keptDuration));
  const single = groups.length === 1;
  const planned = a.segments.reduce((s, g) => s + Math.round((g.end - g.start) * outFps), 0);
  let frames = 0;
  const tRender = performance.now();
  const parts = await Promise.all(groups.map((segments, i) => runTask(newWorker(), {
    type: 'render', file, settings, segments, shots: a.shots, video,
    outName: single ? settings.outName : `parte_${i}.mp4`,
  }, 'rendered', (m) => {
    if (m.type !== 'frames') return;
    frames += m.count;
    const fps = frames / ((performance.now() - tRender) / 1000);
    const eta = (planned - frames) / Math.max(1, fps);
    setProgress(
      `Cortando e gravando o vídeo (2 de 2)… ${groups.length > 1 ? `${groups.length} partes ao mesmo tempo` : ''}`,
      0.1 + 0.85 * (frames / planned),
      `Falta cerca de ${fmtTime(eta)} · ${Math.round(fps)} quadros/s`);
  })));
  stopWorkers();

  // 4. junta as partes (sem recomprimir)
  let result = parts[0];
  if (!single) {
    result = await runTask(newWorker(), { type: 'merge', parts, outName: settings.outName }, 'merged', (m) => {
      if (m.type === 'progress') setProgress('Juntando as partes…', 0.95 + 0.05 * m.fraction);
    });
    stopWorkers();
  }
  await finish({ ...result, outWidth: outW, outHeight: outH, outFps, parts: groups.length });
}

async function finish(m) {
  if (m.storage === 'opfs') {
    const root = await navigator.storage.getDirectory();
    outFile = await (await root.getFileHandle(m.name)).getFile();
  } else {
    outFile = new File([m.blob], m.name, { type: 'video/mp4' });
  }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(outFile);
  els.preview.src = objectUrl;
  els.download.href = objectUrl;
  els.download.download = m.name;
  els.download.textContent = `Baixar vídeo (${fmtBytes(outFile.size)})`;
  const a = lastAnalysis;
  els.doneText.textContent =
    `${fmtTime(a.duration)} de vídeo viraram ${fmtTime(m.duration)} ` +
    `(${a.rallies} rallies). Arquivo de ${fmtBytes(a.size)} → ${fmtBytes(outFile.size)}, ` +
    `${m.outWidth}×${m.outHeight} a ${Math.round(m.outFps)} fps. ` +
    `Processado em ${fmtTime((performance.now() - t0) / 1000)}.`;
  els.finalStats.innerHTML = statsHtml(a);
  fillTable(a.shots);
  try {
    if (navigator.canShare?.({ files: [outFile] })) show(els.share);
  } catch { /* sem suporte */ }
  hide(els.work); show(els.done);
}

els.share.addEventListener('click', async () => {
  try { await navigator.share({ files: [outFile], title: 'Jogo de tênis cortado' }); } catch { /* cancelado */ }
});

els.csv.addEventListener('click', () => {
  if (!lastAnalysis) return;
  const s = readSettings();
  const names = { near: s.nearName, far: s.farName };
  const rows = [['tempo_original_s', 'tempo_original', 'jogador', 'velocidade_media_kmh', 'estimativa_raquete_kmh']];
  for (const sh of lastAnalysis.shots) {
    rows.push([
      sh.t.toFixed(2), fmtClock(sh.t), names[sh.player] || '',
      sh.speed ? sh.speed.toFixed(1) : '', sh.speed ? (sh.speed * 1.35).toFixed(1) : '',
    ]);
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = s.outName.replace(/\.mp4$/, '_batidas.csv');
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

function statsHtml(a) {
  const s = readSettings();
  const f = s.exitSpeed ? 1.35 : 1;
  const kmh = (v) => (v == null ? '—' : `${Math.round(v * f)} km/h`);
  const n = a.summary.near, far = a.summary.far;
  return [
    stat(`${fmtTime(a.duration)} → ${fmtTime(a.keptDuration)}`, 'duração original → cortada'),
    stat(String(a.rallies), 'rallies encontrados'),
    stat(String(a.hits), 'batidas detectadas'),
    stat(kmh(n.avg), `${esc(s.nearName)}: média`, 'near'),
    stat(kmh(n.max), `${esc(s.nearName)}: mais rápida`, 'near'),
    stat(kmh(far.avg), `${esc(s.farName)}: média`, 'far'),
    stat(kmh(far.max), `${esc(s.farName)}: mais rápida`, 'far'),
  ].join('');
}
const stat = (b, label, cls = '') => `<div class="stat ${cls}"><b>${b}</b><span>${label}</span></div>`;

function fillTable(shots) {
  const s = readSettings();
  const names = { near: s.nearName, far: s.farName };
  const f = s.exitSpeed ? 1.35 : 1;
  const body = els.shotTable.querySelector('tbody');
  body.innerHTML = shots
    .map((sh) => `<tr><td>${fmtClock(sh.t)}</td><td>${esc(names[sh.player] || '?')}</td><td>${sh.speed ? Math.round(sh.speed * f) : '—'}</td></tr>`)
    .join('');
}

function reset() {
  hide(els.work); hide(els.done); hide(els.err); show(els.pick);
}

function showError(msg) {
  els.err.textContent = msg;
  show(els.err); hide(els.work); show(els.pick);
  stopWorkers();
}

// ---------------------------------------------------------------- utilidades
function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtBytes(b) {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1).replace('.', ',')} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`;
  return `${Math.max(1, Math.round(b / 1e3))} KB`;
}
function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}h${String(m).padStart(2, '0')}min`;
  if (m) return `${m}min${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}
function fmtClock(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
}
