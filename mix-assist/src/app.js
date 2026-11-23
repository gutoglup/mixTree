// Liga X32 + motor + HTTP estático + WebSocket. Sem efeitos ao importar:
// server.js lê o config e chama createApp(); os testes fazem o mesmo com um
// config temporário, simulador local e logger silencioso.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { X32Client, BUS_COUNT, scanMixers as defaultScanMixers } from './x32.js';
import { MixEngine } from './engine.js';
import { startSimulator, CHURCH_EXTRA_PATCH } from './simulator.js';
import { CHANNEL_COUNT, DEFAULT_RULES, DEFAULT_ICONS, buildProposal, finalizeMap, diffMap, suggestAnchorGroup } from './automap.js';
import { formatChannels, replaceTopLevel } from './configfile.js';

export const HOST_RE = /^(?:\d{1,3}\.){3}\d{1,3}$|^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export const DEFAULT_INTERVALS = {
  tickMs: 250, // motor
  refreshMs: 3000, // releitura enquanto faltar envio
  rescanMs: 20000, // releitura do patch
  broadcastMs: 150, // estado para as páginas
};

// Erro de rede amigável para a página (vazio enquanto a mesa responde).
export function connErrorText(lastErr, connected) {
  if (!lastErr || connected) return '';
  if (/EHOSTUNREACH|ENETUNREACH|EHOSTDOWN/.test(lastErr)) return 'O computador não alcança esse IP. Confira se está na mesma rede da mesa.';
  return lastErr;
}

export async function createApp({
  config,
  configPath,
  publicDir,
  simulated: startSimulated = false,
  logger = console,
  scanMixers = defaultScanMixers,
  intervals = {},
}) {
  const iv = { ...DEFAULT_INTERVALS, ...intervals };
  const PUBLIC = path.resolve(publicDir);
  const timers = [];
  const every = (ms, fn) => timers.push(setInterval(fn, ms));

  // Origem dos dados: mesa real (IP do config) ou simulador local. Dá para trocar pela página.
  let simulated = startSimulated;
  let sim = null;
  async function ensureSim() {
    if (!sim) {
      // Porta 0 = o sistema escolhe; assim dois servidores podem ter simulador ao mesmo tempo.
      sim = await startSimulator({ port: 0, bus: config.bus, channels: config.channels, extraPatch: CHURCH_EXTRA_PATCH });
      logger.log(`Simulador X32 rodando em 127.0.0.1:${sim.port}`);
    }
    sim.setBus(config.bus);
    return { host: '127.0.0.1', port: sim.port };
  }
  const target = () => (simulated ? { host: '127.0.0.1', port: sim.port } : config.mixer);
  if (simulated) await ensureSim();

  let engine = new MixEngine(config.channels, config.engine);
  const x32 = new X32Client({ ...target(), bus: config.bus, channels: config.channels });
  let busFaderDb = null;
  const busNames = new Array(BUS_COUNT).fill('');

  // ---------- Patch da mesa (nome/ícone/cor de 1–32) e checagem de troca de patch ----------
  // Regras de detecção: as do config.json (autoMap.rules) substituem as padrão;
  // autoMap.icons completa/sobrescreve a tabela de ícones padrão.
  const autoMapOpts = {
    rules: config.autoMap?.rules ?? DEFAULT_RULES,
    icons: { ...DEFAULT_ICONS, ...(config.autoMap?.icons ?? {}) },
  };
  const emptyPatch = () => Array.from({ length: CHANNEL_COUNT }, (_, i) => ({ ch: i + 1 }));
  let patch = emptyPatch();
  let patchDiffs = [];
  function checkPatch() {
    const diffs = diffMap(config.channels, patch);
    const was = patchDiffs.length;
    patchDiffs = diffs;
    if (diffs.length && !was) {
      logger.log(`Patch da mesa mudou (${diffs.map((d) => `ch ${d.ch}: "${d.expected.name ?? ''}" → "${d.actual.name ?? ''}"`).join(', ')}) · assistente desligado até revisar os canais`);
    }
    engine.setBlock(diffs.length ? 'o patch da mesa mudou — revise os canais' : null);
  }
  const onPatch = (ch, field, value) => {
    if (ch < 1 || ch > CHANNEL_COUNT) return;
    patch[ch - 1][field] = value;
    checkPatch();
  };

  x32.on('name', ({ ch, name }) => {
    engine.setName(ch, name);
    onPatch(ch, 'name', name);
  });
  x32.on('icon', ({ ch, icon }) => onPatch(ch, 'icon', icon));
  x32.on('color', ({ ch, color }) => onPatch(ch, 'color', color));
  x32.on('send', ({ ch, db }) => engine.onMixerSend(ch, db, Date.now()));
  x32.on('sendOn', ({ ch, on }) => {
    engine.setSendOn(ch, on);
    if (ch >= 1 && ch <= CHANNEL_COUNT) patch[ch - 1].sendOn = on;
  });
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
    logger.error(`X32: ${err.message}${hint}`);
  });
  x32.on('send', () => (lastErr = ''));
  x32.start();

  let lastSuggestions = [];
  const apply = (actions) => {
    for (const a of actions) x32.setSend(a.ch, a.db);
  };

  function tick(now = Date.now()) {
    const { actions, suggestions } = engine.tick(now);
    lastSuggestions = suggestions;
    apply(actions);
  }
  every(iv.tickMs, () => tick());

  // Garante que leituras iniciais perdidas (UDP) sejam refeitas enquanto faltar algo.
  every(iv.refreshMs, () => {
    if ([...engine.channels.values()].some((c) => c.sendDb == null)) x32.refreshAll();
  });

  // A X32 avisa por /xremote quando um nome muda; a releitura periódica cobre pacotes perdidos.
  every(iv.rescanMs, () => x32.scanChannels());

  // ---------- config.json: grava só o trecho alterado, preservando a formatação ----------
  async function saveConfig(edit) {
    try {
      const text = await fs.readFile(configPath, 'utf8');
      const next = edit(text);
      if (next !== text) await fs.writeFile(configPath, next);
    } catch (err) {
      logger.error(`Não consegui salvar o config.json: ${err.message}`);
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
      patch = emptyPatch();
      patchDiffs = [];
      engine.setBlock(null);
      engine.resetMixer();
      x32.setTarget(t.host, t.port);
      logger.log(`Mesa: ${useSim ? 'SIMULADOR' : `${host}:${port}`} · Bus ${config.bus} · assistente desligado`);
      if (!useSim) {
        await saveConfig((text) => text.replace(/("mixer"\s*:\s*)\{[^}]*\}/, `$1{ "host": ${JSON.stringify(host)}, "port": ${port} }`));
      }
    } catch (err) {
      lastErr = err.message;
      logger.error(`Não consegui trocar de mesa: ${err.message}`);
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
    logger.log(`Procurar mesas: ${found.length ? found.map((f) => `${f.model} ${f.name} @ ${f.host}`).join(', ') : 'nenhuma encontrada'}`);
  }

  // ---------- Troca do bus do fone (sem reiniciar) ----------
  async function setBus(bus) {
    const from = config.bus;
    config.bus = bus;
    busFaderDb = null;
    engine.resetBus();
    x32.setBus(bus);
    sim?.setBus(bus);
    logger.log(`Bus do fone: ${from} → ${bus}${busNames[bus - 1] ? ` (${busNames[bus - 1]})` : ''} · assistente desligado`);
    // O bus escolhido no simulador não vale para a mesa real: só grava com a mesa real.
    if (!simulated) await saveConfig((text) => text.replace(/("bus"\s*:\s*)\d+/, `$1${bus}`));
  }

  // ---------- Mapa de canais: sugestão e confirmação ----------
  function proposal() {
    const busName = busNames[config.bus - 1];
    return {
      type: 'proposal',
      ...buildProposal(patch, { previous: config.channels, ...autoMapOpts, busName }),
      busName,
      busGroup: suggestAnchorGroup(busName, autoMapOpts), // "FONE GUITARRA" → guitarra
    };
  }

  async function applyMap(rows, anchorGroup) {
    if (!Array.isArray(rows) || typeof anchorGroup !== 'string' || !anchorGroup.trim()) {
      return { ok: false, error: 'pedido inválido' };
    }
    const { channels, errors } = finalizeMap(rows, anchorGroup.trim(), { patch, previous: config.channels });
    if (errors.length) return { ok: false, error: errors.join('; ') };
    let next;
    try {
      next = new MixEngine(channels, config.engine);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    next.history = engine.history; // atividade continua visível
    next.lastMeterAt = engine.lastMeterAt;
    for (const p of patch) if (p.name) next.setName(p.ch, p.name);
    engine = next; // nasce em "Desligado"
    config.channels = channels;
    x32.setChannels(channels);
    patchDiffs = [];
    checkPatch();
    logger.log(`Mapa de canais atualizado: ${channels.length} canais · fone de ${engine.anchorName} · assistente desligado${simulated ? ' (simulador: não salvo)' : ''}`);
    // Como o bus, o mapa testado no simulador não vale para a mesa real: só grava com a mesa real.
    if (!simulated) await saveConfig((text) => replaceTopLevel(text, 'channels', formatChannels(channels)));
    return { ok: true };
  }

  // "Mais baixo quando for solista": vale na hora e fica gravado no canal do config
  // (só com a mesa real, como o mapa — o simulador não mexe no arquivo).
  async function setSoloOffset(ch, db) {
    const v = engine.setSoloOffset(ch, db);
    if (v == null) return;
    const entry = config.channels.find((c) => c.ch === ch);
    if (!entry || (entry.soloOffsetDb ?? 0) === v) return;
    if (v) entry.soloOffsetDb = v;
    else delete entry.soloOffsetDb;
    logger.log(`Ajuste de solista: ${entry.name} ${v ? `${v} dB` : 'sem ajuste'}${simulated ? ' (simulador: não salvo)' : ''}`);
    if (!simulated) await saveConfig((text) => replaceTopLevel(text, 'channels', formatChannels(config.channels)));
  }

  // ---------- HTTP estático ----------
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
  // O ws repassa os erros do servidor HTTP (ex.: porta ocupada); quem trata é listen().
  wss.on('error', () => {});

  // Uma mensagem da página. Retorna a promessa da operação assíncrona, se houver
  // (o servidor não espera; os testes sim).
  function handleMessage(ws, raw) {
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
      case 'soloOffset': {
        // { delta } soma ao valor atual (botões −/+); { db } define direto.
        const cur = engine.channels.get(+msg.ch)?.soloOffsetDb ?? 0;
        const db = msg.delta != null ? cur + Math.sign(Number(msg.delta)) : Number(msg.db);
        if (Number.isFinite(db)) return setSoloOffset(+msg.ch, db);
        break;
      }
      case 'anchor':
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
        if (msg.source === 'sim') return connectTo({ useSim: true });
        const host = String(msg.host ?? '').trim();
        const p = msg.port == null || msg.port === '' ? 10023 : Number(msg.port);
        if (!HOST_RE.test(host) || !Number.isInteger(p) || p < 1 || p > 65535) break;
        return connectTo({ useSim: false, host, port: p });
      }
      case 'scan':
        return runScan();
      case 'scanChannels':
        x32.scanChannels();
        break;
      case 'proposeMap':
        ws.send(JSON.stringify(proposal()));
        break;
      case 'applyMap':
        return applyMap(msg.rows, msg.anchorGroup).then((r) => ws.send(JSON.stringify({ type: 'mapResult', ...r })));
      case 'setBus': {
        const bus = Number(msg.bus);
        if (!Number.isInteger(bus) || bus < 1 || bus > BUS_COUNT || bus === config.bus) break;
        return setBus(bus);
      }
    }
  }

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => handleMessage(ws, raw));
  });

  function state(now = Date.now()) {
    return {
      type: 'state',
      connected: x32.connected,
      simulated,
      mixer: { ...target(), ...(x32.info || {}) },
      realMixer: { host: config.mixer.host, port: config.mixer.port },
      connError: connErrorText(lastErr, x32.connected),
      switching,
      scan,
      bus: config.bus,
      busNames,
      busFaderDb,
      patchDiffs,
      ...engine.snapshot(now),
      suggestions: lastSuggestions,
    };
  }

  every(iv.broadcastMs, () => {
    if (!wss.clients.size) return;
    const msg = JSON.stringify(state());
    for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
  });

  return {
    server,
    x32,
    get engine() { return engine; },
    get sim() { return sim; },
    get patch() { return patch; },
    state,
    tick,
    handleMessage,
    listen(port, host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address().port));
      });
    },
    async close() {
      for (const t of timers) clearInterval(t);
      x32.stop();
      sim?.stop();
      sim = null;
      for (const c of wss.clients) c.terminate();
      wss.close();
      if (server.listening) {
        const closed = new Promise((r) => server.close(r));
        server.closeAllConnections(); // keep-alive do navegador seguraria o close() para sempre
        await closed;
      }
    },
  };
}
