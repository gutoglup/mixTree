// Integração do app (HTTP + WebSocket + motor + cliente X32) contra o simulador
// local fazendo papel de "mesa real". Cada teste usa um config.json temporário.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import WebSocket from 'ws';
import { createApp, connErrorText, HOST_RE } from '../src/app.js';
import { startSimulator } from '../src/simulator.js';
import { faderToDb } from '../src/osc.js';

const MAP = [
  { ch: 15, role: 'keyboard', name: 'KEYS L' },
  { ch: 1, role: 'vocal', name: 'VOZ 1' },
  { ch: 2, role: 'vocal', name: 'VOZ 2' },
  { ch: 17, role: 'ref', group: 'guitarra', name: 'GTR L', seen: { name: 'GTR L' } },
];

const FAST = { tickMs: 20, refreshMs: 60, rescanMs: 120, broadcastMs: 30 };
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mix-assist-app-'));
const cleanups = [];
after(async () => {
  // Um cleanup que falha não pode deixar sockets/timers abertos (o runner ficaria preso).
  for (const fn of cleanups.reverse()) await fn().catch(() => {});
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function waitFor(cond, ms = 3000, what = 'condição') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await cond();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timeout esperando ${what}`);
}

function silentLogger() {
  const logs = [];
  const errors = [];
  return { logs, errors, log: (m) => logs.push(m), error: (m) => errors.push(m) };
}

let seq = 0;
// Sobe uma "mesa" (simulador) + o app apontado para ela, com config e public próprios.
async function setup({ simulated = false, configPath, scanMixers, channels = MAP } = {}) {
  const dir = path.join(tmpRoot, String(++seq));
  const publicDir = path.join(dir, 'public');
  await fs.mkdir(publicDir, { recursive: true });
  await fs.writeFile(path.join(publicDir, 'index.html'), '<h1>ok</h1>');
  await fs.writeFile(path.join(publicDir, 'app.css'), 'body{}');
  await fs.writeFile(path.join(publicDir, 'dados.bin'), 'xx');

  const mixer = await startSimulator({ port: 0, bus: 5, channels });
  const config = {
    mixer: { host: '127.0.0.1', port: mixer.port },
    bus: 5,
    channels: structuredClone(channels),
    engine: { manualHoldSec: 20 },
  };
  const cfgPath = configPath ?? path.join(dir, 'config.json');
  if (!configPath) await fs.writeFile(cfgPath, JSON.stringify(config, null, 2));
  const logger = silentLogger();
  const app = await createApp({ config, configPath: cfgPath, publicDir, simulated, logger, scanMixers, intervals: FAST });
  cleanups.push(async () => { await app.close(); mixer.stop(); });
  const ws = { send: () => {}, sent: [] };
  ws.send = (m) => ws.sent.push(JSON.parse(m));
  const msg = (m) => app.handleMessage(ws, JSON.stringify(m));
  const readConfig = async () => JSON.parse(await fs.readFile(cfgPath, 'utf8'));
  return { app, mixer, config, cfgPath, logger, ws, msg, readConfig };
}

// Conectado e com os envios de todos os canais do mapa lidos da mesa.
const ready = (app) => waitFor(() => app.x32.connected && [...app.engine.channels.values()].every((c) => c.sendDb != null), 3000, 'leitura da mesa');

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], cache: res.headers['cache-control'], body }));
    }).on('error', reject);
  });
}

test('HTTP estático: index, MIME, 404 e bloqueio de path traversal', async () => {
  const { app } = await setup();
  const port = await app.listen(0, '127.0.0.1');
  const root = await get(port, '/');
  assert.equal(root.status, 200);
  assert.equal(root.type, 'text/html; charset=utf-8');
  assert.equal(root.cache, 'no-store');
  assert.equal(root.body, '<h1>ok</h1>');
  assert.equal((await get(port, '/app.css')).type, 'text/css; charset=utf-8');
  assert.equal((await get(port, '/dados.bin')).type, 'application/octet-stream');
  assert.equal((await get(port, '/nao-existe.js')).status, 404);
  assert.equal((await get(port, '/..%2fconfig.json')).status, 403);
  assert.equal((await get(port, '/%E0%A4%A')).status, 404, 'URI malformada não derruba o servidor');
});

test('WebSocket: página recebe o estado e os comandos chegam ao app', async () => {
  const { app } = await setup();
  const port = await app.listen(0, '127.0.0.1');
  await ready(app);
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  const states = [];
  const others = [];
  client.on('message', (m) => {
    const d = JSON.parse(m);
    (d.type === 'state' ? states : others).push(d);
  });
  await new Promise((r) => client.once('open', r));
  const st = await waitFor(() => states.findLast((s) => s.connected && s.busNames[4]), 3000, 'estado conectado');
  assert.equal(st.simulated, false);
  assert.equal(st.bus, 5);
  assert.equal(st.busNames[4], 'TECLADO', 'nomes dos buses vêm da mesa');
  assert.equal(st.mixer.model, 'X32');
  assert.equal(st.connError, '');
  assert.equal(st.mode, 'off');
  assert.deepEqual(st.patchDiffs, []);
  assert.equal(st.channels.length, MAP.length);

  client.send('isso não é json');
  client.send(JSON.stringify({ type: 'mode', mode: 'assist' }));
  await waitFor(() => app.engine.mode === 'assist', 2000, 'modo assist');
  client.send(JSON.stringify({ type: 'proposeMap' }));
  const prop = await waitFor(() => others.find((d) => d.type === 'proposal'), 2000, 'proposta');
  assert.equal(prop.rows.length, 32);
  assert.equal(prop.busName, 'TECLADO');
  assert.equal(prop.busGroup, 'teclado');
  client.close();
});

test('envios: setSend escreve na mesa; valores inválidos e âncora são ignorados', async () => {
  const { app, mixer, msg } = await setup();
  await ready(app);
  msg({ type: 'setSend', ch: 17, db: -7 });
  await waitFor(() => Math.abs(faderToDb(mixer.state.get(17).send) - -7) < 0.2, 2000, 'envio na mesa');
  assert.equal(app.engine.channels.get(17).sendDb, -7);
  assert.ok(app.engine.isHeld(app.engine.channels.get(17), Date.now()), 'ajuste pela página trava o canal');

  msg({ type: 'setSend', ch: 17, db: 'abc' });
  msg({ type: 'setSend', ch: 15, db: -20 }); // âncora: motor recusa
  msg({ type: 'setSend', ch: 1, db: 99 }); // limitado a +10
  assert.equal(app.engine.channels.get(17).sendDb, -7);
  assert.notEqual(app.engine.channels.get(15).sendDb, -20);
  assert.equal(app.engine.channels.get(1).sendDb, 10);
});

test('âncora: só muda por "anchor"/"keyboard" (delta limitado a ±6 dB)', async () => {
  const { app, mixer, msg } = await setup();
  await ready(app);
  const before = app.engine.channels.get(15).sendDb;
  const near = (a, b) => Math.abs(a - b) < 0.01;
  msg({ type: 'anchor', delta: -50 });
  assert.ok(near(app.engine.channels.get(15).sendDb, before - 6));
  msg({ type: 'keyboard', delta: 2 });
  assert.ok(near(app.engine.channels.get(15).sendDb, before - 4));
  await waitFor(() => Math.abs(faderToDb(mixer.state.get(15).send) - (before - 4)) < 0.2, 2000, 'âncora na mesa');
});

test('base, aprovação e releituras: comandos sem efeito colateral inesperado', async () => {
  const { app, mixer, msg } = await setup();
  await ready(app);
  msg({ type: 'saveBase' });
  const base = app.engine.channels.get(2).sendDb;
  app.engine.channels.get(2).sendDb = base - 5; // como se o motor tivesse baixado
  msg({ type: 'restoreBase' });
  assert.equal(app.engine.channels.get(2).sendDb, base);
  await waitFor(() => Math.abs(faderToDb(mixer.state.get(2).send) - base) < 0.2, 2000, 'base restaurada na mesa');

  app.engine.channels.get(17).target = -3;
  msg({ type: 'approve', ch: 17 });
  assert.equal(app.engine.channels.get(17).approved, -3);
  msg({ type: 'approveAll' });
  for (const t of ['refresh', 'busNames', 'scanChannels', 'desconhecido']) msg({ type: t });
  msg({ type: 'mode', mode: 'invalido' });
  assert.equal(app.engine.mode, 'off', 'modo inválido é ignorado');
  app.tick(Date.now());
  assert.ok(Array.isArray(app.state().suggestions));
});

test('patch da mesa muda: assistente bloqueado até o mapa ser revisado e salvo', async () => {
  const { app, mixer, msg, ws, logger, readConfig } = await setup();
  await ready(app);
  msg({ type: 'mode', mode: 'auto' });
  assert.equal(app.engine.mode, 'auto');

  mixer.setPatch(17, { name: 'VIOLAO 2' });
  await waitFor(() => app.state().patchDiffs.length === 1, 3000, 'diferença de patch');
  assert.equal(app.engine.mode, 'off');
  assert.match(app.engine.block, /patch da mesa mudou/);
  assert.ok(logger.logs.some((l) => /Patch da mesa mudou \(ch 17: "GTR L" → "VIOLAO 2"\)/.test(l)));
  msg({ type: 'mode', mode: 'auto' });
  assert.equal(app.engine.mode, 'off', 'não liga com o patch diferente');

  msg({ type: 'proposeMap' });
  const prop = ws.sent.at(-1);
  assert.equal(prop.type, 'proposal');
  await msg({ type: 'applyMap', rows: prop.rows, anchorGroup: ` ${prop.anchorGroup} ` });
  assert.deepEqual(ws.sent.at(-1), { type: 'mapResult', ok: true });
  assert.deepEqual(app.state().patchDiffs, []);
  assert.equal(app.engine.block, null);
  const saved = await readConfig();
  assert.equal(saved.channels.find((c) => c.ch === 17).name, 'VIOLAO 2');
  assert.equal(saved.channels.find((c) => c.ch === 15).role, 'anchor');
  msg({ type: 'mode', mode: 'auto' });
  assert.equal(app.engine.mode, 'auto');
});

test('applyMap: pedido inválido e mapa sem âncora são recusados sem mexer no config', async () => {
  const { app, msg, ws, readConfig } = await setup();
  await ready(app);
  const before = await readConfig();
  await msg({ type: 'applyMap', rows: 'x', anchorGroup: 'teclado' });
  assert.deepEqual(ws.sent.at(-1), { type: 'mapResult', ok: false, error: 'pedido inválido' });
  await msg({ type: 'applyMap', rows: [], anchorGroup: '   ' });
  assert.equal(ws.sent.at(-1).error, 'pedido inválido');
  await msg({ type: 'applyMap', rows: [{ ch: 1, role: 'vocal' }], anchorGroup: 'teclado' });
  assert.equal(ws.sent.at(-1).ok, false);
  assert.ok(ws.sent.at(-1).error.length > 0);
  assert.deepEqual(await readConfig(), before);
});

test('ajuste de solista: delta/valor direto, grava no config e ignora não-vozes', async () => {
  const { app, msg, readConfig, logger } = await setup();
  await ready(app);
  await msg({ type: 'soloOffset', ch: 1, delta: -1 });
  await msg({ type: 'soloOffset', ch: 1, delta: -5 }); // passo de 1 dB por clique
  assert.equal(app.engine.channels.get(1).soloOffsetDb, -2);
  assert.equal((await readConfig()).channels.find((c) => c.ch === 1).soloOffsetDb, -2);

  await msg({ type: 'soloOffset', ch: 1, db: -20 });
  assert.equal(app.engine.channels.get(1).soloOffsetDb, -9, 'limitado a −9 dB');
  await msg({ type: 'soloOffset', ch: 1, db: 0 });
  assert.equal((await readConfig()).channels.find((c) => c.ch === 1).soloOffsetDb, undefined, '0 remove a chave');
  assert.ok(logger.logs.some((l) => /Ajuste de solista: VOZ 1 sem ajuste/.test(l)));

  const n = logger.logs.length;
  await msg({ type: 'soloOffset', ch: 1, db: 0 }); // igual ao atual: nada a gravar
  await msg({ type: 'soloOffset', ch: 17, db: -3 }); // instrumento
  await msg({ type: 'soloOffset', ch: 1, db: 'x' });
  assert.equal(logger.logs.length, n);
});

test('troca de bus: valida, desliga o assistente e grava só com a mesa real', async () => {
  const { app, msg, readConfig, logger } = await setup();
  await ready(app);
  await waitFor(() => app.state().busNames[2] === 'BATERA', 2000, 'nomes de bus');
  msg({ type: 'mode', mode: 'assist' });
  for (const bus of [0, 17, 5, 'x', 2.5]) await msg({ type: 'setBus', bus });
  assert.equal(app.state().bus, 5);
  await msg({ type: 'setBus', bus: 3 });
  assert.equal(app.state().bus, 3);
  assert.equal(app.engine.mode, 'off');
  assert.equal(app.x32.bus, 3);
  assert.equal((await readConfig()).bus, 3);
  assert.ok(logger.logs.some((l) => l.includes('Bus do fone: 5 → 3 (BATERA)')));
});

test('troca de mesa: simulador não grava; IP real é validado e gravado', async () => {
  const { app, mixer, msg, readConfig } = await setup();
  await ready(app);
  await msg({ type: 'connect', source: 'sim' });
  let st = app.state();
  assert.equal(st.simulated, true);
  assert.equal(st.mixer.host, '127.0.0.1');
  assert.notEqual(st.mixer.port, mixer.port);
  assert.ok(app.sim, 'simulador interno no ar');
  await msg({ type: 'setBus', bus: 2 });
  assert.equal((await readConfig()).bus, 5, 'bus do simulador não vai para o config');
  await msg({ type: 'connect', source: 'sim' }); // reaproveita o simulador

  for (const bad of [{ host: 'não é host!' }, { host: '10.0.0.1', port: 0 }, { host: '10.0.0.1', port: 70000 }, { host: '10.0.0.1', port: 'x' }]) {
    await msg({ type: 'connect', ...bad });
  }
  assert.equal(app.state().simulated, true);

  await msg({ type: 'connect', host: ' 127.0.0.1 ', port: String(mixer.port) });
  st = app.state();
  assert.equal(st.simulated, false);
  assert.equal(app.sim, null, 'simulador interno parado');
  assert.deepEqual(st.realMixer, { host: '127.0.0.1', port: mixer.port });
  assert.deepEqual((await readConfig()).mixer, { host: '127.0.0.1', port: mixer.port });
  await waitFor(() => app.x32.connected, 2000, 'mesa real responde');

  await msg({ type: 'connect', host: '192.0.2.10', port: '' }); // porta padrão (IP de documentação: sem DNS)
  assert.deepEqual((await readConfig()).mixer, { host: '192.0.2.10', port: 10023 });
});

test('troca de mesa concorrente é ignorada enquanto a primeira não termina', async () => {
  const { app, msg } = await setup();
  const a = msg({ type: 'connect', source: 'sim' });
  const b = msg({ type: 'connect', host: '10.9.9.9', port: 10023 });
  assert.equal(app.state().switching, true);
  await Promise.all([a, b]);
  assert.equal(app.state().simulated, true);
  assert.equal(app.state().switching, false);
});

test('app iniciado em modo simulador mostra o patch da igreja e não grava o mapa', async () => {
  const { app, msg, ws, readConfig, logger } = await setup({ simulated: true });
  await ready(app);
  assert.equal(app.state().simulated, true);
  assert.ok(logger.logs.some((l) => l.startsWith('Simulador X32 rodando')));
  await waitFor(() => app.patch[20].name === 'CLICK', 3000, 'patch extra');
  const before = await readConfig();
  msg({ type: 'proposeMap' });
  await msg({ type: 'applyMap', rows: ws.sent.at(-1).rows, anchorGroup: 'teclado' });
  assert.equal(ws.sent.at(-1).ok, true);
  assert.ok(logger.logs.some((l) => l.includes('(simulador: não salvo)')));
  await msg({ type: 'soloOffset', ch: 1, db: -3 });
  assert.deepEqual(await readConfig(), before);
});

test('procurar mesas: usa o scanner injetado e não roda duas vezes ao mesmo tempo', async () => {
  let calls = 0;
  let release;
  const scanMixers = () => { calls++; return new Promise((r) => (release = r)); };
  const { app, msg, logger } = await setup({ scanMixers });
  const p = msg({ type: 'scan' });
  assert.equal(app.state().scan.running, true);
  await msg({ type: 'scan' });
  assert.equal(calls, 1);
  release([{ host: '10.0.0.5', port: 10023, name: 'Igreja', model: 'M32', fw: '4.0' }]);
  await p;
  const { scan } = app.state();
  assert.equal(scan.running, false);
  assert.equal(scan.found[0].name, 'Igreja');
  assert.ok(scan.at > 0);
  assert.ok(logger.logs.includes('Procurar mesas: M32 Igreja @ 10.0.0.5'));

  const q = msg({ type: 'scan' });
  release([]);
  await q;
  assert.ok(logger.logs.includes('Procurar mesas: nenhuma encontrada'));
});

test('erros da mesa: mensagem amigável, sem repetir no log e some ao receber dados', async () => {
  const { app, logger } = await setup();
  await ready(app);
  const err = Object.assign(new Error('send EHOSTUNREACH 10.0.0.9:10023'), { code: 'EHOSTUNREACH' });
  app.x32.emit('error', err);
  app.x32.emit('error', err);
  assert.equal(logger.errors.length, 1);
  assert.match(logger.errors[0], /não alcança a mesa/);
  app.x32.emit('error', new Error('outro'));
  assert.equal(logger.errors.at(-1), 'X32: outro');
  app.x32.emit('send', { ch: 99, db: 0 }); // qualquer envio lido limpa o erro
  assert.equal(app.state().connError, '');
});

test('config.json ilegível: erro no log, app continua funcionando', async () => {
  const missing = path.join(tmpRoot, 'nao-existe', 'config.json');
  const { app, msg, logger } = await setup({ configPath: missing });
  await ready(app);
  await msg({ type: 'setBus', bus: 4 });
  assert.equal(app.state().bus, 4);
  assert.ok(logger.errors.some((e) => e.startsWith('Não consegui salvar o config.json')));
});

test('falha ao subir o simulador vira erro de conexão, não exceção', async () => {
  const { app, msg, logger, config } = await setup();
  const channels = config.channels;
  config.channels = null; // startSimulator vai falhar ao ler os canais
  try {
    await msg({ type: 'connect', source: 'sim' });
  } finally {
    config.channels = channels;
  }
  assert.ok(logger.errors.some((e) => e.startsWith('Não consegui trocar de mesa')));
  assert.equal(app.state().switching, false);
});

test('listen recusa porta ocupada; close é idempotente para o servidor HTTP', async () => {
  const { app } = await setup();
  const port = await app.listen(0, '127.0.0.1');
  const { app: other } = await setup();
  await assert.rejects(other.listen(port, '127.0.0.1'), { code: 'EADDRINUSE' });
  await other.close();
  await other.close();
});

test('connErrorText e HOST_RE', () => {
  assert.equal(connErrorText('', false), '');
  assert.equal(connErrorText('qualquer', true), '', 'conectado: sem erro');
  assert.match(connErrorText('send EHOSTDOWN', false), /mesma rede/);
  assert.equal(connErrorText('ECONNREFUSED', false), 'ECONNREFUSED');
  for (const ok of ['192.168.1.104', 'mesa', 'x32.local', 'a-b.c']) assert.ok(HOST_RE.test(ok), ok);
  for (const bad of ['', '-a', 'a_b', 'http://x', 'a..b']) assert.ok(!HOST_RE.test(bad), bad);
});
