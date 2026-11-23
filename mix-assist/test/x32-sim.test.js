// Integração por UDP local: cliente X32 ↔ simulador (sem mesa real).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import dgram from 'node:dgram';
import { X32Client, scanMixers } from '../src/x32.js';
import { startSimulator, CHURCH_EXTRA_PATCH } from '../src/simulator.js';
import { encode, decode, dbToFader, decodeMeterBlob } from '../src/osc.js';
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

// Socket UDP avulso para falar OSC direto com o simulador.
async function rawClient() {
  const sock = dgram.createSocket('udp4');
  await new Promise((r) => sock.bind(0, '127.0.0.1', r));
  const to = (s) => (addr, args = []) => sock.send(encode(addr, args), s.port, '127.0.0.1');
  const next = (match = () => true, ms = 1000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => { sock.off('message', on); reject(new Error('timeout')); }, ms);
    const on = (buf) => {
      const m = decode(buf);
      if (!match(m)) return;
      clearTimeout(t);
      sock.off('message', on);
      resolve(m);
    };
    sock.on('message', on);
  });
  return { sock, to, next };
}

test('scanMixers acha o simulador por endereço direto e ignora lixo', async () => {
  const found = await scanMixers({ port: sim.port, timeoutMs: 300, hosts: ['127.0.0.1'] });
  const mine = found.find((f) => f.host === '127.0.0.1');
  assert.deepEqual(mine, { host: '127.0.0.1', port: sim.port, name: 'X32 SIM', model: 'X32', fw: '4.06' });
});

test('cliente: pacote inválido vira evento de erro; sem socket nada é enviado', async () => {
  const c = client();
  c.send('/info'); // antes do start: ignorado
  c.start();
  await once(c, 'icon');
  const port = c.socket.address().port;
  const { sock } = await rawClient();
  const err = once(c, 'error');
  sock.send(Buffer.concat([Buffer.from('/a\0\0'), Buffer.from(',q\0\0')]), port, '127.0.0.1');
  assert.match((await err)[0].message, /Tag OSC não suportada/);
  sock.close();
  c.stop();
  assert.equal(c.socket, null);
  c.send('/info'); // parado: não explode
});

test('cliente: info, fader e meters do bus, troca de bus e de mesa', async () => {
  const c = client();
  const fader = once(c, 'busFader');
  const meters = once(c, 'channelMeters');
  const busMeter = once(c, 'busMeter');
  c.start();
  assert.ok(Math.abs((await fader)[0]) < 0.05, 'fader do bus em ~0 dB (quantizado em 1023 passos)');
  assert.equal((await meters)[0].length, 32);
  assert.equal(typeof (await busMeter)[0], 'number');
  assert.deepEqual(c.info, { name: 'X32 SIM', model: 'X32', fw: '4.06' });
  assert.ok(c.connected);

  c.setSend(1, NaN); // ignorado
  c.setKeyboardSend(15, NaN); // ignorado

  const other = await startSimulator({ port: 0, bus: 2, channels: MAP });
  try {
    c.setTarget('127.0.0.1', other.port);
    assert.equal(c.info, null);
    assert.equal(c.connected, false);
    await collect(c, ['name'], (g) => g.length >= 1);
    assert.equal(c.port, other.port);

    c.setBus(3); // bus que o simulador não tem: respostas de nível são do bus 2 e são descartadas
    assert.equal(c.busStr, '03');
  } finally {
    other.stop();
  }
});

test('simulador: escrita de on/fader, bus errado, canal inexistente e pacote quebrado', async () => {
  const s = await startSimulator({ port: 0, bus: 4, channels: MAP });
  const { sock, to, next } = await rawClient();
  const send = to(s);
  try {
    sock.send(Buffer.from('lixo'), s.port, '127.0.0.1'); // ignorado
    send('/xremote');
    send('/ch/01/mix/04/on', [{ type: 'i', value: 0 }]);
    send('/bus/04/mix/fader', [0.5]);
    send('/ch/01/mix/03/level', [0.1]); // bus errado: ignorado
    send('/ch/40/mix/04/level', [0.1]); // canal inexistente
    send('/ch/40/config/name');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(s.state.get(1).on, 0);
    send('/ch/01/mix/04/on');
    assert.deepEqual((await next((m) => m.address === '/ch/01/mix/04/on')).args, [0]);
    send('/bus/04/mix/fader');
    assert.deepEqual((await next((m) => m.address === '/bus/04/mix/fader')).args, [0.5]);
    send('/bus/16/config/name');
    assert.deepEqual((await next((m) => m.address === '/bus/16/config/name')).args, ['FX 4']);

    // Patch trocado "na mesa" chega a quem pediu /xremote
    const icon = next((m) => m.address === '/ch/17/config/icon');
    const color = next((m) => m.address === '/ch/17/config/color');
    s.setPatch(17, { icon: 5, color: 3 });
    assert.deepEqual((await icon).args, [5]);
    assert.deepEqual((await color).args, [3]);
    s.setPatch(99, { name: 'x' }); // fora da mesa: ignorado

    s.setBus(6);
    send('/ch/01/mix/06/level');
    assert.ok((await next((m) => m.address === '/ch/01/mix/06/level')).args[0] >= 0);
  } finally {
    sock.close();
    s.stop();
  }
});

test('simulador: cada papel do mapa "toca" (meters com sinal) e a assinatura expira', async () => {
  const channels = [
    { ch: 1, role: 'anchor', group: 'teclado', name: 'KEYS' },
    ...[2, 3, 4, 5, 6].map((ch) => ({ ch, role: 'vocal', name: `V${ch}` })), // a 5ª voz fica muda
    { ch: 7, role: 'ref', group: 'bateria', name: 'BB' },
    { ch: 8, role: 'ref', group: 'bateria', name: 'CAIXA' },
    { ch: 9, role: 'ref', group: 'bateria', name: 'HIHAT' },
    { ch: 10, role: 'ref', group: 'bateria', name: 'TOM 1' },
    { ch: 11, role: 'ref', group: 'baixo', name: 'BAIXO' },
    { ch: 12, role: 'ref', group: 'guitarra', name: 'GTR' },
    { ch: 13, role: 'ref', group: 'violão', name: 'VIOLAO' },
    { ch: 14, role: 'ref', group: 'fala', name: 'TALK' },
    { ch: 15, role: 'ref', group: 'sopro', name: 'SAX' },
  ];
  const s = await startSimulator({ port: 0, bus: 1, channels });
  const { sock, to, next } = await rawClient();
  try {
    assert.equal(s.state.get(6).persona, 'Mudo');
    assert.equal(s.state.get(10).persona, 'Tom');
    assert.equal(s.state.get(15).persona, 'Quieto');
    to(s)('/meters', ['/meters/1']);
    const m = await next((x) => x.address === '/meters/1');
    const v = decodeMeterBlob(m.args[0]);
    assert.equal(v.length, 96);
    for (const ch of [1, 7, 8, 9, 11, 12, 13, 15]) assert.ok(v[ch - 1] > 0, `canal ${ch} com sinal`);
    assert.equal(v[29], 0, 'canal fora do mapa mudo');
  } finally {
    sock.close();
    s.stop();
  }
});
