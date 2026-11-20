import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineJson, formatChannels, replaceTopLevel } from '../src/configfile.js';

const CONFIG = `{
  "mixer": { "host": "192.168.1.104", "port": 10023 },
  "bus": 2,
  "channels": [
    { "ch": 15, "role": "keyboard", "name": "KEYS ]L[" },

    { "ch": 20, "role": "vocal", "name": "VOZ \\"PR\\"" }
  ],
  "engine": { "groupCeilingDb": { "bateria": -10 } }
}
`;

test('inlineJson: uma linha com espaços e sem campos undefined', () => {
  assert.equal(inlineJson({ ch: 1, name: 'BB', seen: { name: 'BB', icon: 3 }, x: undefined }), '{ "ch": 1, "name": "BB", "seen": { "name": "BB", "icon": 3 } }');
  assert.equal(inlineJson([1, 'a']), '[1, "a"]');
  assert.equal(inlineJson({}), '{}');
});

test('formatChannels: um canal por linha', () => {
  const t = formatChannels([{ ch: 1, role: 'anchor' }, { ch: 2, role: 'vocal' }]);
  assert.equal(t, '[\n    { "ch": 1, "role": "anchor" },\n    { "ch": 2, "role": "vocal" }\n  ]');
  assert.equal(formatChannels([]), '[]');
});

test('replaceTopLevel: troca só "channels", mesmo com "]" e aspas dentro de nomes', () => {
  const channels = [{ ch: 17, role: 'anchor', group: 'guitarra', name: 'GTR' }];
  const out = replaceTopLevel(CONFIG, 'channels', formatChannels(channels));
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.channels, channels);
  assert.equal(parsed.bus, 2);
  assert.deepEqual(parsed.engine, { groupCeilingDb: { bateria: -10 } });
  // o resto do arquivo fica byte a byte igual
  assert.ok(out.startsWith('{\n  "mixer": { "host": "192.168.1.104", "port": 10023 },\n  "bus": 2,\n  "channels": ['));
  assert.ok(out.endsWith('],\n  "engine": { "groupCeilingDb": { "bateria": -10 } }\n}\n'));
});

test('replaceTopLevel: não confunde chave aninhada com a de primeiro nível', () => {
  const text = '{ "engine": { "bus": 9 }, "bus": 2 }';
  assert.deepEqual(JSON.parse(replaceTopLevel(text, 'bus', '5')), { engine: { bus: 9 }, bus: 5 });
});

test('replaceTopLevel: chave ausente é acrescentada no fim', () => {
  assert.deepEqual(JSON.parse(replaceTopLevel('{ "bus": 2 }', 'channels', '[]')), { bus: 2, channels: [] });
  assert.deepEqual(JSON.parse(replaceTopLevel('{}', 'bus', '1')), { bus: 1 });
});

test('replaceTopLevel: arquivo inválido não é alterado (lança erro)', () => {
  assert.throws(() => replaceTopLevel('{ "bus": ', 'bus', '1'));
});
