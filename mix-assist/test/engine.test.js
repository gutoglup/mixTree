import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encode,
  decode,
  faderToDb,
  dbToFader,
  encodeMeterBlob,
  decodeMeterBlob,
  dbToLin,
} from '../src/osc.js';
import { MixEngine, clampSoloOffset } from '../src/engine.js';

const MAP = [
  { ch: 9, role: 'keyboard', name: 'Teclado' },
  { ch: 1, role: 'vocal', name: 'Voz 1' },
  { ch: 2, role: 'vocal', name: 'Voz 2' },
  { ch: 3, role: 'vocal', name: 'Voz 3' },
  { ch: 23, role: 'ref', name: 'Guitarra' },
];

// Cria um motor com os envios lidos da mesa (todos em 0 dB, salvo override).
function makeEngine(sends = {}, opts = {}) {
  const e = new MixEngine(MAP, opts);
  for (const c of MAP) e.onMixerSend(c.ch, sends[c.ch] ?? 0, 0);
  return e;
}

// levels: { ch: dB de entrada } (ausente = silêncio). Passo de 50 ms, tick a cada 250 ms.
function run(e, seconds, levels, startMs = 0) {
  let now = startMs;
  const end = startMs + seconds * 1000;
  const lin = () => {
    const arr = new Array(32).fill(0);
    for (const [ch, db] of Object.entries(levels)) arr[ch - 1] = dbToLin(db);
    return arr;
  };
  const all = { actions: [], suggestions: [] };
  while (now < end) {
    now += 50;
    e.setChannelMeters(lin(), now);
    if (now % 250 === 0) {
      const r = e.tick(now);
      all.actions.push(...r.actions);
      all.suggestions = r.suggestions;
    }
  }
  return { now, ...all };
}

const send = (e, ch) => e.channels.get(ch).sendDb;
const contrib = (e, ch) => e.channels.get(ch).envDb + send(e, ch);

test('1. lei de fader: ida e volta e 0 dB ≈ 0.75', () => {
  for (let db = -60; db <= 10; db += 0.5) {
    const back = faderToDb(dbToFader(db));
    assert.ok(Math.abs(back - db) < 0.2, `${db} → ${back}`);
  }
  assert.ok(Math.abs(dbToFader(0) - 0.75) < 0.001);
  assert.equal(faderToDb(0), -90);
  assert.equal(faderToDb(1), 10);
});

test('2. OSC encode/decode e blob de meters', () => {
  const buf = encode('/ch/01/mix/05/level', [0.5, { type: 'i', value: 7 }, 'abc']);
  assert.equal(buf.length % 4, 0);
  const msg = decode(buf);
  assert.equal(msg.address, '/ch/01/mix/05/level');
  assert.equal(msg.args[0], 0.5);
  assert.equal(msg.args[1], 7);
  assert.equal(msg.args[2], 'abc');

  const vals = [0, 0.25, 0.5, 1];
  const blob = encodeMeterBlob(vals);
  const viaOsc = decode(encode('/meters/1', [blob])).args[0];
  assert.deepEqual(decodeMeterBlob(viaOsc), vals);

  const empty = decode(encode('/xremote'));
  assert.equal(empty.address, '/xremote');
  assert.deepEqual(empty.args, []);
});

test('3. solista com histerese', () => {
  const e = makeEngine();
  let r = run(e, 3, { 9: -20, 1: -15, 2: -25 });
  assert.equal(e.soloist, 1);
  // Voz 2 passa a liderar com folga: em 1 s ainda não troca
  r = run(e, 1, { 9: -20, 1: -25, 2: -12 }, r.now);
  assert.equal(e.soloist, 1, 'não deve trocar em 1 s');
  r = run(e, 3, { 9: -20, 1: -25, 2: -12 }, r.now);
  assert.equal(e.soloist, 2, 'deve trocar após sustentar a liderança');
});

test('4. auto: solista entre -10 e -8 dB, backing em -10 dB', () => {
  const e = makeEngine();
  e.setMode('auto');
  run(e, 60, { 9: -20, 1: -15, 3: -18 });
  assert.equal(e.soloist, 1);
  assert.ok(send(e, 1) <= -8 && send(e, 1) >= -10, `solista em ${send(e, 1)} dB`);
  assert.ok(Math.abs(send(e, 3) - -10) <= 0.5, `backing em ${send(e, 3)} dB`);
  for (const ch of [1, 2, 3]) assert.ok(send(e, ch) <= -8, `voz ${ch} em ${send(e, ch)} dB`);
});

test('4b. solista fraca não passa de -8 dB nem fica abaixo dos backings', () => {
  const e = makeEngine({ 1: -10, 3: -10 });
  e.setMode('auto');
  run(e, 40, { 9: -10, 1: -40, 3: -42 }); // teclado alto, vozes fracas: queria subir muito
  assert.equal(send(e, 1), -8);
  assert.equal(send(e, 3), -10);
});

test('5. guitarra forte termina abaixo do teclado', () => {
  const e = makeEngine({ 23: 5 });
  e.setMode('auto');
  run(e, 60, { 9: -20, 23: -12 }); // em etapas com descanso: mais lento de propósito
  assert.ok(contrib(e, 23) <= e.keyContrib, `guitarra ${contrib(e, 23)} vs teclado ${e.keyContrib}`);
  assert.ok(send(e, 23) < 5);
});

test('6. rampa: corte de instrumento desce rápido, mas sem salto (≤ ~4.5 dB em 2 s)', () => {
  const e = makeEngine({ 23: 5 });
  e.setMode('auto');
  const r = run(e, 5, { 9: -20, 23: -12 }); // aquece (warmup 4 s)
  const before = send(e, 23);
  run(e, 2, { 9: -20, 23: -12 }, r.now);
  const drop = before - send(e, 23);
  assert.ok(drop > 0, 'deve começar a descer');
  assert.ok(drop >= 2, `desceu só ${drop} dB`);
  assert.ok(drop <= 4.5, `desceu ${drop} dB`);
});

test('7. o teclado nunca é alterado', () => {
  const e = makeEngine({ 9: -3 });
  e.setMode('auto');
  const r = run(e, 30, { 9: -20, 1: -5, 23: -2 });
  assert.equal(send(e, 9), -3);
  assert.ok(r.actions.every((a) => a.ch !== 9));
  assert.equal(e.onUserSend(9, 0, r.now), null);
  assert.equal(send(e, 9), -3);
  e.approve(9);
  assert.equal(e.channels.get(9).approved, null);
});

test('8. mudança manual pela mesa trava o canal', () => {
  const e = makeEngine({ 23: 5 });
  e.setMode('auto');
  let r = run(e, 6, { 9: -20, 23: -12 });
  e.onMixerSend(23, 8, r.now); // alguém mexeu na mesa
  const ch = e.channels.get(23);
  assert.ok(e.isHeld(ch, r.now));
  assert.equal(ch.baseDb, 8);
  r = run(e, 10, { 9: -20, 23: -12 }, r.now);
  assert.equal(send(e, 23), 8, 'valor manual intacto durante a trava');
  assert.ok(e.history.some((h) => h.ch === 23 && h.source === 'manual'));
});

test('9. assist: só aplica após approve', () => {
  const e = makeEngine({ 23: 5 });
  e.setMode('assist');
  let r = run(e, 8, { 9: -20, 23: -12 });
  assert.equal(send(e, 23), 5, 'não aplica sem aprovação');
  const sug = r.suggestions.find((s) => s.ch === 23);
  assert.ok(sug, 'deve aparecer nas sugestões');
  assert.ok(sug.to < 5);
  e.approve(23);
  r = run(e, 20, { 9: -20, 23: -12 }, r.now);
  assert.ok(send(e, 23) < 5);
  assert.ok(contrib(e, 23) <= e.keyContrib);
});

test('10. silêncio: instrumento não muda; voz acima de -8 dB desce até o teto', () => {
  const e = makeEngine({ 2: 4, 3: -12, 23: 6 });
  e.setMode('auto');
  const r = run(e, 90, { 9: -20, 1: -15 });
  assert.equal(send(e, 23), 6);
  assert.ok(r.actions.every((a) => a.ch !== 23));
  assert.equal(send(e, 2), -8, 'voz calada acima do teto desce para -8');
  assert.equal(send(e, 3), -12, 'voz calada abaixo do teto fica como está');
});

test('extra: histórico funde cada etapa num item só (corte em etapas de até 6 dB)', () => {
  const e = makeEngine({ 23: 5 });
  e.setMode('auto');
  run(e, 60, { 9: -20, 23: -2 }); // bem acima do teclado: precisa de mais de uma etapa
  const items = e.history.filter((h) => h.ch === 23 && h.source === 'engine');
  assert.ok(items.length >= 2, `esperava várias etapas, veio ${items.length}`);
  assert.equal(items[0].from, 5);
  assert.equal(items.at(-1).to, send(e, 23));
  for (const h of items) assert.ok(Math.abs(h.to - h.from) <= 6.01, `etapa de ${h.from} → ${h.to}`);
});

test('suavidade: corte de instrumento descansa 2 s entre etapas', () => {
  const e = makeEngine({ 23: 5 });
  e.setMode('auto');
  let now = 0, last = null, moving = false;
  const starts = [], ends = [];
  const lin = new Array(32).fill(0);
  lin[8] = dbToLin(-20);
  lin[22] = dbToLin(-2);
  while (now < 60000) {
    now += 50;
    e.setChannelMeters(lin, now);
    if (now % 250 === 0) {
      const moved = e.tick(now).actions.some((a) => a.ch === 23);
      if (moved && !moving) starts.push(now);
      if (!moved && moving) ends.push(now);
      moving = moved;
      last = now;
    }
  }
  assert.ok(starts.length >= 2, 'deveria haver mais de uma etapa');
  for (let i = 1; i < starts.length; i++) {
    const rest = (starts[i] - ends[i - 1]) / 1000;
    assert.ok(rest >= 1.9, `descansou só ${rest} s entre etapas`);
  }
});

test('suavidade: oscilação curta não dispara ajuste', () => {
  const e = makeEngine({ 1: 0 }, { vocalBackingDb: -20, vocalSoloMaxDb: 0 });
  e.setMode('auto');
  const r = run(e, 6, { 9: -20, 1: -20 }); // voz alinhada ao teclado
  const before = send(e, 1);
  const r2 = run(e, 1.5, { 9: -20, 1: -12 }, r.now); // pico de 1,5 s
  run(e, 3, { 9: -20, 1: -20 }, r2.now);
  assert.equal(send(e, 1), before);
});

test('extra: teclado estéreo (L/R) — referência pela média e nenhum dos dois é alterado', () => {
  const map = [
    { ch: 15, role: 'keyboard', name: 'KEYS L' },
    { ch: 16, role: 'keyboard', name: 'KEYS R' },
    { ch: 24, role: 'vocal', name: 'Voz' },
    { ch: 17, role: 'ref', name: 'GTR' },
  ];
  const e = new MixEngine(map);
  for (const c of map) e.onMixerSend(c.ch, c.ch === 17 ? 5 : 0, 0);
  e.setMode('auto');
  const r = run(e, 60, { 15: -20, 16: -20, 24: -15, 17: -12 });
  assert.ok(Math.abs(e.keyContrib - -20) < 0.5);
  assert.equal(send(e, 15), 0);
  assert.equal(send(e, 16), 0);
  assert.ok(r.actions.every((a) => a.ch !== 15 && a.ch !== 16));
  assert.ok(contrib(e, 17) <= e.keyContrib);
  assert.equal(send(e, 24), -8); // queria ficar em -5, mas o teto da solista é -8
});

test('resetBus: zera envios lidos e desliga o assistente', () => {
  const e = makeEngine({ 1: -3 });
  e.setMode('auto');
  e.resetBus();
  assert.equal(e.mode, 'off');
  for (const c of e.channels.values()) {
    assert.equal(c.sendDb, null);
    assert.equal(c.baseDb, null);
  }
  e.onMixerSend(1, -8, 1000);
  assert.equal(e.channels.get(1).sendDb, -8);
  assert.equal(e.channels.get(1).baseDb, -8);
  assert.equal(e.history.length, 0); // leitura do bus novo não conta como ajuste manual
});

test('resetMixer: recalibra o teclado e esquece a solista', () => {
  const e = makeEngine();
  run(e, 6, { 9: -20, 1: -15 });
  assert.ok(e.ready);
  e.resetMixer();
  assert.equal(e.ready, false);
  assert.equal(e.soloist, null);
  assert.equal(e.mode, 'off');
});

test('corte rápido: guitarra que salta 18 dB volta para baixo do teclado em menos de 15 s', () => {
  const e = makeEngine();
  e.setMode('auto');
  let r = run(e, 10, { 9: -20, 23: -28 }); // guitarra baixa
  r = run(e, 15, { 9: -20, 23: -10 }, r.now); // de repente +10 acima do teclado
  assert.ok(contrib(e, 23) <= e.keyContrib + 1, `guitarra ${contrib(e, 23) - e.keyContrib} dB acima após 15 s`);
});

test('suavidade: voz continua com etapas de até 3 dB e 6 s de descanso', () => {
  const e = makeEngine({ 3: 0 });
  e.setMode('auto');
  run(e, 60, { 9: -20, 1: -15, 3: -18 });
  const items = e.history.filter((h) => h.ch === 3 && h.source === 'engine');
  assert.ok(items.length >= 2);
  for (const h of items) assert.ok(Math.abs(h.to - h.from) <= 3.01, `etapa de ${h.from} → ${h.to}`);
  for (let i = 1; i < items.length; i++) assert.ok(items[i].t - items[i - 1].tEnd >= 5900, 'descanso curto demais');
});

test('teto por grupo: canal > grupo > padrão', () => {
  const map = [
    { ch: 9, role: 'keyboard' },
    { ch: 1, role: 'ref', group: 'bateria', ceilingDb: -4 },
    { ch: 3, role: 'ref', group: 'bateria' },
    { ch: 17, role: 'ref', group: 'guitarra' },
    { ch: 19, role: 'ref', group: 'outro' },
  ];
  const e = new MixEngine(map, { groupCeilingDb: { bateria: -10, guitarra: -8 } });
  assert.equal(e.channels.get(1).ceilingDb, -4);
  assert.equal(e.channels.get(3).ceilingDb, -10);
  assert.equal(e.channels.get(17).ceilingDb, -8);
  assert.equal(e.channels.get(19).ceilingDb, -1);
  assert.equal(e.channels.get(9).ceilingDb, null);
});

test('teto por grupo: chimbal fica 10 dB abaixo do teclado, bumbo 4 dB', () => {
  const map = [
    { ch: 9, role: 'keyboard' },
    { ch: 1, role: 'ref', group: 'bateria', ceilingDb: -4 },
    { ch: 3, role: 'ref', group: 'bateria' },
  ];
  const e = new MixEngine(map, { groupCeilingDb: { bateria: -10 } });
  for (const c of map) e.onMixerSend(c.ch, 0, 0);
  e.setMode('auto');
  run(e, 60, { 9: -20, 1: -18, 3: -20 });
  assert.ok(contrib(e, 1) - e.keyContrib <= -4 + 1, `bumbo ${contrib(e, 1) - e.keyContrib}`);
  assert.ok(contrib(e, 1) - e.keyContrib >= -4 - 1.5, 'bumbo não deve cair além do teto');
  assert.ok(contrib(e, 3) - e.keyContrib <= -10 + 1, `chimbal ${contrib(e, 3) - e.keyContrib}`);
});

test('teclado: só muda por ajuste manual explícito, L e R juntos', () => {
  const map = [
    { ch: 15, role: 'keyboard' }, { ch: 16, role: 'keyboard' },
    { ch: 17, role: 'ref', group: 'guitarra' },
  ];
  const e = new MixEngine(map, { groupCeilingDb: { guitarra: -8 } });
  e.onMixerSend(15, 0, 0); e.onMixerSend(16, -1, 0); e.onMixerSend(17, 0, 0);
  e.setMode('auto');
  let r = run(e, 30, { 15: -20, 16: -20, 17: -25 });
  assert.ok(r.actions.every((a) => a.ch !== 15 && a.ch !== 16), 'motor nunca mexe no teclado');
  const acts = e.adjustKeyboard(-3, r.now);
  assert.deepEqual(acts.map((a) => [a.ch, a.db]), [[15, -3], [16, -4]], 'mantém a diferença L/R');
  assert.ok(e.history.some((h) => h.ch === 15 && h.source === 'web'));
  // com o teclado 3 dB mais baixo, a guitarra (antes −5 do teclado, limite −8) agora passa do limite e desce
  r = run(e, 40, { 15: -20, 16: -20, 17: -25 }, r.now);
  assert.ok(send(e, 17) < 0, 'guitarra acompanhou o teclado para baixo');
});

// ---------- Âncora genérica (fone de qualquer músico) ----------

test('âncora: role "anchor" de guitarra é a referência e nunca é alterada', () => {
  const map = [
    { ch: 17, role: 'anchor', group: 'guitarra', name: 'GTR' },
    { ch: 9, role: 'ref', group: 'teclado', name: 'KEYS' },
    { ch: 1, role: 'vocal', name: 'Voz 1' },
  ];
  const e = new MixEngine(map);
  for (const c of map) e.onMixerSend(c.ch, 0, 0);
  e.setMode('auto');
  run(e, 40, { 17: -20, 9: -5 }); // teclado bem acima da guitarra
  assert.equal(e.anchorName, 'guitarra');
  assert.equal(send(e, 17), 0, 'a âncora não muda');
  assert.ok(contrib(e, 9) <= e.keyContrib + 0.5, 'o teclado (agora instrumento) foi baixado até a guitarra');
  assert.equal(e.onUserSend(17, -3, 50_000), null, 'nem pela página como canal comum');
  const fresh = new MixEngine(map);
  for (const c of map) fresh.onMixerSend(c.ch, c.role === "vocal" ? -10 : 0, 0);
  fresh.tick(0);
  assert.equal(fresh.channels.get(1).reason, 'aguardando o guitarra tocar', 'textos falam da âncora, não do teclado');
  assert.equal(e.snapshot().channels[0].role, 'anchor');
  assert.equal(e.snapshot().anchorName, 'guitarra');
});

test('âncora: "keyboard" (config antigo) continua funcionando como âncora "teclado"', () => {
  const e = makeEngine();
  assert.equal(e.anchorName, 'teclado');
  assert.equal(e.channels.get(9).role, 'anchor');
  assert.deepEqual(e.keyChs, [9]);
});

test('âncora: mapa sem âncora é recusado', () => {
  assert.throws(() => new MixEngine([{ ch: 1, role: 'vocal' }]), /âncora/);
});

// ---------- Bloqueio (patch da mesa mudou) ----------

test('bloqueio: desliga o assistente e impede religar até ser liberado', () => {
  const e = makeEngine({ 23: 0 });
  e.setMode('auto');
  e.setBlock('o patch da mesa mudou');
  assert.equal(e.mode, 'off');
  assert.throws(() => e.setMode('auto'), /bloqueado/);
  assert.throws(() => e.setMode('assist'), /bloqueado/);
  e.setMode('off'); // desligar sempre pode
  const r = run(e, 20, { 9: -20, 23: -2 });
  assert.equal(r.actions.length, 0, 'nada é escrito na mesa enquanto bloqueado');
  assert.equal(e.snapshot().block, 'o patch da mesa mudou');
  e.setBlock(null);
  assert.equal(e.snapshot().block, null);
  e.setMode('auto');
  assert.equal(e.mode, 'auto');
});

test('ajuste de solista por canal: essa voz fica N dB abaixo quando é a solista', () => {
  const opts = { vocalBackingDb: -20, vocalSoloMaxDb: 0 };
  const plain = makeEngine({}, opts);
  const quiet = makeEngine({}, opts);
  assert.equal(quiet.setSoloOffset(1, -3), -3);
  for (const e of [plain, quiet]) {
    e.setMode('auto');
    run(e, 60, { 9: -20, 1: -20 });
    assert.equal(e.soloist, 1);
  }
  assert.ok(Math.abs(send(quiet, 1) - (send(plain, 1) - 3)) < 0.6, `${send(quiet, 1)} vs ${send(plain, 1)}`);
  assert.match(quiet.channels.get(1).reason + quiet.snapshot().channels.find((c) => c.ch === 1).soloOffsetDb, /-3/);
});

test('ajuste de solista: só vozes, de 0 a −9 dB, inteiro e vem do mapa', () => {
  assert.equal(clampSoloOffset(-12), -9);
  assert.equal(clampSoloOffset(2), 0);
  assert.equal(clampSoloOffset(-2.4), -2);
  assert.equal(clampSoloOffset('x'), 0);
  const e = new MixEngine([...MAP.slice(0, 1), { ch: 1, role: 'vocal', name: 'Voz 1', soloOffsetDb: -4 }]);
  assert.equal(e.channels.get(1).soloOffsetDb, -4);
  assert.equal(e.setSoloOffset(9, -3), null, 'teclado não tem ajuste de solista');
  const g = makeEngine();
  assert.equal(g.setSoloOffset(23, -3), null, 'instrumento não tem ajuste de solista');
});

test('solista some por mais de soloReleaseSec: solista é liberada', () => {
  const e = makeEngine();
  let r = run(e, 3, { 9: -20, 1: -15 });
  assert.equal(e.soloist, 1);
  r = run(e, 2, { 9: -20 }, r.now);
  assert.equal(e.soloist, 1, 'pausa curta mantém a solista');
  run(e, 6, { 9: -20 }, r.now); // ~2 s até o envelope rápido cair abaixo do gate + 4 s de espera
  assert.equal(e.soloist, null);
});

test('envio desligado na mesa: canal não recebe alvo', () => {
  const e = makeEngine({ 23: 5 });
  e.setSendOn(23, 0);
  run(e, 6, { 9: -20, 23: -12 });
  assert.equal(e.channels.get(23).target, null);
  assert.equal(e.channels.get(23).reason, 'envio desligado');
  e.setSendOn(99, true); // canal fora do mapa: ignorado
});

test('voz em fim de frase (sinal caindo): não sobe o envio nessa hora', () => {
  const e = makeEngine({ 1: -10 });
  let r = run(e, 6, { 9: -20, 1: -15 });
  assert.equal(e.soloist, 1);
  r = run(e, 1, { 9: -20, 1: -38 }, r.now); // envelope rápido cai > fadeDb antes do lento
  const c = e.channels.get(1);
  assert.ok(e.isFading(c));
  assert.equal(c.reason, 'sinal caindo — aguardando');
  assert.equal(c.target, null);
});

test('bus do fone perto de clipar vira sugestão geral', () => {
  const e = makeEngine();
  e.setBusMeter(1); // 0 dBFS
  const { suggestions } = e.tick(1000);
  const bus = suggestions.find((s) => s.ch == null);
  assert.equal(bus.name, 'Fone (Bus)');
  assert.match(bus.reason, /bus em 0\.0 dBFS/);
  e.setBusMeter(0.1); // −20 dBFS: sem aviso
  assert.ok(!e.tick(1250).suggestions.some((s) => s.ch == null));
});

test('assist: primeiro tick (dt = 0) não move; nome vazio não apaga o nome', () => {
  const e = makeEngine({ 23: 0 });
  e.setMode('assist');
  e.channels.get(23).approved = -3;
  assert.deepEqual(e.tick(1000).actions, []);
  assert.ok(e.tick(1250).actions.length > 0);
  e.setName(23, '');
  assert.equal(e.channels.get(23).name, 'Guitarra');
  e.setName(99, 'x');
  assert.equal(e.onUserSend(99, 0, 0), null);
  assert.deepEqual(e.adjustKeyboard(0, 0), []);
  assert.deepEqual(e.adjustKeyboard(NaN, 0), []);
});
