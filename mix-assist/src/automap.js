// Mapa de canais dinâmico — módulo PURO (sem rede, sem arquivos).
//
// A mesa já sabe quem é quem: o técnico dá nome e ícone a cada canal. Aqui ficam
// as regras que transformam esse "patch" (nome/ícone lidos por OSC) numa
// SUGESTÃO de mapa. A sugestão nunca é aplicada sozinha: o operador revisa e
// confirma na página (ver server.js).
//
// Papéis:
//   anchor — o instrumento do dono do fone. É a referência dos tetos e NUNCA é
//            alterado pelo motor. "keyboard" é aceito como sinônimo (configs antigos).
//   vocal  — candidatos a solista.
//   ref    — demais instrumentos (podem ser baixados até o teto do grupo).

export const ROLES = ['anchor', 'vocal', 'ref'];
export const CHANNEL_COUNT = 32;
export const DEFAULT_ANCHOR_GROUP = 'teclado';

// Regras por nome, avaliadas em ordem; a primeira que casa vence.
// "match" é uma expressão regular (sem diferenciar maiúsculas) aplicada ao nome
// já sem acentos e em maiúsculas. Termina em (?![A-Z]) e não em \b para
// que "VOZ1" e "GTR2" também casem. role "ignore" = deixa o canal de fora do mapa.
export const DEFAULT_RULES = [
  // Talkback e "off" (mic de fala dos músicos: OFF BAT, OFF KEY…) vêm antes de tudo,
  // senão "OFF BAT" cairia em bateria e "OFF BAIXO" em baixo. Não são candidatos a
  // solista: entram como instrumento do grupo "fala", só com teto.
  { match: '\\b(OFF|TALK|TALKBACK|MICTALK|TB)(?![A-Z])', role: 'ref', group: 'fala' },
  { match: '\\b(PB|PLAYBACK|CLICK|CLIQUE|TRACKS?|VS|PC|NOTE|NOTEBOOK|MAC|VIDEO|YOUTUBE|FX|REV|DLY|DELAY)(?![A-Z])', role: 'ignore' },
  { match: '\\b(VOZ|VOZES|VOX|VOC|VOCAL|BV|BACK|BACKING|CORO|CHOIR|LEAD)(?![A-Z])', role: 'vocal' },
  { match: '\\b(KEYS?|KB|KBD|TECL|TECLADO|PIANO|PNO|SYNTH|ORG|ORGAO|ORGAN|RHODES|WURLI)', role: 'ref', group: 'teclado' },
  { match: '\\b(VIOLINO|VIOLIN|VLN|CELLO|VIOLONCELO|STRINGS|CORDAS)', role: 'ref', group: 'cordas' },
  { match: '\\b(VIOL|VLAO|VIOLAO|AC ?GTR|ACOUST|NYLON)', role: 'ref', group: 'violão' },
  { match: '\\b(GTR|GT|GUIT|GUITARRA)', role: 'ref', group: 'guitarra' },
  { match: '\\b(BX|BAIXO|BASS|CONTRABAIXO)(?![A-Z])', role: 'ref', group: 'baixo' },
  { match: '\\b(BB|BUMBO|KICK|KCK|BD|CX|CAIXA|SNARE|SN|SD|HH|HIHAT|HI-HAT|CHIMBAL|TOMS?|SURDO|FLOOR|OH|OVER|OVERHEAD|RIDE|PRATOS?|CYM|BATERIA|BAT|DRUMS?)(?![A-Z])', role: 'ref', group: 'bateria' },
  { match: '\\b(SAX|TPT|TROMPETE|TRUMPET|TBN|TROMBONE|FLAUTA|FLUTE|CLARINETE|SOPRO|HORNS?|METAIS)', role: 'ref', group: 'sopro' },
  { match: '\\b(PERC|PERCUSSAO|CONGAS?|CAJON|BONGOS?|PANDEIRO|SHAKER|TAMB|TAMBORIM)', role: 'ref', group: 'percussão' },
];

// Ícones da X32/M32 (/ch/NN/config/icon, 1–74). Usados só quando o nome não
// casa com nenhuma regra. ATENÇÃO: numeração conforme a documentação OSC não
// oficial da X32 — confira na sua mesa/firmware e sobrescreva em
// config.json → autoMap.icons se necessário.
export const X32_ICONS = {
  empty: 1,
  kickBack: 2, kickFront: 3, snareTop: 4, snareBottom: 5, highTom: 6, midTom: 7, floorTom: 8,
  hiHat: 9, ride: 10, drumKit: 11, cowbell: 12, bongos: 13, congas: 14, tambourine: 15, vibraphone: 16,
  electricBass: 17, acousticBass: 18, contrabass: 19,
  lesPaul: 20, ibanez: 21, washburn: 22, acousticGuitar: 23, bassAmp: 24, guitarAmp: 25,
  piano: 27, organ: 28, harpsichord: 29, keyboard: 30, synth1: 31, synth2: 32, synth3: 33, keytar: 34,
  trumpet: 35, trombone: 36, saxophone: 37, clarinet: 38, violin: 39, cello: 40,
  maleVocal: 41, femaleVocal: 42, choir: 43,
  handheldMic: 50, wirelessMic: 51, podiumMic: 52, headsetMic: 53,
};

const I = X32_ICONS;
const range = (a, b, v) => Object.fromEntries(Array.from({ length: b - a + 1 }, (_, k) => [a + k, v]));
export const DEFAULT_ICONS = {
  ...range(I.kickBack, I.drumKit, { role: 'ref', group: 'bateria' }),
  ...range(I.cowbell, I.vibraphone, { role: 'ref', group: 'percussão' }),
  ...range(I.electricBass, I.contrabass, { role: 'ref', group: 'baixo' }),
  [I.bassAmp]: { role: 'ref', group: 'baixo' },
  ...range(I.lesPaul, I.washburn, { role: 'ref', group: 'guitarra' }),
  [I.guitarAmp]: { role: 'ref', group: 'guitarra' },
  [I.acousticGuitar]: { role: 'ref', group: 'violão' },
  ...range(I.piano, I.keytar, { role: 'ref', group: 'teclado' }),
  ...range(I.trumpet, I.clarinet, { role: 'ref', group: 'sopro' }),
  ...range(I.violin, I.cello, { role: 'ref', group: 'cordas' }),
  ...range(I.maleVocal, I.choir, { role: 'vocal' }),
  ...range(I.handheldMic, I.headsetMic, { role: 'vocal' }),
};

// "keyboard" → "anchor"; papéis desconhecidos viram null.
export function normalizeRole(role) {
  if (role === 'keyboard') return 'anchor';
  return ROLES.includes(role) ? role : null;
}

// Sem acentos, maiúsculas, espaços simples. "Violão  L" → "VIOLAO L".
export function normalizeName(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const sameName = (a, b) => normalizeName(a) === normalizeName(b);

function compileRules(rules) {
  return rules.map((r) => {
    let re;
    try {
      re = new RegExp(r.match, 'i');
    } catch (err) {
      throw new Error(`Regra de nome inválida "${r.match}": ${err.message}`);
    }
    return { ...r, re };
  });
}

// Classifica um canal pelo nome (primeiro) e, se o nome não disser nada, pelo ícone.
// O nome vem antes porque é texto explícito do operador; o ícone é um palpite.
// Retorna { role, group, source } ou null quando não há como saber.
export function classifyChannel({ name, icon } = {}, { rules = DEFAULT_RULES, icons = DEFAULT_ICONS } = {}) {
  const n = normalizeName(name);
  if (n) {
    for (const r of compileRules(rules)) {
      if (r.re.test(n)) {
        if (r.role === 'ignore') return { role: 'ignore', group: '', source: 'name' };
        return { role: r.role ?? 'ref', group: r.group ?? (r.role === 'vocal' ? 'voz' : ''), source: 'name' };
      }
    }
  }
  const hit = icon != null ? icons[icon] ?? icons[String(icon)] : null;
  if (hit) return { role: hit.role ?? 'ref', group: hit.group ?? (hit.role === 'vocal' ? 'voz' : ''), source: 'icon' };
  return null;
}

// Nome do bus como "FONE GUITARRA" ou "IEM BAT" sugere de quem é o fone.
export function suggestAnchorGroup(busName, opts) {
  const c = classifyChannel({ name: busName }, { ...opts, icons: {} });
  return c && c.role === 'ref' && c.group ? c.group : null;
}

// Mapa do config.json → formato interno. Aceita "keyboard" e valida o essencial.
export function normalizeMap(channels) {
  const errors = validateMap(channels);
  if (errors.length) throw new Error(`Mapa de canais inválido: ${errors.join('; ')}`);
  return channels.map((c) => {
    const role = normalizeRole(c.role);
    const group = c.group || (c.role === 'keyboard' ? 'teclado' : role === 'vocal' ? 'voz' : role === 'anchor' ? DEFAULT_ANCHOR_GROUP : '');
    return { ...c, role, group };
  });
}

export function validateMap(channels) {
  const errors = [];
  if (!Array.isArray(channels)) return ['"channels" precisa ser uma lista'];
  const seen = new Set();
  for (const c of channels) {
    if (!Number.isInteger(c?.ch) || c.ch < 1 || c.ch > CHANNEL_COUNT) {
      errors.push(`canal inválido: ${JSON.stringify(c?.ch)}`);
      continue;
    }
    if (seen.has(c.ch)) errors.push(`canal ${c.ch} repetido`);
    seen.add(c.ch);
    if (!normalizeRole(c.role)) errors.push(`canal ${c.ch}: papel "${c.role}" desconhecido`);
    if (c.ceilingDb != null && !Number.isFinite(c.ceilingDb)) errors.push(`canal ${c.ch}: ceilingDb inválido`);
  }
  if (!channels.some((c) => normalizeRole(c.role) === 'anchor')) {
    errors.push('é preciso ao menos um canal âncora (role "anchor" ou "keyboard")');
  }
  return errors;
}

// Grupo da âncora de um mapa existente (ex.: "teclado").
export function anchorGroupOf(channels) {
  const a = normalizeMap(channels).find((c) => c.role === 'anchor');
  return a?.group || DEFAULT_ANCHOR_GROUP;
}

// Sugestão para a tela de revisão: uma linha por canal da mesa (1–32).
// patch: [{ ch, name, icon, color, sendOn }] lidos da mesa.
// previous: mapa atual (config). Se o canal continua com o mesmo nome, o que o
// operador já tinha decidido para ele vence a regra automática.
export function buildProposal(patch, { previous = [], rules, icons, busName } = {}) {
  const prev = new Map(previous.map((c) => [c.ch, { ...c, role: normalizeRole(c.role) }]));
  const opts = { rules: rules ?? DEFAULT_RULES, icons: icons ?? DEFAULT_ICONS };
  const rows = [];
  for (let ch = 1; ch <= CHANNEL_COUNT; ch++) {
    const p = patch.find((x) => x.ch === ch) || { ch };
    const old = prev.get(ch);
    const base = { ch, name: p.name ?? '', icon: p.icon ?? null, color: p.color ?? null, sendOn: p.sendOn ?? null };
    if (old && (p.name == null || sameName(old.seen?.name ?? old.name, p.name))) {
      // Âncora antiga vira instrumento do grupo dela: quem é âncora é decidido pelo anchorGroup.
      const group = old.group || (old.role === 'vocal' ? 'voz' : old.role === 'anchor' ? DEFAULT_ANCHOR_GROUP : '');
      rows.push({ ...base, role: old.role === 'anchor' ? 'ref' : old.role, group, source: 'config' });
      continue;
    }
    const c = classifyChannel(p, opts);
    if (!c || c.role === 'ignore') rows.push({ ...base, role: null, group: '', source: c ? 'ignore' : null });
    else rows.push({ ...base, role: c.role, group: c.group, source: c.source });
  }
  const anchorGroup = previous.length ? anchorGroupOf(previous)
    : suggestAnchorGroup(busName, opts) ?? DEFAULT_ANCHOR_GROUP;
  return { rows, anchorGroup };
}

// Linhas confirmadas pelo operador → mapa pronto para o config.json.
// Quem é "ref" do anchorGroup vira âncora. Cada canal guarda o que foi visto na
// mesa ("seen") para detectar troca de patch depois (ver diffMap).
export function finalizeMap(rows, anchorGroup, { patch = [], previous = [] } = {}) {
  const prev = new Map(previous.map((c) => [c.ch, c]));
  const out = [];
  for (const r of rows) {
    const role = normalizeRole(r.role);
    if (!role || !Number.isInteger(r.ch)) continue;
    const group = String(r.group ?? '').trim() || (role === 'vocal' ? 'voz' : '');
    const isAnchor = role !== 'vocal' && group === anchorGroup;
    const p = patch.find((x) => x.ch === r.ch) || {};
    const name = p.name || r.name || prev.get(r.ch)?.name || `ch ${r.ch}`;
    const entry = { ch: r.ch, role: isAnchor ? 'anchor' : role, name };
    if (group) entry.group = group;
    const old = prev.get(r.ch);
    if (!isAnchor && role === 'ref' && Number.isFinite(old?.ceilingDb) && (old.group || '') === group) entry.ceilingDb = old.ceilingDb;
    // Ajuste de solista é do microfone: continua enquanto o canal for voz.
    if (role === 'vocal' && normalizeRole(old?.role) === 'vocal' && Number.isFinite(old.soloOffsetDb) && old.soloOffsetDb) entry.soloOffsetDb = old.soloOffsetDb;
    const seen = {};
    if (p.name != null) seen.name = p.name;
    if (Number.isInteger(p.icon)) seen.icon = p.icon;
    if (Object.keys(seen).length) entry.seen = seen;
    out.push(entry);
  }
  const ord = { anchor: 0, vocal: 1, ref: 2 };
  out.sort((a, b) => ord[a.role] - ord[b.role] || a.ch - b.ch);
  const errors = validateMap(out);
  if (!out.some((c) => c.role === 'anchor')) {
    return { channels: out, errors: [`nenhum canal do grupo "${anchorGroup}" foi marcado — escolha de quem é o fone`] };
  }
  return { channels: out, errors };
}

// Compara o mapa salvo com o que a mesa mostra agora. Só canais com "seen"
// (confirmados pela tela de revisão) são verificados; um campo ainda não lido
// da mesa (undefined) não conta como divergência.
export function diffMap(channels, patch) {
  const out = [];
  for (const c of channels) {
    if (!c.seen) continue;
    const p = patch.find((x) => x.ch === c.ch);
    if (!p) continue;
    const reasons = [];
    if (c.seen.name != null && p.name != null && !sameName(c.seen.name, p.name)) reasons.push('name');
    if (c.seen.icon != null && Number.isInteger(p.icon) && c.seen.icon !== p.icon) reasons.push('icon');
    if (reasons.length) out.push({ ch: c.ch, reasons, expected: { ...c.seen }, actual: { name: p.name, icon: p.icon } });
  }
  return out;
}
