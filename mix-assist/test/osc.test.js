// Codec OSC, lei de fader e conversões — casos de borda.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pad2, encode, decode, faderToDb, dbToFader, decodeMeterBlob, encodeMeterBlob, linToDb, dbToLin,
} from '../src/osc.js';

test('encode: tipos explícitos f/s, blob alinhado a 4 bytes e tipo inválido', () => {
  const blob = Buffer.from([1, 2, 3, 4, 5]);
  const msg = decode(encode('/x', [{ type: 'f', value: 0.25 }, { type: 's', value: 42 }, blob]));
  assert.equal(msg.args[0], 0.25);
  assert.equal(msg.args[1], '42');
  assert.deepEqual([...msg.args[2]], [1, 2, 3, 4, 5]);
  assert.equal(encode('/x', [blob]).length % 4, 0);
  assert.equal(decode(encode('/i', [{ type: 'i', value: 3.9 }])).args[0], 3, 'int trunca');
  for (const bad of [null, true, undefined, { type: 'x' }]) {
    assert.throws(() => encode('/x', [bad]), /Tipo OSC não suportado/);
  }
});

test('decode: só endereço, tags sem vírgula e tag desconhecida', () => {
  const onlyAddr = Buffer.from('/info\0\0\0');
  assert.deepEqual(decode(onlyAddr), { address: '/info', args: [] });
  const noComma = Buffer.concat([Buffer.from('/a\0\0'), Buffer.from('xyz\0')]);
  assert.deepEqual(decode(noComma), { address: '/a', args: [] });
  const badTag = Buffer.concat([Buffer.from('/a\0\0'), Buffer.from(',q\0\0')]);
  assert.throws(() => decode(badTag), /Tag OSC não suportada: q/);
  const utf8 = decode(encode('/ch/01/config/name', ['VIOLÃO']));
  assert.equal(utf8.args[0], 'VIOLÃO');
});

test('lei de fader: todos os trechos nos dois sentidos', () => {
  // trechos: [0.5,1] [0.25,0.5) [0.0625,0.25) (0,0.0625) e 0
  assert.equal(faderToDb(0.75), 0);
  assert.equal(faderToDb(0.3), -26);
  assert.equal(faderToDb(0.1), -54);
  assert.equal(faderToDb(0.05), -66);
  assert.equal(faderToDb(-1), -90);
  for (const db of [5, -20, -45, -75]) assert.ok(Math.abs(faderToDb(dbToFader(db)) - db) < 0.3, `${db}`);
  assert.equal(dbToFader(-90), 0);
  assert.equal(dbToFader(-200), 0);
  assert.equal(dbToFader(50), 1, 'limitado a 1');
});

test('meters e conversões lineares', () => {
  assert.deepEqual(decodeMeterBlob(null), []);
  assert.deepEqual(decodeMeterBlob(Buffer.alloc(2)), []);
  const blob = encodeMeterBlob([0.5, 0.25]);
  blob.writeInt32LE(10, 0); // contagem maior que o blob: lê só o que existe
  assert.deepEqual(decodeMeterBlob(blob), [0.5, 0.25]);
  assert.equal(linToDb(0), -120);
  assert.equal(linToDb(NaN), -120);
  assert.equal(linToDb(1), 0);
  assert.ok(Math.abs(linToDb(dbToLin(-12)) - -12) < 1e-9);
  assert.equal(pad2(7), '07');
  assert.equal(pad2(12), '12');
});
