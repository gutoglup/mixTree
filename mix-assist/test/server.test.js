// Fumaça do ponto de entrada: sobe `node src/server.js --sim` de verdade, abre a
// página e encerra com SIGTERM (saída limpa, código 0). Usa um config temporário
// (MIX_ASSIST_CONFIG) para nunca tocar o config.json do repositório.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

test('server.js --sim: sobe, serve a página e encerra limpo com SIGTERM', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mix-assist-srv-'));
  const cfg = path.join(dir, 'config.json');
  await fs.copyFile(path.join(ROOT, 'config.json'), cfg);
  const original = await fs.readFile(cfg, 'utf8');
  const port = await freePort();

  const child = spawn(process.execPath, ['src/server.js', '--sim'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), MIX_ASSIST_CONFIG: cfg },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

  try {
    const deadline = Date.now() + 8000;
    while (!out.includes(`http://localhost:${port}`)) {
      if (Date.now() > deadline || child.exitCode != null) throw new Error(`servidor não subiu:\n${out}`);
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.match(out, /Mix Assist — SIMULADOR · Bus 5/);
    assert.match(out, /Simulador X32 rodando em 127\.0\.0\.1:\d+/);

    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /<html/i);
  } finally {
    child.kill('SIGTERM');
  }
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.equal(await fs.readFile(cfg, 'utf8'), original, 'modo simulador não grava o config');
  await fs.rm(dir, { recursive: true, force: true });
});
