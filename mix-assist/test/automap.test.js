import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRole,
  normalizeName,
  normalizeMap,
  validateMap,
  classifyChannel,
  suggestAnchorGroup,
  buildProposal,
  finalizeMap,
  diffMap,
  anchorGroupOf,
  X32_ICONS,
  DEFAULT_RULES,
} from '../src/automap.js';

const role = (name, icon) => classifyChannel({ name, icon });

describe('normalizeRole / normalizeName', () => {
  test('"keyboard" é sinônimo de "anchor"; papel desconhecido vira null', () => {
    assert.equal(normalizeRole('keyboard'), 'anchor');
    assert.equal(normalizeRole('anchor'), 'anchor');
    assert.equal(normalizeRole('vocal'), 'vocal');
    assert.equal(normalizeRole('ref'), 'ref');
    assert.equal(normalizeRole('drums'), null);
    assert.equal(normalizeRole(undefined), null);
  });

  test('nome sem acento, maiúsculo e com espaços simples', () => {
    assert.equal(normalizeName('  Violão   L '), 'VIOLAO L');
    assert.equal(normalizeName('percussão'), 'PERCUSSAO');
    assert.equal(normalizeName(null), '');
  });
});

describe('classifyChannel — regras de nome', () => {
  const cases = [
    ['VOZ MIC PR', 'vocal', 'voz'],
    ['Voz1', 'vocal', 'voz'],
    ['BV 2', 'vocal', 'voz'],
    ['KEYS L', 'ref', 'teclado'],
    ['Piano', 'ref', 'teclado'],
    ['VIOLAO', 'ref', 'violão'],
    ['Violão', 'ref', 'violão'],
    ['AC GTR', 'ref', 'violão'],
    ['VIOLINO', 'ref', 'cordas'],
    ['GTR L', 'ref', 'guitarra'],
    ['GTR2', 'ref', 'guitarra'],
    ['BAIXO', 'ref', 'baixo'],
    ['BASS DI', 'ref', 'baixo'],
    ['BB', 'ref', 'bateria'],
    ['CAIXA UP', 'ref', 'bateria'],
    ['HIHAT', 'ref', 'bateria'],
    ['TOM 01', 'ref', 'bateria'],
    ['SD 02', 'ref', 'bateria'],
    ['OH L', 'ref', 'bateria'],
    ['SAX', 'ref', 'sopro'],
    ['Trompete', 'ref', 'sopro'],
    ['CAJON', 'ref', 'percussão'],
  ];
  for (const [name, r, g] of cases) {
    test(`"${name}" → ${r}/${g}`, () => {
      const c = role(name);
      assert.equal(c.role, r);
      assert.equal(c.group, g);
      assert.equal(c.source, 'name');
    });
  }

  test('playback, click e efeitos ficam de fora (ignore)', () => {
    for (const n of ['PB L', 'PLAYBACK', 'CLICK', 'NOTE', 'FX REV', 'TALKBACK']) {
      assert.equal(role(n).role, 'ignore', n);
    }
  });

  test('palavra dentro de outra não casa ("BAIXOS" não é "BX", "TOMADA" não é "TOM")', () => {
    assert.equal(role('TOMADA'), null);
    assert.equal(role('SAXOFONE')?.group, 'sopro'); // prefixo sem fronteira no fim é intencional para sopro
  });

  test('nome vazio ou desconhecido sem ícone → null', () => {
    assert.equal(role(''), null);
    assert.equal(role('XYZ'), null);
    assert.equal(role(undefined), null);
  });

  test('regras do config substituem as padrão', () => {
    const rules = [{ match: '^LOUVOR', role: 'vocal' }, { match: '^CTB', role: 'ref', group: 'baixo' }];
    assert.equal(classifyChannel({ name: 'LOUVOR 1' }, { rules }).role, 'vocal');
    assert.equal(classifyChannel({ name: 'CTB' }, { rules }).group, 'baixo');
    assert.equal(classifyChannel({ name: 'VOZ' }, { rules, icons: {} }), null);
  });

  test('regra com regex inválida explica qual é', () => {
    assert.throws(() => classifyChannel({ name: 'X' }, { rules: [{ match: '(' }] }), /Regra de nome inválida/);
  });
});

describe('classifyChannel — ícones', () => {
  test('ícone é usado quando o nome não diz nada', () => {
    assert.deepEqual(role('CH 05', X32_ICONS.femaleVocal), { role: 'vocal', group: 'voz', source: 'icon' });
    assert.equal(role('', X32_ICONS.kickFront).group, 'bateria');
    assert.equal(role('', X32_ICONS.electricBass).group, 'baixo');
    assert.equal(role('', X32_ICONS.acousticGuitar).group, 'violão');
    assert.equal(role('', X32_ICONS.keyboard).group, 'teclado');
    assert.equal(role('', X32_ICONS.saxophone).group, 'sopro');
  });

  test('o nome vence o ícone (texto explícito do operador)', () => {
    const c = role('VOZ PR', X32_ICONS.lesPaul);
    assert.equal(c.role, 'vocal');
    assert.equal(c.source, 'name');
  });

  test('ícone vazio ou sem regra → null', () => {
    assert.equal(role('', X32_ICONS.empty), null);
    assert.equal(role('', 999), null);
  });

  test('tabela de ícones do config (chaves em texto, como no JSON)', () => {
    const icons = { 61: { role: 'vocal' } };
    assert.equal(classifyChannel({ name: '', icon: 61 }, { icons }).role, 'vocal');
    assert.equal(classifyChannel({ name: '', icon: 61 }, { icons: { '61': { role: 'ref', group: 'fx' } } }).group, 'fx');
  });
});

describe('suggestAnchorGroup', () => {
  test('nome do bus sugere de quem é o fone', () => {
    assert.equal(suggestAnchorGroup('FONE GUITARRA'), 'guitarra');
    assert.equal(suggestAnchorGroup('IEM BAT'), 'bateria');
    assert.equal(suggestAnchorGroup('TECLADO'), 'teclado');
  });
  test('bus genérico ou de voz não sugere nada', () => {
    assert.equal(suggestAnchorGroup('MON 2'), null);
    assert.equal(suggestAnchorGroup('VOZ PR'), null);
    assert.equal(suggestAnchorGroup(''), null);
    assert.equal(suggestAnchorGroup(undefined), null);
  });
});

describe('normalizeMap / validateMap', () => {
  test('config antigo com "keyboard" continua válido e ganha grupo "teclado"', () => {
    const m = normalizeMap([{ ch: 15, role: 'keyboard', name: 'KEYS L' }, { ch: 1, role: 'vocal' }]);
    assert.equal(m[0].role, 'anchor');
    assert.equal(m[0].group, 'teclado');
    assert.equal(m[1].group, 'voz');
  });

  test('âncora com grupo próprio mantém o grupo', () => {
    assert.equal(normalizeMap([{ ch: 17, role: 'anchor', group: 'guitarra' }])[0].group, 'guitarra');
    assert.equal(anchorGroupOf([{ ch: 17, role: 'anchor', group: 'guitarra' }]), 'guitarra');
  });

  test('erros: sem âncora, canal fora de 1–32, repetido, papel inválido, teto inválido', () => {
    assert.match(validateMap([{ ch: 1, role: 'vocal' }]).join(), /âncora/);
    assert.match(validateMap([{ ch: 0, role: 'anchor' }]).join(), /canal inválido/);
    assert.match(validateMap([{ ch: 33, role: 'anchor' }]).join(), /canal inválido/);
    assert.match(validateMap([{ ch: 1, role: 'anchor' }, { ch: 1, role: 'vocal' }]).join(), /repetido/);
    assert.match(validateMap([{ ch: 1, role: 'anchor' }, { ch: 2, role: 'drums' }]).join(), /desconhecido/);
    assert.match(validateMap([{ ch: 1, role: 'anchor' }, { ch: 2, role: 'ref', ceilingDb: 'x' }]).join(), /ceilingDb/);
    assert.deepEqual(validateMap('x'), ['"channels" precisa ser uma lista']);
    assert.throws(() => normalizeMap([{ ch: 1, role: 'vocal' }]), /Mapa de canais inválido/);
  });
});

describe('buildProposal', () => {
  const patch = [
    { ch: 1, name: 'BB', icon: X32_ICONS.kickFront, sendOn: true },
    { ch: 13, name: 'VIOLAO' },
    { ch: 15, name: 'KEYS L' },
    { ch: 16, name: 'KEYS R' },
    { ch: 17, name: 'GTR L' },
    { ch: 20, name: 'VOZ PR' },
    { ch: 30, name: 'PB L' },
    { ch: 31, name: '', icon: X32_ICONS.maleVocal },
  ];

  test('sem config: classifica tudo e devolve as 32 linhas', () => {
    const { rows, anchorGroup } = buildProposal(patch);
    assert.equal(rows.length, 32);
    const r = (ch) => rows.find((x) => x.ch === ch);
    assert.equal(r(1).group, 'bateria');
    assert.equal(r(1).sendOn, true);
    assert.equal(r(13).group, 'violão');
    assert.equal(r(15).group, 'teclado');
    assert.equal(r(20).role, 'vocal');
    assert.equal(r(30).role, null);
    assert.equal(r(30).source, 'ignore');
    assert.equal(r(31).source, 'icon');
    assert.equal(r(2).role, null); // canal sem nada
    assert.equal(r(2).source, null);
    assert.equal(anchorGroup, 'teclado');
  });

  test('sem config: o nome do bus sugere a âncora', () => {
    assert.equal(buildProposal(patch, { busName: 'FONE GUITARRA' }).anchorGroup, 'guitarra');
  });

  test('com config: canal com o mesmo nome mantém a decisão do operador', () => {
    const previous = [
      { ch: 15, role: 'keyboard', name: 'KEYS L' },
      { ch: 13, role: 'ref', name: 'VIOLAO', group: 'cordas-custom' },
    ];
    const { rows, anchorGroup } = buildProposal(patch, { previous });
    const r = (ch) => rows.find((x) => x.ch === ch);
    assert.equal(r(13).group, 'cordas-custom');
    assert.equal(r(13).source, 'config');
    // a âncora antiga aparece como "ref" do grupo dela; quem é âncora vem do anchorGroup
    assert.equal(r(15).role, 'ref');
    assert.equal(r(15).group, 'teclado');
    assert.equal(anchorGroup, 'teclado');
  });

  test('com config: canal renomeado na mesa é reclassificado', () => {
    const previous = [{ ch: 15, role: 'keyboard', name: 'KEYS L' }, { ch: 17, role: 'ref', group: 'guitarra', name: 'GTR L', seen: { name: 'GTR L' } }];
    const { rows } = buildProposal([{ ch: 17, name: 'VIOLAO 2' }], { previous });
    const r17 = rows.find((x) => x.ch === 17);
    assert.equal(r17.group, 'violão');
    assert.equal(r17.source, 'name');
  });

  test('com config: canal ainda não lido da mesa mantém o que estava', () => {
    const previous = [{ ch: 15, role: 'keyboard', name: 'KEYS L' }];
    const { rows } = buildProposal([], { previous });
    assert.equal(rows.find((x) => x.ch === 15).source, 'config');
  });
});

describe('finalizeMap', () => {
  const patch = [
    { ch: 15, name: 'KEYS L', icon: 30 },
    { ch: 16, name: 'KEYS R', icon: 30 },
    { ch: 17, name: 'GTR L', icon: 20 },
    { ch: 20, name: 'VOZ PR' },
  ];
  const rows = [
    { ch: 20, role: 'vocal', group: 'voz' },
    { ch: 17, role: 'ref', group: 'guitarra' },
    { ch: 15, role: 'ref', group: 'teclado' },
    { ch: 16, role: 'ref', group: 'teclado' },
    { ch: 5, role: null },
  ];

  test('o grupo escolhido vira âncora; o resto mantém o papel', () => {
    const { channels, errors } = finalizeMap(rows, 'guitarra', { patch });
    assert.deepEqual(errors, []);
    const c = (ch) => channels.find((x) => x.ch === ch);
    assert.equal(c(17).role, 'anchor');
    assert.equal(c(15).role, 'ref');
    assert.equal(c(20).role, 'vocal');
    assert.equal(c(5), undefined);
    assert.equal(channels[0].ch, 17, 'âncora primeiro');
  });

  test('guarda nome e ícone vistos na mesa ("seen")', () => {
    const { channels } = finalizeMap(rows, 'teclado', { patch });
    const k = channels.find((x) => x.ch === 15);
    assert.equal(k.role, 'anchor');
    assert.equal(k.name, 'KEYS L');
    assert.deepEqual(k.seen, { name: 'KEYS L', icon: 30 });
    assert.deepEqual(channels.find((x) => x.ch === 20).seen, { name: 'VOZ PR' });
  });

  test('voz nunca vira âncora, mesmo com grupo igual', () => {
    const { errors } = finalizeMap([{ ch: 1, role: 'vocal', group: 'voz' }], 'voz', { patch: [] });
    assert.match(errors.join(), /nenhum canal/);
  });

  test('sem nenhum canal do grupo âncora → erro explicando', () => {
    const { errors } = finalizeMap(rows, 'bateria', { patch });
    assert.match(errors.join(), /bateria/);
  });

  test('teto por canal (ceilingDb) é preservado se o grupo não mudou', () => {
    const previous = [{ ch: 17, role: 'ref', group: 'guitarra', ceilingDb: -4 }, { ch: 16, role: 'ref', group: 'baixo', ceilingDb: -2 }];
    const { channels } = finalizeMap(rows, 'teclado', { patch, previous });
    assert.equal(channels.find((x) => x.ch === 17).ceilingDb, -4);
    assert.equal(channels.find((x) => x.ch === 16).ceilingDb, undefined); // era baixo, agora é âncora
  });

  test('linhas inválidas são descartadas e o resultado passa no validateMap', () => {
    const { channels, errors } = finalizeMap([...rows, { ch: 'x', role: 'ref' }, { ch: 3, role: 'drums' }], 'teclado', { patch });
    assert.deepEqual(errors, []);
    assert.deepEqual(validateMap(channels), []);
    assert.ok(!channels.some((c) => c.ch === 3));
  });

  test('nome cai para o do mapa anterior e depois para "ch N"', () => {
    const { channels } = finalizeMap([{ ch: 9, role: 'ref', group: 'teclado' }, { ch: 8, role: 'vocal' }], 'teclado', { previous: [{ ch: 9, name: 'PIANO' }] });
    assert.equal(channels.find((x) => x.ch === 9).name, 'PIANO');
    assert.equal(channels.find((x) => x.ch === 8).name, 'ch 8');
    assert.equal(channels.find((x) => x.ch === 8).group, 'voz');
  });
});

describe('diffMap — troca de patch', () => {
  const map = [
    { ch: 15, role: 'anchor', name: 'KEYS L', seen: { name: 'KEYS L', icon: 30 } },
    { ch: 17, role: 'ref', group: 'guitarra', name: 'GTR L', seen: { name: 'GTR L' } },
    { ch: 20, role: 'vocal', name: 'VOZ' }, // sem "seen": config manual, não é verificado
  ];

  test('mesmo patch → sem divergência (ignora acento/caixa)', () => {
    assert.deepEqual(diffMap(map, [{ ch: 15, name: 'keys l', icon: 30 }, { ch: 17, name: 'GTR L' }, { ch: 20, name: 'OUTRO' }]), []);
  });

  test('nome diferente → divergência com o esperado e o atual', () => {
    const d = diffMap(map, [{ ch: 17, name: 'VIOLAO' }]);
    assert.equal(d.length, 1);
    assert.equal(d[0].ch, 17);
    assert.deepEqual(d[0].reasons, ['name']);
    assert.equal(d[0].expected.name, 'GTR L');
    assert.equal(d[0].actual.name, 'VIOLAO');
  });

  test('ícone diferente → divergência', () => {
    assert.deepEqual(diffMap(map, [{ ch: 15, name: 'KEYS L', icon: 41 }])[0].reasons, ['icon']);
  });

  test('campo ainda não lido não conta como divergência', () => {
    assert.deepEqual(diffMap(map, [{ ch: 15 }, { ch: 17, icon: 3 }]), []);
    assert.deepEqual(diffMap(map, []), []);
  });
});

test('DEFAULT_RULES: toda regra é uma regex válida', () => {
  for (const r of DEFAULT_RULES) assert.doesNotThrow(() => new RegExp(r.match, 'i'), r.match);
});
