# Projeto: Mix Assist — assistente inteligente de mix de fone para Behringer X32

Crie do zero um projeto chamado `mix-assist` que roda no **Mac**: uma ponte em **Node.js (ESM, Node 20+)** que conversa com uma mesa **Behringer X32** via **OSC/UDP** e serve uma **página web** (abre no Mac e no iPhone pela rede). A única dependência externa permitida é `ws`. Sem framework no front: um único `public/index.html` com CSS e JS inline.

## Contexto

- Eu sou tecladista e uso um fone alimentado pelo **Mix Bus 5** da X32 (IP `192.168.1.104`, porta `10023`). Hoje controlo pelo app Mixing Station, que continua rodando em paralelo.
- Objetivo: uma leitura inteligente da mix do fone, que deixe tudo mais organizado e fluido, com:
  1. **Detecção automática de quem está solando** entre as vozes.
  2. **Vocais alinhados**: solista no nível do teclado, backings um pouco abaixo da solista.
  3. **Nada passa o volume do teclado** no fone. Quando algo passa, o app **abaixa o envio desse canal** (nunca sobe o teclado).
- **Regras de segurança, inegociáveis:**
  - O app só escreve em `/ch/NN/mix/05/level` (envios para o Bus 5). Nunca mexe no PA, em faders de canal, em outros buses ou no teclado.
  - O canal de teclado **nunca** é alterado pelo motor.
  - Se alguém mexer num envio (pela mesa, pelo Mixing Station ou pela página), o motor **trava aquele canal** por um tempo e adota o novo valor como base.

## Estrutura

```
mix-assist/
  package.json        scripts: start, sim (--sim), test ("node --test test/*.test.js")
  config.json
  README.md           em português
  src/osc.js          codec OSC + lei de fader + meters
  src/x32.js          cliente UDP da X32 (EventEmitter)
  src/engine.js       motor de regras PURO (sem rede, relógio injetado via `now`)
  src/simulator.js    X32 falsa para testar em casa
  src/server.js       liga tudo, HTTP estático + WebSocket
  public/index.html   interface
  test/engine.test.js testes com node:test
```

## config.json

```json
{
  "mixer": { "host": "192.168.1.104", "port": 10023 },
  "bus": 5,
  "web": { "port": 3000 },
  "channels": [
    { "ch": 9,  "role": "keyboard", "name": "Teclado" },
    { "ch": 1,  "role": "vocal",    "name": "Voz 1" },
    { "ch": 2,  "role": "vocal",    "name": "Voz 2" },
    { "ch": 3,  "role": "vocal",    "name": "Voz 3" },
    { "ch": 4,  "role": "vocal",    "name": "Voz 4" },
    { "ch": 17, "role": "ref",      "name": "Bumbo" },
    { "ch": 18, "role": "ref",      "name": "Caixa" },
    { "ch": 21, "role": "ref",      "name": "Baixo" },
    { "ch": 23, "role": "ref",      "name": "Guitarra" }
  ],
  "engine": { "soloVsKeyDb": 0, "backingGapDb": 5, "ceilingDb": -1, "maxRateDbPerSec": 1, "manualHoldSec": 20 }
}
```

Roles: `keyboard` (exatamente um), `vocal` (o motor escolhe a solista), `ref` (outros instrumentos).

## src/osc.js — detalhes do protocolo

- OSC 1.0 com tipos `i`, `f`, `s`, `b`, big-endian, strings terminadas em null e alinhadas a 4 bytes. Funções `encode(address, args)` e `decode(buf)`. Um arg `{type:"i", value}` vira int; número vira float; Buffer vira blob.
- **Lei de fader da X32** (float 0..1 ↔ dB), `faderToDb` / `dbToFader`:
  - f ≥ 0.5 → dB = f·40 − 30
  - f ≥ 0.25 → dB = f·80 − 50
  - f ≥ 0.0625 → dB = f·160 − 70
  - senão → dB = f·480 − 90 (f = 0 → −90)
  - A inversa arredonda para 1024 passos (`round(f*1023)/1023`). 0 dB ≈ 0.75.
- **Blob de meters**: int32 **little-endian** com a quantidade, seguido de floats **little-endian** lineares. Funções `decodeMeterBlob` e `encodeMeterBlob`. Use `linToDb(v) = 20·log10(v)` (−120 se ~0) e `pad2(n)`.

## src/x32.js — cliente

- Socket `dgram` udp4 com bind em porta efêmera. Mandar para host:10023.
- No start, enviar `/info`, assinar e ler o estado inicial. A cada **8 s**, renovar:
  - `/xremote` (a mesa empurra mudanças feitas por qualquer cliente);
  - `/meters` com arg string `"/meters/1"` (canais) e `"/meters/2"` (buses).
- Leitura inicial (`refreshAll`): para cada canal do config, mandar sem argumentos `/ch/NN/config/name`, `/ch/NN/mix/05/level` e `/ch/NN/mix/05/on`, além de `/bus/05/mix/fader`.
- Eventos emitidos: `name {ch,name}`, `send {ch,db}`, `sendOn {ch,on}`, `channelMeters (array 32 floats lineares)`, `busMeter (float do bus 5)`, `busFader (dB)`, `error`.
- `connected` = recebeu algo nos últimos 5 s. Método `setSend(ch, db)` envia o float convertido pela lei de fader.
- Ignore mensagens de outros buses.

## src/engine.js — motor de regras (o coração do projeto)

Classe `MixEngine(map, opts)`, **sem I/O**, com todo método recebendo `now` (ms) para ser testável. Defaults:

| chave | valor | significado |
|---|---|---|
| gateDb | −45 | abaixo disso o canal está em silêncio |
| meterTauSec | 1.2 | suavização RMS dos meters (média exponencial de potência) |
| keyRefTauSec | 8 | referência lenta do nível do teclado, atualizada só enquanto ele toca |
| warmupSec | 4 | o teclado precisa tocar X s antes de o motor agir |
| soloLeadDb | 3 | quanto uma voz precisa liderar para tomar a vez da solista |
| soloHoldSec | 1.5 | tempo liderando para trocar (histerese) |
| soloReleaseSec | 4 | a solista some por X s → libera |
| soloVsKeyDb | 0 | solista em relação ao teclado |
| backingGapDb | 5 | backings abaixo da solista |
| ceilingDb | −1 | refs: teto em relação ao teclado |
| maxBoostDb | 6 | quanto pode subir em relação à mix base |
| maxCutDb | 10 | quanto pode cortar ao alinhar vozes |
| maxCeilingCutDb | 20 | quanto pode cortar para algo não passar o teclado |
| maxRateDbPerSec | 1 | rampa máxima |
| deadbandDb | 0.75 | diferença mínima para mexer |
| manualHoldSec | 20 | trava após ajuste manual |
| busClipDb | −3 | alerta de bus perto de clipar |

Estado por canal: `sendDb`, `on`, `baseDb` (mix base), `pow`/`envDb` (nível de entrada suavizado), `target`, `approved`, `lastCommanded`, `holdUntil`, `reason`.

**Conceito-chave:** a contribuição de cada canal no fone é **envDb (meter de entrada) + sendDb (envio do bus)**. A contribuição do teclado é `keyRefDb + sendDb do teclado`.

Entradas:
- `onMixerSend(ch, db, now)`: a primeira leitura vira `baseDb`. Se o valor mudou ≥ 0.4 dB e **não** foi o motor que mandou (compare com `lastCommanded`, tolerância 0.4), é uma mudança manual: trava (`holdUntil`), vira base, limpa `approved` e registra no histórico com a origem `manual`.
- `onUserSend(ch, db, now)`: ajuste pela página, com o mesmo efeito de trava e origem `web`. Retorna a ação `{ch, db}`.
- `setChannelMeters(lin[32], now)`, `setBusMeter(lin)`, `setName`, `setSendOn`.
- `setMode('off'|'assist'|'auto')`, `approve(ch)`, `approveAll()`, `saveBase()` e `restoreBase(now)` (retorna as ações para voltar à base).

Lógica do `tick(now)` (chamado ~4×/s), que retorna `{actions, suggestions}`:
1. **Solista:** entre as vozes ativas, a de maior `envDb` (energia de entrada, não envio). Sem solista, a mais forte assume. Para trocar, a candidata precisa superar a atual em `soloLeadDb` (ou a atual estar em silêncio) por `soloHoldSec`. Se a solista sumir por `soloReleaseSec`, libera.
2. Só age quando o motor está "pronto": `keyRefDb` existe e o teclado já tocou `warmupSec`.
3. Para cada canal que não esteja travado, em silêncio ou seja o teclado, calcula a contribuição-alvo:
   - solista → teclado + soloVsKeyDb;
   - outras vozes → alvo da solista − backingGapDb;
   - refs → só se a contribuição atual passar de teclado + ceilingDb; aí o alvo é esse teto.
4. Envio desejado = contribuição-alvo − envDb. Limite entre `base − (maxCeilingCutDb se for teto, senão maxCutDb)` e `min(10, base + maxBoostDb)`. Arredonda para 0.5 dB e ignora se a diferença ficar abaixo do deadband. Se o desejado passar do limite de subida em > 1 dB, acrescenta na razão: "(no limite de subida; faltam X dB — peça mais ganho na mesa)".
5. Toda meta vira `suggestion {ch, name, from, to, reason}`. Se o bus passar de busClipDb, adiciona uma sugestão de "abaixe o volume geral do fone".
6. Aplicação: em `auto`, persegue `target`; em `assist`, persegue só `approved`; em `off`, nada. Cada passo ≤ maxRateDbPerSec × dt.
7. **Histórico** (máx. 200): `{t, ch, name, from, to, source: engine|manual|web, reason}`. Passos da mesma rampa (mesmo canal, origem engine, < 3 s) **se fundem num item só**: use `findLast` do canal, não só o último item global.
8. `snapshot()` devolve o modo, a solista, keyContrib, busDb, os canais (com contribDb, active, target, approved, held, reason) e as 60 entradas mais recentes do histórico.

## src/simulator.js

`startSimulator({port, bus, channels})` cria uma X32 falsa em 127.0.0.1:10023:
- Responde `/info`, nomes, leitura e escrita de envios do bus, `on` (int 1) e o fader do bus. Repassa escritas para os outros assinantes de `/xremote`.
- Começa com uma mix **bagunçada** (ex.: Voz 1 +3, Voz 2 −6, Bumbo +2, Baixo +4, Guitarra +5).
- A cada 50 ms envia `/meters/1` (32 canais + zeros) e `/meters/2` (bus = soma de potência com ganhos) para quem assinou nos últimos 10 s.
- "Música" em seções de 20 s: teclado sempre ligado; a solista alterna entre Voz 1 (forte) e Voz 2 (fraca); os backings (Voz 3 e 4) entram nas seções 3 e 4; há respiros entre frases; a guitarra fica forte na segunda metade de cada seção.

## src/server.js

- Lê o `config.json`. Com `--sim`, sobe o simulador e aponta o host para 127.0.0.1.
- Liga os eventos do X32 ao motor, chama `tick` a cada 250 ms e aplica as ações com `x32.setSend`.
- HTTP estático de `public/` (proteja contra path traversal) e WebSocket no mesmo servidor, em `0.0.0.0:3000`.
- Mensagens do cliente: `mode`, `approve`, `approveAll`, `saveBase`, `restoreBase`, `setSend {ch, db}` (com clamp entre −90 e 10) e `refresh`.
- A cada 150 ms, faz broadcast de `{type:"state", connected, simulated, mixer, bus, ...snapshot, suggestions}`.
- No start, imprime as URLs (localhost e IPs da rede) para abrir no iPhone.

## public/index.html — interface

Tema escuro, mobile-first, em português. Cores: teclado amarelo, voz azul, solista rosa, refs cinza.
- **Header fixo:** título, bolinha de conexão (verde/vermelha), "X32 ip · Bus 5", badge "SIMULADOR" e um seletor segmentado Desligado / Assistido / Automático.
- **Cartão de resumo:** "Solista agora", "Teclado no fone (dB)", "Bus do fone (dBFS)" com barra colorida (verde/laranja/vermelho).
- **Uma linha por canal** (ordem: teclado, vozes, refs):
  - nome, chip do papel e "ch N";
  - medidor horizontal da **contribuição relativa ao teclado** (escala −30 a +10 dB), com uma linha amarela na posição do teclado e um marcador branco no alvo;
  - texto da razão; em modo Assistido, um botão "aplicar";
  - controles − / valor do envio (e "base X" embaixo) / +;
  - "🔒 travado" quando o canal está em hold.
- **Sugestões:** lista com os botões "Aplicar todas" (só no Assistido), "Salvar como mix base" e "Voltar à mix base".
- **Histórico:** horário, canal, de → para e a origem (motor / mesa / você).
- Reconexão automática do WebSocket.
- Cuidados:
  - formatar números sem "−0.0";
  - **não reescrever o innerHTML do texto de razão se ele não mudou**, senão o botão "aplicar" some antes do toque;
  - só reconstruir as linhas quando a lista de canais ou a solista mudar.
- No celular (< 520 px), o medidor vai para uma linha própria. No desktop, o histórico fica numa coluna lateral.

## Testes (test/engine.test.js, node:test)

Helper que roda o motor por N segundos com meters fixos (passo de 50 ms, tick a cada 250 ms). Casos obrigatórios:
1. Lei de fader ida e volta (−60…+10 com erro < 0.2 dB) e `dbToFader(0) ≈ 0.75`.
2. Encode/decode OSC e blob de meters.
3. Solista com histerese: não troca em 1 s; troca depois de sustentar a liderança.
4. Em `auto`, a solista fica alinhada ao teclado (±1.5 dB) e a backing 5 dB abaixo (±1.5).
5. Guitarra forte (envio +5, entrada −12 dB, teclado em −20) termina abaixo do teclado.
6. Rampa: em 2 s, o envio não desce mais que ~2.5 dB.
7. O teclado nunca é alterado.
8. Uma mudança manual pela mesa trava o canal (o valor fica intacto).
9. Em `assist`, só aplica após `approve`; antes disso, aparece em suggestions.
10. Um canal em silêncio não tem o envio alterado.

## Critérios de pronto

- `npm install && npm test` passa nos 10 testes.
- `npm run sim` sobe; em ~30 s no modo Automático, o simulador mostra: a solista detectada, a guitarra/baixo/bateria cortados para baixo do teclado e o histórico com um item por ajuste.
- `npm start` usa a mesa real do config.
- Um README em português com: como rodar, a tabela de parâmetros do `engine`, os modos, um diagrama da arquitetura e os limites conhecidos:
  - os meters dão nível, não espectro;
  - o envio do Bus 5 deve estar em **pre-fader** para a estimativa ficar precisa;
  - confirmar os índices de `/meters/1` e `/meters/2` no primeiro uso com a mesa real.

Trabalhe em etapas: osc + testes de osc → engine + testes → simulator → server → interface → README. Rode os testes a cada etapa e, no fim, rode o simulador e confira o estado pelo WebSocket.
