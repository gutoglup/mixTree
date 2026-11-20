// X32 falsa para testar em casa: responde OSC, empurra meters e toca uma "música".
import dgram from 'node:dgram';
import { encode, decode, faderToDb, dbToFader, encodeMeterBlob, dbToLin, pad2 } from './osc.js';

const SUB_MS = 10000;
const SECTION_SEC = 20;

// Mix inicial bagunçada (dB de envio por papel simulado)
const MESSY = { 'Voz 1': 3, 'Voz 2': -6, Bumbo: 2, Baixo: 4, Guitarra: 5 };
const VOCAL_PERSONAS = ['Voz 1', 'Voz 2', 'Voz 3', 'Voz 4'];

// Cada canal do config ganha um "papel" na música simulada. Instrumentos usam o
// "group" do config (bateria toca como bateria, guitarra como guitarra...).
const DRUM_PERSONAS = ['Bumbo', 'Caixa', 'Prato'];
function assignPersonas(channels) {
  let vocal = 0, drum = 0;
  const out = new Map();
  for (const c of channels) {
    let p = 'Quieto';
    if (c.role === 'keyboard') p = 'Teclado';
    else if (c.role === 'vocal') p = VOCAL_PERSONAS[vocal++] ?? 'Mudo';
    else if (c.group === 'bateria') p = DRUM_PERSONAS[drum++] ?? 'Quieto';
    else if (c.group === 'baixo') p = 'Baixo';
    else if (c.group === 'guitarra') p = 'Guitarra';
    out.set(c.ch, p);
  }
  return out;
}

const SIM_BUS_NAMES = ['MON 1', 'MON 2', 'BATERA', 'BAIXO', 'TECLADO', 'VS 1', 'VS 2', 'IEM BAT', '', '', '', '', 'FX 1', 'FX 2', 'FX 3', 'FX 4'];

export function startSimulator({ port = 10023, bus = 5, channels = [] } = {}) {
  let busStr = pad2(bus);
  const sock = dgram.createSocket('udp4');
  const t0 = Date.now();
  const state = new Map(); // ch -> { name, role, persona, send (float), on }
  const personas = assignPersonas(channels);
  for (const c of channels) {
    const persona = personas.get(c.ch);
    const db = MESSY[persona] ?? 0;
    state.set(c.ch, { name: c.name, role: c.role, persona, send: dbToFader(db), on: 1 });
  }
  let busFader = dbToFader(0);
  const remote = new Map(); // "addr:port" -> último /xremote
  const meterSubs = new Map(); // "addr:port|/meters/N" -> ts

  const reply = (rinfo, address, args) => sock.send(encode(address, args), rinfo.port, rinfo.address);
  const broadcast = (except, address, args) => {
    const now = Date.now();
    for (const [key, ts] of remote) {
      if (now - ts > SUB_MS || key === except) continue;
      const [addr, p] = key.split(':');
      sock.send(encode(address, args), +p, addr);
    }
  };

  sock.on('message', (buf, rinfo) => {
    let msg;
    try {
      msg = decode(buf);
    } catch {
      return;
    }
    const key = `${rinfo.address}:${rinfo.port}`;
    const { address, args } = msg;
    let m;
    if (address === '/info') {
      reply(rinfo, '/info', ['V2.07', 'X32 SIM', 'X32', '4.06']);
    } else if (address === '/xremote') {
      remote.set(key, Date.now());
    } else if (address === '/meters' && typeof args[0] === 'string') {
      meterSubs.set(`${key}|${args[0]}`, Date.now());
    } else if ((m = address.match(/^\/bus\/(\d\d)\/config\/name$/))) {
      reply(rinfo, address, [SIM_BUS_NAMES[+m[1] - 1] ?? '']);
    } else if ((m = address.match(/^\/ch\/(\d\d)\/config\/name$/))) {
      const s = state.get(+m[1]);
      reply(rinfo, address, [s ? s.name : `Ch ${m[1]}`]);
    } else if ((m = address.match(/^\/ch\/(\d\d)\/mix\/(\d\d)\/(level|on)$/))) {
      const s = state.get(+m[1]);
      if (!s || m[2] !== busStr) return;
      if (m[3] === 'level') {
        if (typeof args[0] === 'number') {
          s.send = Math.min(1, Math.max(0, args[0]));
          broadcast(key, address, [s.send]);
        } else reply(rinfo, address, [s.send]);
      } else {
        if (args.length) {
          s.on = args[0] ? 1 : 0;
          broadcast(key, address, [{ type: 'i', value: s.on }]);
        } else reply(rinfo, address, [{ type: 'i', value: s.on }]);
      }
    } else if (address === `/bus/${busStr}/mix/fader`) {
      if (typeof args[0] === 'number') {
        busFader = args[0];
        broadcast(key, address, [busFader]);
      } else reply(rinfo, address, [busFader]);
    }
  });

  // Nível de entrada (dB) de cada canal no instante t (s). null = silêncio.
  function inputDb(c, t) {
    const section = Math.floor(t / SECTION_SEC) % 4; // 0..3
    const inSec = t % SECTION_SEC;
    const wob = (f, a) => a * Math.sin(2 * Math.PI * f * t + c.ch);
    const breath = inSec % 5 > 4.2; // respiro entre frases
    const solo = section % 2 === 0 ? 'Voz 1' : 'Voz 2';
    switch (c.persona) {
      case 'Teclado':
        return -20 + wob(0.3, 1.5);
      case 'Voz 1':
        if (solo === 'Voz 1') return breath ? null : -12 + wob(0.7, 2);
        return -52 + wob(0.5, 2); // vazamento baixo (abaixo do gate)
      case 'Voz 2':
        if (solo === 'Voz 2') return breath ? null : -24 + wob(0.6, 2);
        return null;
      case 'Voz 3':
      case 'Voz 4':
        return section >= 2 && !breath ? -26 + wob(0.4, 2) : null;
      case 'Bumbo':
        return -18 + wob(2, 3);
      case 'Caixa':
        return -22 + wob(2, 3);
      case 'Prato':
        return -26 + wob(3, 3);
      case 'Baixo':
        return -19 + wob(0.5, 1.5);
      case 'Guitarra':
        return inSec >= SECTION_SEC / 2 ? -10 + wob(0.8, 2) : -28 + wob(0.8, 2);
      case 'Quieto':
        return -32 + wob(0.5, 2);
      default:
        return null;
    }
  }

  const timer = setInterval(() => {
    const now = Date.now();
    const t = (now - t0) / 1000;
    const chans = new Array(32).fill(0);
    let busPow = 0;
    for (const [ch, s] of state) {
      const db = inputDb({ ch, persona: s.persona }, t);
      if (db == null) continue;
      const lin = dbToLin(db);
      chans[ch - 1] = lin;
      if (s.on) busPow += Math.pow(lin * dbToLin(faderToDb(s.send)), 2);
    }
    const busLin = Math.sqrt(busPow) * dbToLin(faderToDb(busFader));
    const buses = new Array(16).fill(0);
    buses[bus - 1] = busLin;
    // /meters/1 da X32 real tem 96 valores (32 canais + gate + dyn); os 32 primeiros são os canais
    const m1 = encode('/meters/1', [encodeMeterBlob([...chans, ...new Array(64).fill(0)])]);
    const m2 = encode('/meters/2', [encodeMeterBlob([...buses, ...new Array(33).fill(0)])]);
    for (const [k, ts] of meterSubs) {
      if (now - ts > SUB_MS) {
        meterSubs.delete(k);
        continue;
      }
      const [addrPort, which] = k.split('|');
      const [addr, p] = addrPort.split(':');
      sock.send(which === '/meters/1' ? m1 : m2, +p, addr);
    }
  }, 50);

  return new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(port, '127.0.0.1', () => {
      resolve({
        port: sock.address().port,
        state,
        // O simulador só tem um bus "vivo": acompanha a troca feita no app.
        setBus(b) {
          bus = b;
          busStr = pad2(b);
        },
        stop() {
          clearInterval(timer);
          sock.close();
        },
      });
    });
  });
}
