// Liga X32 + motor + HTTP estático + WebSocket.
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { X32Client, BUS_COUNT, scanMixers } from './x32.js';
import { MixEngine } from './engine.js';
import { startSimulator } from './simulator.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const config = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'));
const CONFIG_PATH = path.join(ROOT, 'config.json');

// Origem dos dados: mesa real (IP do config) ou simulador local. Dá para trocar pela página.
let simulated = process.argv.includes('--sim');
let sim = null;
async function ensureSim() {
  if (!sim) {
    // Porta 0 = o sistema escolhe; assim dois servidores podem ter simulador ao mesmo tempo.
    sim = await startSimulator({ port: 0, bus: config.bus, channels: config.channels });
    console.log(`Simulador X32 rodando em 127.0.0.1:${sim.port}`);
  }
  sim.setBus(config.bus);
  return { host: '127.0.0.1', port: sim.port };
}
const target = () => (simulated ? { host: '127.0.0.1', port: sim.port } : config.mixer);
if (simulated) await ensureSim();

const engine = new MixEngine(config.channels, config.engine);
const x32 = new X32Client({ ...target(), bus: config.bus, channels: config.channels });
let busFaderDb = null;
const busNames = new Array(BUS_COUNT).fill('');

x32.on('name', ({ ch, name }) => engine.setName(ch, name));
x32.on('send', ({ ch, db }) => engine.onMixerSend(ch, db, Date.now()));
x32.on('sendOn', ({ ch, on }) => engine.setSendOn(ch, on));
x32.on('channelMeters', (arr) => engine.setChannelMeters(arr, Date.now()));
x32.on('busMeter', (v) => engine.setBusMeter(v));
x32.on('busFader', (db) => (busFaderDb = db));
x32.on('busName', ({ bus, name }) => {
  if (bus >= 1 && bus <= BUS_COUNT) busNames[bus - 1] = name;
});
let lastErr = '';
x32.on('error', (err) => {
  if (err.message === lastErr) return; // não repetir o mesmo erro a cada pacote
  lastErr = err.message;
  const hint = err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH'
    ? ' — o Mac não alcança a mesa: confira se está no Wi-Fi/rede da X32'
    : '';
  console.error(`X32: ${err.message}${hint}`);
});
x32.on('send', () => (lastErr = ''));
const errText = () => {
  if (!lastErr || x32.connected) return '';
  if (/EHOSTUNREACH|ENETUNREACH|EHOSTDOWN/.test(lastErr)) return 'O computador não alcança esse IP. Confira se está na mesma rede da mesa.';
  return lastErr;
};
x32.start();

let lastSuggestions = [];
const apply = (actions) => {
  for (const a of actions) x32.setSend(a.ch, a.db);
};

setInterval(() => {
  const { actions, suggestions } = engine.tick(Date.now());
  lastSuggestions = suggestions;
  apply(actions);
}, 250);

// Garante que leituras iniciais perdidas (UDP) sejam refeitas enquanto faltar algo.
setInterval(() => {
  if ([...engine.channels.values()].some((c) => c.sendDb == null)) x32.refreshAll();
}, 3000);

// ---------- config.json: grava só o trecho alterado, preservando a formatação ----------
async function saveConfig(edit) {
  try {
    const text = await fs.readFile(CONFIG_PATH, 'utf8');
    const next = edit(text);
    if (next !== text) await fs.writeFile(CONFIG_PATH, next);
  } catch (err) {
    console.error(`Não consegui salvar o config.json: ${err.message}`);
  }
}

// ---------- Troca de mesa: IP real ou simulador (sem reiniciar) ----------
let switching = false;
async function connectTo({ useSim, host, port }) {
  if (switching) return;
  switching = true;
  try {
    let t;
    if (useSim) {
      t = await ensureSim();
    } else {
      config.mixer = { ...config.mixer, host, port };
      t = config.mixer;
      if (sim) { sim.stop(); sim = null; }
    }
    simulated = useSim;
    lastErr = '';
    busFaderDb = null;
    busNames.fill('');
    engine.resetMixer();
    x32.setTarget(t.host, t.port);
    console.log(`Mesa: ${useSim ? 'SIMULADOR' : `${host}:${port}`} · Bus ${config.bus} · assistente desligado`);
    if (!useSim) {
      await saveConfig((text) => text.replace(/("mixer"\s*:\s*)\{[^}]*\}/, `$1{ "host": ${JSON.stringify(host)}, "port": ${port} }`));
    }
  } catch (err) {
    lastErr = err.message;
    console.error(`Não consegui trocar de mesa: ${err.message}`);
  } finally {
    switching = false;
  }
}

let scan = { running: false, found: [], at: null };
async function runScan() {
  if (scan.running) return;
  scan = { running: true, found: scan.found, at: scan.at };
  const found = await scanMixers({ port: 10023 });
  scan = { running: false, found, at: Date.now() };
  console.log(`Procurar mesas: ${found.length ? found.map((f) => `${f.model} ${f.name} @ ${f.host}`).join(', ') : 'nenhuma encontrada'}`);
}

const HOST_RE = /^(?:\d{1,3}\.){3}\d{1,3}$|^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

// ---------- Troca do bus do fone (sem reiniciar) ----------
async function setBus(bus) {
  const from = config.bus;
  config.bus = bus;
  busFaderDb = null;
  engine.resetBus();
  x32.setBus(bus);
  sim?.setBus(bus);
  console.log(`Bus do fone: ${from} → ${bus}${busNames[bus - 1] ? ` (${busNames[bus - 1]})` : ''} · assistente desligado`);
  // O bus escolhido no simulador não vale para a mesa real: só grava com a mesa real.
  if (!simulated) await saveConfig((text) => text.replace(/("bus"\s*:\s*)\d+/, `$1${bus}`));
}

// ---------- HTTP estático ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(PUBLIC, '.' + rel);
    if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) {
      res.writeHead(403).end('proibido');
      return;
    }
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404).end('não encontrado');
  }
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const now = Date.now();
    switch (msg.type) {
      case 'mode':
        try {
          engine.setMode(msg.mode);
        } catch {}
        break;
      case 'approve':
        engine.approve(+msg.ch);
        break;
      case 'approveAll':
        engine.approveAll();
        break;
      case 'saveBase':
        engine.saveBase();
        break;
      case 'restoreBase':
        apply(engine.restoreBase(now));
        break;
      case 'setSend': {
        const db = Math.min(10, Math.max(-90, Number(msg.db)));
        if (!Number.isFinite(db)) break;
        const action = engine.onUserSend(+msg.ch, db, now);
        if (action) apply([action]);
        break;
      }
      case 'keyboard': {
        const d = Math.min(6, Math.max(-6, Number(msg.delta)));
        for (const a of engine.adjustKeyboard(d, now)) x32.setKeyboardSend(a.ch, a.db);
        break;
      }
      case 'refresh':
        x32.refreshAll();
        x32.refreshBusNames();
        break;
      case 'busNames':
        x32.refreshBusNames();
        break;
      case 'connect': {
        if (msg.source === 'sim') {
          connectTo({ useSim: true });
          break;
        }
        const host = String(msg.host ?? '').trim();
        const p = msg.port == null || msg.port === '' ? 10023 : Number(msg.port);
        if (!HOST_RE.test(host) || !Number.isInteger(p) || p < 1 || p > 65535) break;
        connectTo({ useSim: false, host, port: p });
        break;
      }
      case 'scan':
        runScan();
        break;
      case 'setBus': {
        const bus = Number(msg.bus);
        if (!Number.isInteger(bus) || bus < 1 || bus > BUS_COUNT || bus === config.bus) break;
        setBus(bus);
        break;
      }
    }
  });
});

function stateMessage() {
  return JSON.stringify({
    type: 'state',
    connected: x32.connected,
    simulated,
    mixer: { ...target(), ...(x32.info || {}) },
    realMixer: { host: config.mixer.host, port: config.mixer.port },
    connError: errText(),
    switching,
    scan,
    bus: config.bus,
    busNames,
    busFaderDb,
    ...engine.snapshot(Date.now()),
    suggestions: lastSuggestions,
  });
}

setInterval(() => {
  if (!wss.clients.size) return;
  const msg = stateMessage();
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}, 150);

const port = Number(process.env.PORT) || (config.web?.port ?? 3000);
server.listen(port, '0.0.0.0', () => {
  console.log(`\nMix Assist — ${simulated ? 'SIMULADOR' : `X32 ${config.mixer.host}:${config.mixer.port}`} · Bus ${config.bus}`);
  console.log(`  Local:   http://localhost:${port}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) console.log(`  Rede:    http://${i.address}:${port}   (abra no iPhone)`);
    }
  }
  console.log('');
});
