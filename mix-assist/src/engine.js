// Motor de regras PURO: sem rede, sem timers. Todo método recebe `now` (ms).
import { linToDb, dbToFader, faderToDb } from './osc.js';
import { normalizeMap } from './automap.js';

export const DEFAULTS = {
  gateDb: -45,
  meterTauSec: 1.2,
  fastTauSec: 0.3,
  fadeDb: 6,
  keyRefTauSec: 8,
  warmupSec: 4,
  soloLeadDb: 3,
  soloHoldSec: 1.5,
  soloReleaseSec: 4,
  soloVsKeyDb: 0,
  backingGapDb: 5,
  // Vozes são só referência no fone: envio (dB no bus) com teto absoluto.
  vocalBackingDb: -10, // backings ficam por volta disso
  vocalSoloMaxDb: -8, // a solista nunca passa disso (nem nenhuma voz)
  ceilingDb: -1, // teto padrão de instrumento, em dB relativo ao teclado
  groupCeilingDb: {}, // teto por grupo (ex.: { bateria: -10, baixo: -3 }); "ceilingDb" no canal vence
  maxBoostDb: 6,
  maxCutDb: 10,
  maxCeilingCutDb: 30,
  maxRateDbPerSec: 1,
  deadbandDb: 0.75,
  manualHoldSec: 20,
  busClipDb: -3,
  // Suavidade do modo automático: movimentos em etapas, com espera entre elas.
  dwellSec: 2.5, // a diferença precisa durar isso antes de começar um ajuste
  ceilingDwellSec: 1, // passou do teclado: confirma mais rápido
  settleSec: 6, // descanso depois de cada ajuste antes do próximo
  maxMoveDb: 3, // tamanho máximo de cada etapa
  autoStartDb: 1.5, // diferença mínima para o automático se mexer
  // Instrumento acima do teclado: corte mais rápido (as vozes e as subidas continuam suaves).
  cutMaxMoveDb: 6, // etapa maior
  cutRateDbPerSec: 2, // velocidade da descida
  cutSettleSec: 2, // descanso curto entre etapas
};

const MANUAL_TOL_DB = 0.4;
const MERGE_WINDOW_MS = 3000;
const HISTORY_MAX = 200;
const ROLE_ORDER = { anchor: 0, vocal: 1, ref: 2 };

const round = (x, step) => Math.round(x / step) * step;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const quantize = (db) => faderToDb(dbToFader(db));

// Ajuste de solista por canal: de 0 a −9 dB, em passos de 1 dB (só para baixo).
export const SOLO_OFFSET_MIN_DB = -9;
export function clampSoloOffset(db) {
  const n = Math.round(Number(db));
  if (!Number.isFinite(n)) return 0;
  const v = clamp(n, SOLO_OFFSET_MIN_DB, 0);
  return Object.is(v, -0) ? 0 : v;
}

export class MixEngine {
  constructor(map, opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    // "keyboard" (configs antigos) vira "anchor": o instrumento do dono do fone.
    map = normalizeMap(map);
    const keys = map.filter((c) => c.role === 'anchor');
    this.channels = new Map();
    for (const c of map) {
      this.channels.set(c.ch, {
        ch: c.ch,
        role: c.role,
        group: c.group,
        // Teto do instrumento em relação ao teclado: do canal, senão do grupo, senão o padrão.
        ceilingDb: c.role !== 'ref' ? null
          : Number.isFinite(c.ceilingDb) ? c.ceilingDb
          : Number.isFinite(this.opts.groupCeilingDb?.[c.group]) ? this.opts.groupCeilingDb[c.group]
          : this.opts.ceilingDb,
        name: c.name || `ch ${c.ch}`,
        // Só vozes: quanto mais baixo esse canal fica quando é a solista (ex.: voz
        // muito aguda que fura o fone). 0 = igual às outras.
        soloOffsetDb: c.role === 'vocal' ? clampSoloOffset(c.soloOffsetDb) : 0,
        sendDb: null,
        on: true,
        baseDb: null,
        pow: null,
        envDb: -120,
        fastPow: null,
        fastDb: -120,
        target: null,
        targetIsCeiling: false,
        hardCap: false, // voz acima do teto absoluto: corrige mesmo em silêncio
        fixedTarget: false, // alvo em dB de envio que não depende do nível do canal
        fastTarget: null,
        approved: null,
        lastCommanded: null,
        recentCommands: [],
        holdUntil: 0,
        move: null, // etapa em andamento no automático: { goal }
        settleUntil: 0,
        wantSince: null,
        wantDir: 0,
        reason: '',
      });
    }
    // Âncora pode ser mono (1 canal) ou estéreo (L/R): a referência é a média de potência.
    // (Os nomes internos "key*" são históricos: valem para qualquer âncora.)
    this.keyChs = keys.map((k) => k.ch);
    this.anchorName = keys[0].group;
    this.block = null; // motivo pelo qual o assistente não pode ser ligado (ex.: patch mudou)
    this.mode = 'off';
    this.soloist = null;
    this.challenger = null;
    this.challengerSince = null;
    this.soloSilentSince = null;
    this.keyRefPow = null;
    this.keyPlayedSec = 0;
    this.lastMeterAt = null;
    this.lastTickAt = null;
    this.busDb = null;
    this.history = [];
  }

  get keyRefDb() {
    return this.keyRefPow == null ? null : 10 * Math.log10(Math.max(this.keyRefPow, 1e-12));
  }

  get keyChannels() {
    return this.keyChs.map((ch) => this.channels.get(ch));
  }

  get keySendDb() {
    const ks = this.keyChannels;
    if (ks.some((k) => k.sendDb == null)) return null;
    return ks.reduce((sum, k) => sum + k.sendDb, 0) / ks.length;
  }

  get keyContrib() {
    const send = this.keySendDb;
    if (this.keyRefDb == null || send == null) return null;
    return this.keyRefDb + send;
  }

  get ready() {
    return this.keyContrib != null && this.keyPlayedSec >= this.opts.warmupSec;
  }

  // Ativo = envelope lento E rápido acima do gate (o lento sozinho demora a cair quando a voz para).
  isActive(c) {
    return c.pow != null && c.envDb > this.opts.gateDb && c.fastDb > this.opts.gateDb;
  }

  // Sinal caindo (fim de frase): nunca subir o envio nesse momento.
  isFading(c) {
    return c.fastDb < c.envDb - this.opts.fadeDb;
  }

  isHeld(c, now) {
    return now < c.holdUntil;
  }

  // ---------- entradas ----------

  setName(ch, name) {
    const c = this.channels.get(ch);
    if (c && name) c.name = name;
  }

  // Ajuste de solista de uma voz (ver clampSoloOffset). Retorna o valor aplicado,
  // ou null se o canal não for voz.
  setSoloOffset(ch, db) {
    const c = this.channels.get(ch);
    if (!c || c.role !== 'vocal') return null;
    c.soloOffsetDb = clampSoloOffset(db);
    return c.soloOffsetDb;
  }

  setSendOn(ch, on) {
    const c = this.channels.get(ch);
    if (c) c.on = !!on;
  }

  setBusMeter(lin) {
    this.busDb = linToDb(lin);
  }

  setChannelMeters(lin, now) {
    const dt = this.lastMeterAt == null ? 0 : Math.max(0, (now - this.lastMeterAt) / 1000);
    this.lastMeterAt = now;
    const a = 1 - Math.exp(-dt / this.opts.meterTauSec);
    const af = 1 - Math.exp(-dt / this.opts.fastTauSec);
    for (const c of this.channels.values()) {
      const v = lin[c.ch - 1] ?? 0;
      const p = v * v;
      c.pow = c.pow == null ? p : c.pow + a * (p - c.pow);
      c.envDb = c.pow > 1e-12 ? 10 * Math.log10(c.pow) : -120;
      c.fastPow = c.fastPow == null ? p : c.fastPow + af * (p - c.fastPow);
      c.fastDb = c.fastPow > 1e-12 ? 10 * Math.log10(c.fastPow) : -120;
    }
    const ks = this.keyChannels;
    if (ks.some((k) => this.isActive(k))) {
      this.keyPlayedSec += dt;
      const kp = ks.reduce((sum, k) => sum + k.pow, 0) / ks.length;
      const ak = 1 - Math.exp(-dt / this.opts.keyRefTauSec);
      this.keyRefPow = this.keyRefPow == null ? kp : this.keyRefPow + ak * (kp - this.keyRefPow);
    }
  }

  onMixerSend(ch, db, now) {
    const c = this.channels.get(ch);
    if (!c) return;
    if (c.sendDb == null) {
      c.sendDb = db;
      c.baseDb = db;
      return;
    }
    const changed = Math.abs(db - c.sendDb) >= MANUAL_TOL_DB;
    const fromEngine = c.recentCommands.some(
      (r) => now - r.t < MERGE_WINDOW_MS && Math.abs(quantize(r.db) - db) < MANUAL_TOL_DB,
    );
    if (changed && !fromEngine) {
      this._manual(c, db, now, 'manual', 'ajuste na mesa');
    }
    c.sendDb = db;
  }

  onUserSend(ch, db, now) {
    const c = this.channels.get(ch);
    if (!c || c.role === 'anchor') return null; // o teclado nunca é alterado pelo app
    db = clamp(db, -90, 10);
    this._manual(c, db, now, 'web', 'ajuste pela página');
    c.sendDb = db;
    this._remember(c, db, now);
    return { ch, db };
  }

  // Ajuste manual do teclado pela página: move L e R juntos (mantém o estéreo).
  // É o único jeito de mexer no teclado — o motor nunca o altera sozinho.
  // Como tudo é relativo ao teclado, baixá-lo baixa junto o limite dos instrumentos.
  adjustKeyboard(deltaDb, now) {
    if (!Number.isFinite(deltaDb) || deltaDb === 0) return [];
    const ks = this.keyChannels;
    if (ks.some((k) => k.sendDb == null)) return [];
    const actions = [];
    for (const k of ks) {
      const db = Math.round(clamp(k.sendDb + deltaDb, -90, 10) * 100) / 100;
      if (db === k.sendDb) continue;
      this._log(now, k, k.sendDb, db, 'web', `${this.anchorName} ajustado pela página`);
      k.sendDb = db;
      k.baseDb = db;
      this._remember(k, db, now);
      actions.push({ ch: k.ch, db });
    }
    return actions;
  }

  _manual(c, db, now, source, reason) {
    this._log(now, c, c.sendDb, db, source, reason);
    c.holdUntil = now + this.opts.manualHoldSec * 1000;
    c.baseDb = db;
    c.approved = null;
    c.target = null;
    c.move = null;
    c.wantSince = null;
  }

  _remember(c, db, now) {
    c.lastCommanded = db;
    c.recentCommands.push({ t: now, db });
    c.recentCommands = c.recentCommands.filter((r) => now - r.t < MERGE_WINDOW_MS);
  }

  // Troca de bus do fone: os envios lidos pertencem ao bus antigo, então tudo
  // que depende deles é zerado e o assistente volta a "Desligado" por segurança.
  // A referência do teclado (nível de entrada) continua valendo.
  resetBus() {
    for (const c of this.channels.values()) {
      Object.assign(c, { sendDb: null, baseDb: null, on: true, target: null, targetIsCeiling: false,
        approved: null, lastCommanded: null, recentCommands: [], holdUntil: 0, reason: '', hardCap: false, fixedTarget: false, fastTarget: null,
        move: null, settleUntil: 0, wantSince: null, wantDir: 0 });
    }
    this.mode = 'off';
    this.busDb = null;
  }

  // Troca de mesa (outro IP ou simulador): além dos envios, o nível de entrada
  // e a referência do teclado vêm de outra fonte, então recalibra do zero.
  resetMixer() {
    this.resetBus();
    for (const c of this.channels.values()) {
      Object.assign(c, { pow: null, envDb: -120, fastPow: null, fastDb: -120 });
    }
    this.soloist = null;
    this.challenger = null;
    this.challengerSince = null;
    this.soloSilentSince = null;
    this.keyRefPow = null;
    this.keyPlayedSec = 0;
    this.lastMeterAt = null;
  }

  setMode(mode) {
    if (!['off', 'assist', 'auto'].includes(mode)) throw new Error(`Modo inválido: ${mode}`);
    if (mode !== 'off' && this.block) throw new Error(`Assistente bloqueado: ${this.block}`);
    this.mode = mode;
    if (mode !== 'assist') for (const c of this.channels.values()) c.approved = null;
  }

  // Bloqueio de segurança (ex.: o patch da mesa não bate com o mapa salvo).
  // Enquanto houver motivo, o assistente fica em "Desligado" e não pode ser ligado.
  setBlock(reason) {
    this.block = reason || null;
    if (this.block) this.setMode('off');
  }

  approve(ch) {
    const c = this.channels.get(ch);
    if (c && c.role !== 'anchor' && c.target != null) c.approved = c.target;
  }

  approveAll() {
    for (const c of this.channels.values()) this.approve(c.ch);
  }

  saveBase() {
    for (const c of this.channels.values()) if (c.sendDb != null) c.baseDb = c.sendDb;
  }

  restoreBase(now) {
    const actions = [];
    for (const c of this.channels.values()) {
      if (c.role === 'anchor' || c.baseDb == null || c.sendDb == null) continue;
      if (Math.abs(c.baseDb - c.sendDb) < 0.05) continue;
      this._log(now, c, c.sendDb, c.baseDb, 'web', 'voltar à mix base');
      c.sendDb = c.baseDb;
      c.target = null;
      c.approved = null;
      c.holdUntil = now + this.opts.manualHoldSec * 1000;
      this._remember(c, c.baseDb, now);
      actions.push({ ch: c.ch, db: c.baseDb });
    }
    return actions;
  }

  // ---------- motor ----------

  _updateSoloist(now, dt) {
    const o = this.opts;
    const vocals = [...this.channels.values()].filter((c) => c.role === 'vocal');
    const active = vocals.filter((c) => this.isActive(c));
    const strongest = (list) => list.reduce((best, c) => (!best || c.envDb > best.envDb ? c : best), null);

    if (this.soloist == null) {
      const s = strongest(active);
      if (s) this.soloist = s.ch;
      this.challenger = null;
      this.soloSilentSince = null;
      return;
    }

    const solo = this.channels.get(this.soloist);
    const soloActive = this.isActive(solo);

    if (!soloActive) {
      if (this.soloSilentSince == null) this.soloSilentSince = now;
      if ((now - this.soloSilentSince) / 1000 >= o.soloReleaseSec) {
        this.soloist = null;
        this.challenger = null;
        this.soloSilentSince = null;
        const s = strongest(active);
        if (s) this.soloist = s.ch;
        return;
      }
    } else {
      this.soloSilentSince = null;
    }

    const cand = strongest(active.filter((c) => c.ch !== this.soloist));
    const leading = cand && (!soloActive || cand.envDb >= solo.envDb + o.soloLeadDb);
    if (leading) {
      if (this.challenger !== cand.ch) {
        this.challenger = cand.ch;
        this.challengerSince = now;
      } else if ((now - this.challengerSince) / 1000 >= o.soloHoldSec) {
        this.soloist = cand.ch;
        this.challenger = null;
        this.soloSilentSince = null;
      }
    } else {
      this.challenger = null;
    }
  }

  _computeTargets(now) {
    const o = this.opts;
    const keyContrib = this.keyContrib;
    const solo = this.soloist != null ? this.channels.get(this.soloist) : null;
    const soloTarget = keyContrib == null ? null : keyContrib + o.soloVsKeyDb;

    for (const c of this.channels.values()) {
      c.target = null;
      c.targetIsCeiling = false;
      c.hardCap = false;
      c.fixedTarget = false;
      c.fastTarget = null;
      if (c.role === 'anchor') {
        c.reason = 'referência';
        continue;
      }
      if (c.sendDb == null || c.baseDb == null) {
        c.reason = 'aguardando leitura da mesa';
        continue;
      }
      if (this.isHeld(c, now)) {
        c.reason = `travado (ajuste manual) por ${Math.ceil((c.holdUntil - now) / 1000)} s`;
        continue;
      }
      if (!c.on) {
        c.reason = 'envio desligado';
        continue;
      }
      if (c.role === 'vocal') {
        this._vocalTarget(c, solo, soloTarget);
        continue;
      }
      if (!this.ready) {
        c.reason = `aguardando o ${this.anchorName} tocar`;
        continue;
      }
      if (!this.isActive(c)) {
        c.reason = 'em silêncio';
        continue;
      }

      // Instrumentos: só um teto (do canal/grupo) em relação ao teclado.
      const contrib = c.envDb + c.sendDb;
      const targetContrib = keyContrib + c.ceilingDb;
      if (contrib <= targetContrib) {
        c.reason = 'ok';
        continue;
      }
      const desired = targetContrib - c.envDb;
      const lo = c.baseDb - o.maxCeilingCutDb;
      const hi = Math.min(10, c.baseDb + o.maxBoostDb);
      let goal = round(clamp(desired, lo, hi), 0.5);
      if (Object.is(goal, -0)) goal = 0;
      const lim = `${c.ceilingDb > 0 ? '+' : ''}${c.ceilingDb} dB do ${this.anchorName}`;
      const atCutLimit = desired < lo - 0.5;
      const cutNote = `no limite de corte (${o.maxCeilingCutDb} dB abaixo da mix base) — confira o ganho do canal na mesa`;
      if (Math.abs(goal - c.sendDb) < o.deadbandDb) {
        c.reason = atCutLimit ? `acima do limite (${lim}); ${cutNote}` : 'ok';
        continue;
      }
      c.target = goal;
      c.fastTarget = Math.max(lo, targetContrib - c.fastDb);
      c.targetIsCeiling = true;
      c.reason = `passou do limite (${lim}) → baixando${atCutLimit ? `; ${cutNote}` : ''}`;
    }
  }

  // Vozes: envio absoluto no bus. Backings por volta de vocalBackingDb; a solista
  // acompanha o teclado, mas entre vocalBackingDb e vocalSoloMaxDb. Nenhuma voz
  // passa de vocalSoloMaxDb — esse teto vale até em silêncio.
  _vocalTarget(c, solo, soloTarget) {
    const o = this.opts;
    const max = o.vocalSoloMaxDb;
    const back = Math.min(o.vocalBackingDb, max);
    const over = c.sendDb > max + 0.1; // folga para a quantização do fader
    const fmt = (db) => `${db > 0 ? '+' : ''}${db} dB`;
    const set = (goal, fastGoal, reason, fixed = false) => {
      goal = round(goal, 0.5);
      if (Object.is(goal, -0)) goal = 0;
      // Etapa em andamento termina no alvo; fora disso, diferenças pequenas ficam como estão.
      const moving = c.move && Math.sign(c.move.goal - c.sendDb) === Math.sign(goal - c.sendDb);
      if (!over && !moving && Math.abs(goal - c.sendDb) < o.deadbandDb) {
        c.reason = 'ok';
        return;
      }
      if (goal > c.sendDb && this.isFading(c)) {
        c.reason = 'sinal caindo — aguardando';
        return;
      }
      c.target = goal;
      c.fastTarget = fastGoal;
      c.hardCap = over;
      c.fixedTarget = fixed || over;
      c.targetIsCeiling = over;
      c.reason = reason;
    };

    if (!this.ready || !this.isActive(c)) {
      if (over) set(max, max, `voz acima de ${fmt(max)} → teto`, true);
      else if (c.move && c.move.goal < c.sendDb) set(c.move.goal, c.move.goal, 'terminando a descida', true); // nunca sobe em silêncio
      else c.reason = this.ready ? 'em silêncio' : `aguardando o ${this.anchorName} tocar`;
      return;
    }
    if (solo && c.ch === solo.ch && soloTarget != null) {
      // O ajuste do canal vem depois da faixa normal: com −3, essa solista fica
      // sempre 3 dB abaixo de onde outra ficaria (até abaixo dos backings).
      const off = c.soloOffsetDb;
      const raw = clamp(soloTarget - c.envDb, back, max);
      const goal = raw + off;
      const fastGoal = clamp(soloTarget - c.fastDb, back, max) + off;
      const note = raw >= max ? ` (no máximo de ${fmt(max)})` : '';
      const offNote = off ? `, ${fmt(off)} por ser este canal` : '';
      set(goal, fastGoal, `solista → acompanha o ${this.anchorName}${note}${offNote}`);
    } else if (solo) {
      set(back, back, `backing → ${fmt(back)}`, true);
    } else if (over) {
      set(max, max, `voz acima de ${fmt(max)} → teto`, true);
    } else {
      c.reason = 'ok';
    }
  }

  tick(now) {
    const dt = this.lastTickAt == null ? 0 : clamp((now - this.lastTickAt) / 1000, 0, 1);
    this.lastTickAt = now;
    const o = this.opts;

    this._updateSoloist(now, dt);
    this._computeTargets(now);

    const suggestions = [];
    for (const c of this.channels.values()) {
      if (c.target != null) {
        suggestions.push({ ch: c.ch, name: c.name, from: c.sendDb, to: c.target, reason: c.reason });
      }
    }
    if (this.busDb != null && this.busDb > o.busClipDb) {
      suggestions.push({
        ch: null,
        name: 'Fone (Bus)',
        from: null,
        to: null,
        reason: `bus em ${this.busDb.toFixed(1)} dBFS: abaixe o volume geral do fone`,
      });
    }

    const actions = [];
    if (this.mode === 'off') return { actions, suggestions };

    for (const c of this.channels.values()) {
      if (c.role === 'anchor' || c.sendDb == null) continue;
      if (this.isHeld(c, now)) {
        c.move = null;
        c.wantSince = null;
        continue;
      }
      let goal = null;
      if (this.mode === 'auto') goal = this._autoGoal(c, now);
      else if (this.mode === 'assist') goal = c.approved;
      if (goal == null) continue;
      const diff = goal - c.sendDb;
      if (Math.abs(diff) < 0.01) {
        this._finishMove(c, now);
        continue;
      }
      if (dt <= 0) continue;
      // Desacelera perto do fim (sem degrau no começo nem no fim do movimento)
      const ease = clamp(Math.abs(diff) / 1.5, 0.3, 1);
      const rate = c.move?.fast ? o.cutRateDbPerSec : o.maxRateDbPerSec;
      const maxStep = rate * ease * dt;
      let next = c.sendDb + clamp(diff, -maxStep, maxStep);
      if (Math.abs(goal - next) < 0.05) next = goal;
      next = Math.round(next * 100) / 100;
      this._log(now, c, c.sendDb, next, 'engine', c.reason || (this.mode === 'assist' ? 'sugestão aprovada' : ''));
      c.sendDb = next;
      this._remember(c, next, now);
      actions.push({ ch: c.ch, db: next });
      if (next === goal) this._finishMove(c, now);
    }
    return { actions, suggestions };
  }

  // Automático em etapas: espera a diferença se confirmar, anda no máximo
  // maxMoveDb por vez e descansa settleSec antes da próxima etapa.
  _autoGoal(c, now) {
    const o = this.opts;
    const want = c.target == null ? 0 : Math.sign(c.target - c.sendDb);
    if (c.move) {
      // Cancela se o motivo sumiu (silêncio) ou inverteu de direção
      if (want === 0 || want !== Math.sign(c.move.goal - c.sendDb)) {
        c.move = null;
        c.settleUntil = now + o.settleSec * 500;
        return null;
      }
      return c.move.goal;
    }
    // O nível do momento (envelope rápido) também precisa confirmar a direção:
    // o envelope lento ainda "lembra" de um pico que já passou.
    // Teto absoluto das vozes: corrige mesmo diferenças pequenas.
    // Alvo fixo (backing em -10): não depende do nível, então basta passar da zona morta.
    // Teto de instrumento também: é um limite, então vai até ele (dentro da zona morta).
    const minDiff = c.hardCap ? 0.1 : c.fixedTarget || c.targetIsCeiling ? o.deadbandDb : o.autoStartDb;
    const fastWant = c.target == null ? null : c.fastTarget - c.sendDb;
    if (c.target == null || Math.abs(c.target - c.sendDb) < minDiff
        || Math.sign(fastWant) !== want || Math.abs(fastWant) < minDiff) {
      c.wantSince = null;
      return null;
    }
    if (now < c.settleUntil) {
      c.reason = `${c.reason} · aguardando ${Math.ceil((c.settleUntil - now) / 1000)} s`;
      return null;
    }
    if (c.wantSince == null || c.wantDir !== want) {
      c.wantSince = now;
      c.wantDir = want;
      return null;
    }
    const dwell = c.targetIsCeiling ? o.ceilingDwellSec : o.dwellSec;
    if (now - c.wantSince < dwell * 1000) return null;
    // Corte rápido: só instrumento passando do teclado, e só para baixo.
    const fast = c.role === 'ref' && c.targetIsCeiling && want < 0;
    const step = fast ? o.cutMaxMoveDb : o.maxMoveDb;
    let goal = round(c.sendDb + clamp(c.target - c.sendDb, -step, step), 0.5);
    if (Object.is(goal, -0)) goal = 0;
    c.move = { goal, fast };
    c.wantSince = null;
    return goal;
  }

  _finishMove(c, now) {
    if (this.mode === 'assist') c.approved = null;
    if (c.move) {
      c.settleUntil = now + (c.move.fast ? this.opts.cutSettleSec : this.opts.settleSec) * 1000;
      c.move = null;
    }
  }

  _log(now, c, from, to, source, reason) {
    if (source === 'engine') {
      const last = this.history.findLast((h) => h.ch === c.ch);
      if (last && last.source === 'engine' && now - last.tEnd < MERGE_WINDOW_MS) {
        last.to = to;
        last.tEnd = now;
        if (reason) last.reason = reason;
        return;
      }
    }
    this.history.push({ t: now, tEnd: now, ch: c.ch, name: c.name, from, to, source, reason });
    if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);
  }

  snapshot(now = Date.now()) {
    const keyContrib = this.keyContrib;
    const solo = this.soloist != null ? this.channels.get(this.soloist) : null;
    const channels = [...this.channels.values()]
      .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.ch - b.ch)
      .map((c) => {
        const contribDb =
          c.role === 'anchor'
            ? keyContrib
            : c.sendDb == null || c.pow == null
              ? null
              : c.envDb + c.sendDb;
        return {
          ch: c.ch,
          name: c.name,
          role: c.role,
          group: c.group,
          ceilingDb: c.ceilingDb,
          soloOffsetDb: c.soloOffsetDb,
          sendDb: c.sendDb,
          baseDb: c.baseDb,
          on: c.on,
          envDb: c.envDb,
          contribDb,
          targetContribDb: c.target != null ? c.envDb + c.target : null,
          active: this.isActive(c),
          solo: c.ch === this.soloist,
          target: c.target,
          approved: c.approved,
          held: this.isHeld(c, now),
          holdLeftSec: Math.max(0, Math.ceil((c.holdUntil - now) / 1000)),
          reason: c.reason,
        };
      });
    return {
      mode: this.mode,
      block: this.block,
      anchorName: this.anchorName,
      ready: this.ready,
      soloist: solo ? { ch: solo.ch, name: solo.name } : null,
      keyContrib,
      keyRefDb: this.keyRefDb,
      busDb: this.busDb,
      channels,
      history: this.history.slice(-60).reverse(),
    };
  }
}
