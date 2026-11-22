// Teste da análise com áudio sintético: rallies com batidas de tempo conhecido.
// Rodar: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EnvelopeBuilder, detectHits, analyzeRallies, buildSegments, makeSpeedLookup, SPEED_OF_SOUND,
} from '../js/analysis.js';

const SR = 48000;
const DIST = 25;

function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Gera áudio de jogo: ruído de fundo + "toc" das batidas. Retorna áudio e gabarito. */
function makeGame() {
  const rand = rng(7);
  const dur = 120;
  const audio = new Float32Array(dur * SR);
  for (let i = 0; i < audio.length; i++) audio[i] = (rand() - 0.5) * 0.01;
  const truth = []; // {t (real), heard, player, speed}
  const rallyStarts = [5, 30, 70];
  const speeds = [60, 75, 55, 90, 68, 80, 62];
  for (const start of rallyStarts) {
    let t = start;
    let player = 'near';
    for (let k = 0; k < 7; k++) {
      const delay = player === 'far' ? DIST / SPEED_OF_SOUND : 0;
      const amp = player === 'near' ? 0.6 : 0.12;
      const heard = t + delay;
      const i0 = Math.round(heard * SR);
      for (let j = 0; j < 0.02 * SR; j++) {
        const env = Math.exp(-j / (0.003 * SR));
        audio[i0 + j] += amp * env * Math.sin((2 * Math.PI * 3000 * j) / SR) * (0.7 + 0.3 * rand());
      }
      const speed = speeds[k];
      truth.push({ t, heard, player, speed: k < 6 ? speed : null });
      t += DIST / (speed / 3.6);
      player = player === 'near' ? 'far' : 'near';
    }
  }
  // um barulho isolado (bola caindo longe) que não deve virar rally
  const iz = Math.round(55 * SR);
  for (let j = 0; j < 0.02 * SR; j++) audio[iz + j] += 0.5 * Math.exp(-j / 150) * Math.sin(j * 0.4);
  return { audio, truth, dur };
}

test('detecta batidas, jogadores, velocidades e cortes', () => {
  const { audio, truth, dur } = makeGame();
  const env = new EnvelopeBuilder(SR);
  // empurra em blocos como o decodificador faz
  for (let i = 0; i < audio.length; i += 1024) env.push(audio.subarray(i, i + 1024), i / SR);
  const hits = detectHits(env.result(), { sensitivity: 0.5 });
  assert.equal(hits.length, truth.length + 1, 'todas as batidas + o barulho isolado');

  const { rallies, shots } = analyzeRallies(hits, { distance: DIST });
  assert.equal(rallies.length, 3);
  assert.equal(shots.length, truth.length);
  shots.forEach((s, i) => {
    assert.equal(s.player, truth[i].player, `jogador da batida ${i}`);
    assert.ok(Math.abs(s.t - truth[i].heard) < 0.01, `tempo da batida ${i}`);
    if (truth[i].speed == null) assert.equal(s.speed, null);
    else assert.ok(Math.abs(s.speed - truth[i].speed) / truth[i].speed < 0.03,
      `velocidade ${i}: ${s.speed?.toFixed(1)} vs ${truth[i].speed}`);
  });

  const segs = buildSegments(rallies, dur);
  assert.equal(segs.length, 3);
  assert.ok(segs[0].start < 5 && segs[0].start > 3.5);

  const lookup = makeSpeedLookup(shots);
  assert.equal(lookup(4), null, 'antes da primeira batida não mostra nada');
  assert.ok(Math.abs(lookup(5.2).speed - 60) < 2);
  assert.equal(lookup(25), null, 'no tempo morto não mostra nada');
});

test('áudio vazio não quebra', () => {
  const env = new EnvelopeBuilder(SR);
  env.push(new Float32Array(SR * 5), 0);
  assert.deepEqual(detectHits(env.result()), []);
  assert.deepEqual(analyzeRallies([]).rallies, []);
});
