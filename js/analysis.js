// Análise de áudio: detecção das batidas, agrupamento em rallies e estimativa de velocidade.
// Código puro (sem APIs de navegador), para rodar no Worker e ser testado no Node.

export const SPEED_OF_SOUND = 343; // m/s

// ---------------------------------------------------------------------------
// 1. Envelope de energia na faixa do "toc" da bola (1 a 6 kHz)
// ---------------------------------------------------------------------------

function biquad(type, freq, sampleRate, q = Math.SQRT1_2) {
  const w0 = (2 * Math.PI * Math.min(freq, sampleRate * 0.45)) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let b0, b1, b2;
  if (type === 'highpass') {
    b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
  } else {
    b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
  }
  const a0 = 1 + alpha;
  return {
    b0: b0 / a0, b1: b1 / a0, b2: b2 / a0,
    a1: (-2 * cos) / a0, a2: (1 - alpha) / a0,
    x1: 0, x2: 0, y1: 0, y2: 0,
  };
}

/**
 * Recebe o áudio em blocos (mono, Float32) e monta um envelope de energia
 * (dB) com um ponto a cada `hop` segundos. Só o envelope fica na memória,
 * então funciona com jogos de horas.
 */
export class EnvelopeBuilder {
  constructor(sampleRate, { hop = 0.0025, lowHz = 1000, highHz = 6000 } = {}) {
    this.sampleRate = sampleRate;
    this.hopSamples = Math.max(1, Math.round(hop * sampleRate));
    this.hop = this.hopSamples / sampleRate;
    this.filters = [
      biquad('highpass', lowHz, sampleRate),
      biquad('highpass', lowHz, sampleRate),
      biquad('lowpass', highHz, sampleRate),
    ];
    this.acc = 0;
    this.count = 0;
    this.values = new Float32Array(1 << 16);
    this.length = 0;
    this.startTime = null;
    this.samplesSeen = 0;
  }

  /** Adiciona um bloco de áudio mono começando em `timestamp` segundos. */
  push(samples, timestamp = null) {
    if (this.startTime === null) this.startTime = timestamp ?? 0;
    // Preenche buracos no áudio (raros) com silêncio para manter o tempo certo.
    if (timestamp !== null) {
      const expected = this.startTime + this.samplesSeen / this.sampleRate;
      const gap = Math.round((timestamp - expected) * this.sampleRate);
      if (gap > this.hopSamples) this._pushSilence(gap);
    }
    const f = this.filters;
    let acc = this.acc, count = this.count;
    const hopN = this.hopSamples;
    for (let i = 0; i < samples.length; i++) {
      let x = samples[i];
      for (let k = 0; k < 3; k++) {
        const s = f[k];
        const y = s.b0 * x + s.b1 * s.x1 + s.b2 * s.x2 - s.a1 * s.y1 - s.a2 * s.y2;
        s.x2 = s.x1; s.x1 = x; s.y2 = s.y1; s.y1 = y;
        x = y;
      }
      acc += x * x;
      if (++count === hopN) {
        this._append(acc / hopN);
        acc = 0; count = 0;
      }
    }
    this.acc = acc; this.count = count;
    this.samplesSeen += samples.length;
  }

  _pushSilence(n) {
    this.samplesSeen += n;
    const hops = Math.floor((this.count + n) / this.hopSamples);
    for (let i = 0; i < hops; i++) this._append(0);
    this.count = (this.count + n) % this.hopSamples;
    this.acc = 0;
  }

  _append(meanSquare) {
    if (this.length === this.values.length) {
      const bigger = new Float32Array(this.values.length * 2);
      bigger.set(this.values);
      this.values = bigger;
    }
    this.values[this.length++] = 10 * Math.log10(meanSquare + 1e-12);
  }

  result() {
    return { db: this.values.subarray(0, this.length), hop: this.hop, start: this.startTime ?? 0 };
  }
}

// ---------------------------------------------------------------------------
// 2. Detecção das batidas
// ---------------------------------------------------------------------------

function percentile(arr, p) {
  const s = Float32Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

/** Ruído de fundo em cada ponto do envelope (percentil 30 em blocos de 0,5 s, suavizado). */
function noiseFloor(db, hop) {
  const block = Math.max(1, Math.round(0.5 / hop));
  const nBlocks = Math.ceil(db.length / block);
  const blockVals = new Float32Array(nBlocks);
  for (let b = 0; b < nBlocks; b++) {
    blockVals[b] = percentile(db.subarray(b * block, Math.min(db.length, (b + 1) * block)), 0.3);
  }
  // mediana de ±3 blocos (3,5 s) para não "seguir" as batidas
  const smooth = new Float32Array(nBlocks);
  for (let b = 0; b < nBlocks; b++) {
    smooth[b] = percentile(blockVals.subarray(Math.max(0, b - 3), Math.min(nBlocks, b + 4)), 0.5);
  }
  return { smooth, block };
}

/**
 * Encontra os impactos da bola no envelope.
 * sensitivity: 0 (só batidas bem fortes) a 1 (pega batidas fracas também).
 * Retorna [{t, db, snr}] com t = início do impacto em segundos.
 */
export function detectHits(env, { sensitivity = 0.5, minSeparation = 0.3 } = {}) {
  const { db, hop, start } = env;
  if (db.length === 0) return [];
  const { smooth, block } = noiseFloor(db, hop);
  const thresholdDb = 20 - 10 * sensitivity; // 20 dB (insensível) … 10 dB (sensível)
  const riseDb = 9 - 4 * sensitivity; // subida rápida exigida
  const riseWin = Math.max(1, Math.round(0.03 / hop));
  const peakWin = Math.max(1, Math.round(0.06 / hop));

  const cands = [];
  for (let i = riseWin; i < db.length - 1; i++) {
    const v = db[i];
    const floor = smooth[Math.floor(i / block)];
    if (v - floor < thresholdDb) continue;
    // máximo local numa janela de ±60 ms
    let isPeak = true;
    for (let k = Math.max(0, i - peakWin); k <= Math.min(db.length - 1, i + peakWin); k++) {
      if (db[k] > v || (db[k] === v && k < i)) { isPeak = false; break; }
    }
    if (!isPeak) continue;
    // ataque rápido: antes do pico o nível era bem menor
    let before = Infinity;
    for (let k = Math.max(0, i - riseWin - peakWin); k <= i - riseWin; k++) before = Math.min(before, db[k]);
    if (v - before < riseDb) continue;
    // instante do impacto = primeiro ponto a menos de 6 dB do pico
    let onset = i;
    while (onset > 0 && i - onset < peakWin && db[onset - 1] > v - 6) onset--;
    cands.push({ t: start + onset * hop, db: v, snr: v - floor });
  }

  // separação mínima: fica o mais forte
  const hits = [];
  for (const c of cands) {
    const last = hits[hits.length - 1];
    if (last && c.t - last.t < minSeparation) {
      if (c.db > last.db) hits[hits.length - 1] = c;
    } else hits.push(c);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 3. Rallies, jogadores e velocidades
// ---------------------------------------------------------------------------

/**
 * Agrupa as batidas em rallies, define quem bateu (perto/fundo) e calcula a
 * velocidade média de cada bola entre um jogador e outro.
 */
export function analyzeRallies(hits, {
  maxGap = 3.0,        // s sem batida que encerra um rally
  minHits = 2,         // rallies com menos batidas são descartados
  distance = 25,       // m entre os dois jogadores
  minFlight = 0.45,    // s (tempos menores = provável quique/ruído)
  maxFlight = 3.2,
} = {}) {
  const rallies = [];
  let cur = null;
  for (const h of hits) {
    if (!cur || h.t - cur.hits[cur.hits.length - 1].t > maxGap) {
      cur = { hits: [] };
      rallies.push(cur);
    }
    cur.hits.push({ ...h });
  }

  // limiar global entre batida forte (perto) e fraca (fundo)
  const globalSplit = otsu(hits.map((h) => h.db));

  const kept = [];
  for (const r of rallies) {
    if (r.hits.length < minHits) continue;
    // as batidas se alternam: decide qual paridade é o jogador perto da câmera
    let even = 0, odd = 0, ne = 0, no = 0;
    r.hits.forEach((h, i) => { if (i % 2) { odd += h.db; no++; } else { even += h.db; ne++; } });
    let nearParity = null;
    if (ne && no) {
      const diff = even / ne - odd / no;
      if (Math.abs(diff) >= 2.5) nearParity = diff > 0 ? 0 : 1;
    }
    r.hits.forEach((h, i) => {
      if (nearParity !== null) h.player = i % 2 === nearParity ? 'near' : 'far';
      else if (globalSplit !== null) h.player = h.db >= globalSplit ? 'near' : 'far';
      else h.player = null;
    });
    r.start = r.hits[0].t;
    r.end = r.hits[r.hits.length - 1].t;
    kept.push(r);
  }

  const delay = distance / SPEED_OF_SOUND;
  const shots = [];
  for (const r of kept) {
    for (let i = 0; i < r.hits.length; i++) {
      const a = r.hits[i];
      const b = r.hits[i + 1];
      const shot = { t: a.t, player: a.player, speed: null, end: b ? b.t : null };
      if (b) {
        const dt = b.t - a.t;
        let flight = dt;
        // o som do jogador do fundo chega `delay` segundos atrasado na câmera
        if (a.player === 'near' && b.player === 'far') flight = dt - delay;
        else if (a.player === 'far' && b.player === 'near') flight = dt + delay;
        if (flight >= minFlight && flight <= maxFlight) {
          const kmh = (distance / flight) * 3.6;
          if (kmh >= 15 && kmh <= 220) shot.speed = kmh;
        }
      }
      shots.push(shot);
    }
  }
  return { rallies: kept, shots };
}

/** Limiar de Otsu para separar dois grupos de valores; null se não houver separação clara. */
function otsu(values) {
  if (values.length < 4) return null;
  const s = [...values].sort((x, y) => x - y);
  let best = null, bestScore = -1;
  const total = s.reduce((a, b) => a + b, 0);
  let left = 0;
  for (let i = 1; i < s.length; i++) {
    left += s[i - 1];
    const n1 = i, n2 = s.length - i;
    const m1 = left / n1, m2 = (total - left) / n2;
    const score = n1 * n2 * (m1 - m2) ** 2;
    if (score > bestScore) { bestScore = score; best = { split: (s[i - 1] + s[i]) / 2, gap: m2 - m1 }; }
  }
  return best && best.gap >= 4 ? best.split : null;
}

/** Trechos do vídeo que ficam: cada rally com margem antes e depois, unindo os que se encostam. */
export function buildSegments(rallies, duration, { pre = 1.0, post = 1.5, mergeGap = 1.0 } = {}) {
  const segs = [];
  for (const r of rallies) {
    const s = Math.max(0, r.start - pre);
    const e = Math.min(duration, r.end + post);
    const last = segs[segs.length - 1];
    if (last && s - last.end <= mergeGap) last.end = Math.max(last.end, e);
    else segs.push({ start: s, end: e });
  }
  return segs.filter((g) => g.end - g.start > 0.2);
}

/** Resumo por jogador. */
export function summarize(shots) {
  const out = {};
  for (const p of ['near', 'far']) {
    const v = shots.filter((s) => s.player === p && s.speed).map((s) => s.speed);
    out[p] = v.length
      ? { count: v.length, avg: v.reduce((a, b) => a + b, 0) / v.length, max: Math.max(...v) }
      : { count: 0, avg: null, max: null };
  }
  return out;
}

/**
 * Qual velocidade mostrar no instante `t` (tempo do vídeo original).
 * Mostra a bola que está no ar; depois da última batida do rally, segura o
 * último valor por `hold` segundos.
 */
export function makeSpeedLookup(shots, { hold = 2.0 } = {}) {
  const withSpeed = shots.filter((s) => s.speed);
  let idx = 0;
  return function lookup(t) {
    // os quadros chegam em ordem crescente, então a busca anda só para frente
    if (idx > 0 && withSpeed[idx - 1] && withSpeed[idx - 1].t > t) idx = 0;
    while (idx < withSpeed.length && withSpeed[idx].t <= t) idx++;
    const s = withSpeed[idx - 1];
    if (!s) return null;
    const until = (s.end ?? s.t) + hold;
    if (t > until) return null;
    return s;
  };
}
