// Ponto de entrada: lê o config.json, sobe o app (ver app.js) e mostra os endereços.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = process.env.MIX_ASSIST_CONFIG || path.join(ROOT, 'config.json');
const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
const simulated = process.argv.includes('--sim');

const app = await createApp({ config, configPath: CONFIG_PATH, publicDir: path.join(ROOT, 'public'), simulated });

const port = Number(process.env.PORT) || (config.web?.port ?? 3000);
await app.listen(port, '0.0.0.0');
console.log(`\nMix Assist — ${simulated ? 'SIMULADOR' : `X32 ${config.mixer.host}:${config.mixer.port}`} · Bus ${config.bus}`);
console.log(`  Local:   http://localhost:${port}`);
for (const list of Object.values(os.networkInterfaces())) {
  for (const i of list || []) {
    if (i.family === 'IPv4' && !i.internal) console.log(`  Rede:    http://${i.address}:${port}   (abra no iPhone)`);
  }
}
console.log('');

// Ctrl+C / kill: fecha sockets e timers antes de sair.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, async () => {
    await app.close();
    process.exit(0);
  });
}
