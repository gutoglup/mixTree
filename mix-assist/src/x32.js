// Cliente UDP da X32. Só lê estado e escreve em /ch/NN/mix/BB/level.
import dgram from 'node:dgram';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { encode, decode, faderToDb, dbToFader, decodeMeterBlob, pad2 } from './osc.js';

const RENEW_MS = 8000;
const ALIVE_MS = 5000;
export const BUS_COUNT = 16;

export class X32Client extends EventEmitter {
  constructor({ host, port = 10023, bus = 5, channels = [] }) {
    super();
    this.host = host;
    this.port = port;
    this.bus = bus;
    this.busStr = pad2(bus);
    this.channels = channels.map((c) => c.ch);
    this.keyChannels = channels.filter((c) => c.role === 'keyboard').map((c) => c.ch);
    this.lastRx = 0;
    this.info = null; // { name, model, fw } vindo de /info
    this.socket = null;
    this.timer = null;
  }

  get connected() {
    return Date.now() - this.lastRx < ALIVE_MS;
  }

  start() {
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (buf) => this._onMessage(buf));
    this.socket.on('error', (err) => this.emit('error', err));
    this.socket.bind(0, () => {
      this.send('/info');
      this._subscribe();
      this.refreshAll();
      this.refreshBusNames();
      this.timer = setInterval(() => this._subscribe(), RENEW_MS);
    });
  }

  stop() {
    clearInterval(this.timer);
    this.socket?.close();
    this.socket = null;
  }

  send(address, args = []) {
    if (!this.socket) return;
    const buf = encode(address, args);
    this.socket.send(buf, this.port, this.host, (err) => err && this.emit('error', err));
  }

  _subscribe() {
    this.send('/xremote');
    this.send('/meters', ['/meters/1']);
    this.send('/meters', ['/meters/2']);
  }

  // Aponta para outra mesa (IP/porta) sem reiniciar.
  setTarget(host, port) {
    this.host = host;
    this.port = port;
    this.lastRx = 0;
    this.info = null;
    this.send('/info');
    this._subscribe();
    this.refreshAll();
    this.refreshBusNames();
  }

  // Muda o bus do fone sem reiniciar. Respostas atrasadas do bus antigo são
  // descartadas pelo filtro de bus em _onMessage.
  setBus(bus) {
    this.bus = bus;
    this.busStr = pad2(bus);
    this.refreshAll();
  }

  refreshBusNames() {
    for (let b = 1; b <= BUS_COUNT; b++) this.send(`/bus/${pad2(b)}/config/name`);
  }

  refreshAll() {
    for (const ch of this.channels) {
      const n = pad2(ch);
      this.send(`/ch/${n}/config/name`);
      this.send(`/ch/${n}/mix/${this.busStr}/level`);
      this.send(`/ch/${n}/mix/${this.busStr}/on`);
    }
    this.send(`/bus/${this.busStr}/mix/fader`);
  }

  // Única escrita permitida: envio de um canal para o bus do fone.
  setSend(ch, db) {
    // Segunda trava (além do motor): só canais do config e nunca o teclado.
    if (!this.channels.includes(ch) || this.keyChannels.includes(ch)) return;
    if (!Number.isFinite(db)) return;
    this.send(`/ch/${pad2(ch)}/mix/${this.busStr}/level`, [dbToFader(db)]);
  }

  // Teclado: só por ajuste manual explícito vindo da página (nunca pelo motor).
  setKeyboardSend(ch, db) {
    if (!this.keyChannels.includes(ch) || !Number.isFinite(db)) return;
    this.send(`/ch/${pad2(ch)}/mix/${this.busStr}/level`, [dbToFader(db)]);
  }

  _onMessage(buf) {
    let msg;
    try {
      msg = decode(buf);
    } catch (err) {
      this.emit('error', err);
      return;
    }
    this.lastRx = Date.now();
    const { address, args } = msg;
    let m;
    if (address === '/info') {
      this.info = { name: String(args[1] ?? ''), model: String(args[2] ?? ''), fw: String(args[3] ?? '') };
    } else if ((m = address.match(/^\/ch\/(\d\d)\/config\/name$/))) {
      this.emit('name', { ch: +m[1], name: String(args[0] ?? '') });
    } else if ((m = address.match(/^\/bus\/(\d\d)\/config\/name$/))) {
      this.emit('busName', { bus: +m[1], name: String(args[0] ?? '') });
    } else if ((m = address.match(/^\/ch\/(\d\d)\/mix\/(\d\d)\/level$/))) {
      if (+m[2] !== this.bus || typeof args[0] !== 'number') return;
      this.emit('send', { ch: +m[1], db: faderToDb(args[0]) });
    } else if ((m = address.match(/^\/ch\/(\d\d)\/mix\/(\d\d)\/on$/))) {
      if (+m[2] !== this.bus) return;
      this.emit('sendOn', { ch: +m[1], on: !!args[0] });
    } else if (address === `/bus/${this.busStr}/mix/fader`) {
      if (typeof args[0] === 'number') this.emit('busFader', faderToDb(args[0]));
    } else if (address === '/meters/1' && Buffer.isBuffer(args[0])) {
      this.emit('channelMeters', decodeMeterBlob(args[0]).slice(0, 32));
    } else if (address === '/meters/2' && Buffer.isBuffer(args[0])) {
      const v = decodeMeterBlob(args[0]);
      if (v.length >= this.bus) this.emit('busMeter', v[this.bus - 1]);
    }
  }
}

// Procura mesas X32/M32 na rede: manda /info em broadcast e junta quem responder.
export function scanMixers({ port = 10023, timeoutMs = 1500 } = {}) {
  const targets = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const ip = i.address.split('.').map(Number);
      const mask = i.netmask.split('.').map(Number);
      targets.add(ip.map((b, k) => (b & mask[k]) | (~mask[k] & 255)).join('.'));
    }
  }
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket('udp4');
    const done = () => {
      try { sock.close(); } catch {}
      resolve([...found.values()]);
    };
    sock.on('error', done);
    sock.on('message', (buf, rinfo) => {
      try {
        const { address, args } = decode(buf);
        if (address !== '/info') return;
        found.set(rinfo.address, { host: rinfo.address, port: rinfo.port, name: String(args[1] ?? ''), model: String(args[2] ?? ''), fw: String(args[3] ?? '') });
      } catch {}
    });
    sock.bind(0, () => {
      sock.setBroadcast(true);
      const msg = encode('/info');
      for (const t of targets) sock.send(msg, port, t, () => {});
      setTimeout(done, timeoutMs);
    });
  });
}
