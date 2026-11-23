// Integração por UDP local: cliente X32 ↔ simulador (sem mesa real).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import dgram from 'node:dgram';
import { X32Client } from '../src/x32.js';
import { startSimulator, CHURCH_EXTRA_PATCH } from '../src/simulator.js';
import { encode, decode, dbToFader } from '../src/osc.js';
import { X32_ICONS } from '../src/automap.js';

const MAP = [
  { ch: 15, role: 'keyboard', name: 'KEYS L' },
  { ch: 1, role: 'vocal', name: 'VOZ 1' },
  { ch: 17, role: 'ref', group: 'guitarra', name: 'GTR L' },
];

const sim = await startSimulator({ port: 0, bus: 2, channels: MAP });
const clients = [];
after(() => {
  for (const c of clients) c.stop();
  sim.stop();
});

function client(channels = MAP) {
  const c = new X32Client({ host: '127.0.0.1', port: sim.port, bus: 2, channels });
  c.on('error', () => {});
  clients.push(c);
  return c;
}

// Junta eventos até `done` dizer que chega (ou estoura o tempo).
function collect(c, events, done, ms = 2000) {
  return new Promise((resolve, reject) => {
    const got = [];
    const timer = setTimeout(() => reject(new Error(`timeout; recebido: ${JSON.stringify(got.slice(0, 10))}`)), ms);
    for (const ev of events) {
      c.on(ev, (x) => {
        got.push({ ev, ...x });
        if (done(got)) {
          clearTimeout(timer);
          resolve(got);
        }
      });
    }
  });
}

test('scanChannels lê nome e ícone dos 32 canais (inclusive os fora do mapa)', async () => {
  const c = client();
  const p = collect(c, ['name', 'icon'], (g) => g.filter((x) => x.ev === 'icon').length >= 32 && g.filter((x) => x.ev === 'name').length >= 32);
  c.start();
  const got = await p;
  const name = (ch) => got.findLast((x) => x.ev === 'name' && x.ch === ch)?.name;
  const icon = (ch) => got.findLast((x) => x.ev === 'icon' && x.ch === ch)?.icon;
  assert.equal(name(17), 'GTR L');
  assert.equal(icon(15), X32_ICONS.keyboard);
  assert.equal(icon(17), X32_ICONS.lesPaul);
  assert.equal(name(30), '');
  assert.equal(icon(30), X32_ICONS.empty);
});

test('troca de patch na mesa chega ao cliente pelo /xremote', async () => {
  const c = client();
  c.start();
  await once(c, 'icon'); // já conectado e inscrito
  const p = collect(c, ['name'], (g) => g.some((x) => x.ch === 17 && x.name === 'VIOLAO 2'));
  sim.setPatch(17, { name: 'VIOLAO 2' });
  await p;
  assert.equal(sim.state.get(17).name, 'VIOLAO 2');
  sim.setPatch(17, { name: 'GTR L' });
});

test('renomear por OSC no simulador funciona como na mesa (escrita + eco)', async () => {
  const sock = dgram.createSocket('udp4');
  await new Promise((r) => sock.bind(0, '127.0.0.1', r));
  const ask = (addr, args = []) => new Promise((resolve) => {
    sock.once('message', (buf) => resolve(decode(buf)));
    sock.send(encode(addr, args), sim.port, '127.0.0.1');
  });
  sock.send(encode('/ch/05/config/icon', [{ type: 'i', value: X32_ICONS.saxophone }]), sim.port, '127.0.0.1');
  sock.send(encode('/ch/05/config/name', ['SAX']), sim.port, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual((await ask('/ch/05/config/name')).args, ['SAX']);
  assert.deepEqual((await ask('/ch/05/config/icon')).args, [X32_ICONS.saxophone]);
  sock.close();
});

test('setChannels troca o mapa: âncora nova protegida, canal novo liberado', async () => {
  const c = client();
  c.start();
  await once(c, 'icon');
  const writes = [];
  const orig = c.send.bind(c);
  c.send = (addr, args) => { if (/\/mix\/02\/level$/.test(addr) && args?.length) writes.push(addr); orig(addr, args); };

  c.setSend(15, -5); // âncora antiga: bloqueado
  c.setSend(20, -5); // fora do mapa: bloqueado
  assert.deepEqual(writes, []);

  c.setChannels([{ ch: 17, role: 'anchor', group: 'guitarra' }, { ch: 15, role: 'ref', group: 'teclado' }, { ch: 20, role: 'vocal' }]);
  c.setSend(17, -5); // nova âncora: bloqueado pelo setSend
  c.setSend(15, -5);
  c.setSend(20, -5);
  assert.deepEqual(writes, ['/ch/15/mix/02/level', '/ch/20/mix/02/level']);
  c.setKeyboardSend(17, 0); // âncora só por ajuste explícito
  assert.deepEqual(writes.at(-1), '/ch/17/mix/02/level');
  c.setKeyboardSend(15, 0); // ex-âncora não passa mais por aqui
  assert.equal(writes.length, 3);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(Math.abs(sim.state.get(20).send - dbToFader(-5)) < 1e-6, 'float32 do OSC');
});

test('patch da igreja: fala, violão e overs têm papel; canais fora do mapa ganham nome real', async () => {
  const s = await startSimulator({
    port: 0, bus: 2, extraPatch: CHURCH_EXTRA_PATCH,
    channels: [
      { ch: 15, role: 'keyboard', name: 'KEYS L' },
      { ch: 9, role: 'ref', group: 'bateria', name: 'Over L' },
      { ch: 13, role: 'ref', group: 'violão', name: 'VIOLAO' },
      { ch: 11, role: 'ref', group: 'fala', name: 'OFF BAT' },
      { ch: 19, role: 'ref', group: 'fala', name: 'TALKBACK' },
    ],
  });
  try {
    assert.equal(s.state.get(9).persona, 'Prato');
    assert.equal(s.state.get(13).persona, 'Violao');
    assert.equal(s.state.get(11).persona, 'Fala 0');
    assert.equal(s.state.get(19).persona, 'Fala 1');
    assert.equal(s.state.get(11).icon, X32_ICONS.empty, 'fala não pode ter ícone de voz');
    assert.equal(s.state.get(21).name, 'CLICK');
    assert.equal(s.state.get(21).persona, 'Mudo');
    assert.equal(s.state.get(31).name, 'PR FABIO');
    assert.ok(s.state.get(31).send < dbToFader(-80), 'fora do mapa fica sem envio');
  } finally {
    s.stop();
  }
});
