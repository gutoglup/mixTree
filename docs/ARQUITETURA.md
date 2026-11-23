# Arquitetura

Este documento descreve a estrutura interna do `mix-assist`. A fonte da verdade é o código em `mix-assist/src/`; as referências de arquivo e linha indicam onde cada comportamento está implementado.

## 1. Componentes

```mermaid
flowchart LR
  subgraph Mesa["Behringer X32 / M32 (UDP 10023)"]
    OSC[(Superfície OSC)]
  end

  subgraph Node["Processo Node.js (src/server.js → src/app.js)"]
    X32[X32Client<br/>src/x32.js]
    CODEC[Codec OSC<br/>src/osc.js]
    ENG[MixEngine<br/>src/engine.js]
    MAP[automap<br/>src/automap.js]
    HTTP[HTTP estático<br/>:3000]
    WS[WebSocketServer<br/>ws]
    SIM[Simulador<br/>src/simulator.js]
    CFG[(config.json)]
  end

  UI[public/index.html<br/>Mac / iPhone]

  OSC -- "/meters/1, /meters/2,<br/>/ch/NN/mix/BB/level, /info,<br/>/ch/NN/config/name|icon|color" --> X32
  X32 -- "/ch/NN/mix/BB/level (escrita)<br/>/xremote, /meters (assinatura)" --> OSC
  X32 <--> CODEC
  X32 -- eventos --> ENG
  ENG -- ações {ch, db} --> X32
  SIM -. "substitui a mesa (--sim)" .- X32
  CFG --> ENG
  X32 -- "patch (nome/ícone)" --> MAP
  MAP -- "sugestão / divergência" --> WS
  MAP -- "mapa confirmado" --> CFG
  CFG --> X32
  HTTP --> UI
  WS -- "estado a cada 150 ms" --> UI
  UI -- "comandos JSON" --> WS
  WS --> ENG
```

| Módulo | Responsabilidade | Efeitos colaterais |
|---|---|---|
| `src/osc.js` | Codificação/decodificação OSC 1.0 (`i`, `f`, `s`, `b`), lei de fader da X32, blobs de meters | Nenhum |
| `src/x32.js` | Cliente UDP; assinatura de `/xremote` e meters (renovada a cada 8 s); leitura de nomes, envios e estado `on`; descoberta de mesas por broadcast `/info` | Rede (UDP) |
| `src/engine.js` | Motor de regras puro: envelopes de nível, detecção de solista, cálculo de alvos, rampas, travas e histórico. O relógio é injetado via `now` | Nenhum |
| `src/automap.js` | Classificação de canais por nome e ícone, sugestão de mapa, confirmação (âncora, `seen`) e checagem de troca de patch | Nenhum |
| `src/configfile.js` | Substituição de uma chave de primeiro nível do `config.json` sensível a strings, preservando o resto do arquivo | Nenhum |
| `src/simulator.js` | Mesa falsa que responde OSC e gera meters de uma música sintética em seções de 20 s | Rede (UDP local) |
| `src/app.js` | Composição (`createApp`): liga cliente, motor, HTTP e WebSocket; troca de mesa e de bus em tempo de execução; persistência pontual em `config.json`. Sem efeitos ao importar: config, caminhos, logger, scanner e intervalos são injetados | Rede, sistema de arquivos |
| `src/server.js` | Ponto de entrada: lê o `config.json` (ou `MIX_ASSIST_CONFIG`), chama `createApp`, mostra os endereços e encerra limpo com SIGINT/SIGTERM | Processo |
| `public/index.html` | Interface sem framework (HTML, CSS e JS inline) | — |

## 2. Laços de execução

O servidor mantém quatro temporizadores independentes:

| Intervalo | Origem | Função |
|---|---|---|
| 250 ms | `app.js` | `engine.tick(now)`; as ações retornadas são enviadas à mesa |
| 150 ms | `app.js` | Difusão do estado (`engine.snapshot`) para todos os clientes WebSocket |
| 3 s | `app.js` | Releitura completa enquanto algum envio ainda não foi lido (perda de pacote UDP) |
| 8 s | `x32.js` | Renovação de `/xremote`, `/meters/1` e `/meters/2` |

```mermaid
sequenceDiagram
  autonumber
  participant M as X32
  participant C as X32Client
  participant E as MixEngine
  participant S as app.js
  participant U as Página

  C->>M: /info, /xremote, /meters/1, /meters/2
  C->>M: /ch/NN/config/name, /ch/NN/mix/BB/level, /ch/NN/mix/BB/on
  M-->>C: respostas e meters (contínuo)
  C-->>E: setName, onMixerSend, setSendOn, setChannelMeters, setBusMeter

  loop a cada 250 ms
    S->>E: tick(now)
    E-->>S: { actions, suggestions }
    S->>C: setSend(ch, db) para cada ação
    C->>M: /ch/NN/mix/BB/level <float>
  end

  loop a cada 150 ms
    S->>E: snapshot(now)
    S-->>U: { type: "state", ... }
  end

  U->>S: { type: "setSend", ch, db }
  S->>E: onUserSend(ch, db, now)
  E-->>S: ação (canal travado por manualHoldSec)
  S->>C: setSend(ch, db)
```

## 3. Modelo de sinal

Para cada canal, `setChannelMeters` (`src/engine.js:158`) mantém dois envelopes de potência a partir dos 32 primeiros valores de `/meters/1`:

- **lento** (`meterTauSec`, 1,2 s) → `envDb`;
- **rápido** (`fastTauSec`, 0,3 s) → `fastDb`.

Um canal é considerado **ativo** quando os dois envelopes estão acima de `gateDb`. Ele está **caindo** (fim de frase) quando `fastDb < envDb − fadeDb`; nessa condição nenhum envio é aumentado.

A **referência da âncora** (`keyRefPow`; o teclado, por padrão) é a média de potência dos canais `anchor` (mono ou estéreo), filtrada com `keyRefTauSec` (8 s) e atualizada apenas enquanto o teclado toca. O motor só age depois de `warmupSec` segundos de teclado ativo.

A contribuição de um canal no fone é estimada por:

```
contribuição(canal)  = envDb + envio
contribuição(teclado) = keyRefDb + média(envios do teclado)
```

## 4. Detecção de solista

Implementada em `_updateSoloist` (`src/engine.js:310`).

```mermaid
stateDiagram-v2
  [*] --> SemSolista
  SemSolista --> Solista: voz ativa mais forte
  Solista --> Desafio: outra voz lidera por ≥ soloLeadDb\n(ou a solista está calada)
  Desafio --> Solista: liderança perdida
  Desafio --> Solista: liderança mantida por soloHoldSec\n(troca de solista)
  Solista --> Silencio: solista inativa
  Silencio --> Solista: solista volta
  Silencio --> SemSolista: inativa por soloReleaseSec\n(escolhe a voz ativa mais forte, se houver)
```

## 5. Cálculo de alvos

Implementado em `_computeTargets` (`src/engine.js:357`) e `_vocalTarget` (`src/engine.js:427`).

```mermaid
flowchart TD
  A[Canal] --> B{role}
  B -- anchor --> K[Referência: nunca recebe alvo]
  B -- vocal / ref --> C{Envio lido?}
  C -- não --> W[aguardando leitura da mesa]
  C -- sim --> D{Travado por ajuste manual?}
  D -- sim --> H[sem alvo até holdUntil]
  D -- não --> E{Envio ligado?}
  E -- não --> OFF[envio desligado]
  E -- sim --> F{role}
  F -- vocal --> V{Solista?}
  V -- sim --> VS["alvo = (keyContrib + soloVsKeyDb) − envDb<br/>limitado a [vocalBackingDb, vocalSoloMaxDb]"]
  V -- "não, há solista" --> VB[alvo = vocalBackingDb]
  V -- "sem solista" --> VC{envio > vocalSoloMaxDb?}
  VC -- sim --> VT[alvo = vocalSoloMaxDb<br/>vale também em silêncio]
  VC -- não --> OK1[ok]
  F -- ref --> R{Motor pronto e canal ativo?}
  R -- não --> OK2[sem alteração]
  R -- sim --> RC{"envDb + envio > keyContrib + teto?"}
  RC -- não --> OK3[ok]
  RC -- sim --> RT["alvo = keyContrib + teto − envDb<br/>(corte, limitado a maxCeilingCutDb)"]
```

O **teto** de um instrumento (`ref`) é resolvido na construção do motor (`src/engine.js:61`), em ordem de precedência:

1. `ceilingDb` do canal em `config.channels`;
2. `engine.groupCeilingDb[grupo]`;
3. `engine.ceilingDb` (padrão −1 dB).

Todos os alvos são arredondados para 0,5 dB. Diferenças menores que `deadbandDb` não geram ação.

## 6. Modos e execução das ações

| Modo | Origem do objetivo | Escrita na mesa |
|---|---|---|
| `off` | — | Nenhuma; apenas sugestões |
| `assist` | `approved`, definido por `approve(ch)` ou `approveAll()` | Em rampa, até o valor aprovado |
| `auto` | `_autoGoal` (`src/engine.js:536`) | Em etapas, conforme o diagrama abaixo |

```mermaid
stateDiagram-v2
  [*] --> Ocioso
  Ocioso --> Confirmando: alvo e envelope rápido\nconcordam na direção (≥ limiar)
  Confirmando --> Ocioso: condição desaparece
  Confirmando --> Movendo: dwellSec (ou ceilingDwellSec\nquando é teto) decorrido
  Movendo --> Descanso: objetivo da etapa atingido
  Movendo --> Descanso: motivo some ou inverte\n(descanso de settleSec/2)
  Descanso --> Ocioso: settleUntil decorrido
  Ocioso --> Travado: ajuste manual
  Confirmando --> Travado: ajuste manual
  Movendo --> Travado: ajuste manual
  Descanso --> Travado: ajuste manual
  Travado --> Ocioso: manualHoldSec decorrido
```

Parâmetros de cada etapa:

| Situação | Tamanho máximo | Velocidade | Descanso |
|---|---|---|---|
| Padrão (vozes, subidas) | `maxMoveDb` (3 dB) | `maxRateDbPerSec` | `settleSec` (6 s) |
| Corte rápido (instrumento acima do teto, descendo) | `cutMaxMoveDb` (6 dB) | `cutRateDbPerSec` (2 dB/s) | `cutSettleSec` (2 s) |

A velocidade é multiplicada por um fator de desaceleração `clamp(|diferença| / 1,5, 0,3, 1)`, o que evita degraus no início e no fim do movimento.

O limiar mínimo para iniciar uma etapa é:

- 0,1 dB para voz acima do teto absoluto (`hardCap`);
- `deadbandDb` para alvo fixo (backing) ou teto de instrumento;
- `autoStartDb` nos demais casos.

## 7. Detecção de ajuste manual

`onMixerSend` (`src/engine.js:180`) recebe toda alteração de envio ecoada pela mesa via `/xremote`. Uma mudança é tratada como manual quando:

- difere do último valor conhecido em pelo menos 0,4 dB; e
- não corresponde (tolerância de 0,4 dB, após quantização do fader) a nenhum comando emitido pelo próprio motor nos últimos 3 s.

Nesse caso o canal é travado por `manualHoldSec`, o novo valor passa a ser a mix base daquele canal e qualquer etapa em andamento é cancelada. Ajustes feitos pela página (`onUserSend`) seguem a mesma regra.

## 8. Travas de segurança na escrita

A escrita é restrita em duas camadas independentes:

1. **Motor** (`src/engine.js`): canais `anchor` (ou `keyboard`, normalizado para `anchor`) nunca recebem alvo, não são aprovados e não entram em `restoreBase`. A âncora só muda por `adjustKeyboard`, chamado exclusivamente pela mensagem `anchor` (ou `keyboard`) da página. Com `setBlock(motivo)` ativo, o modo fica em `off` e `setMode` recusa `assist`/`auto`.
2. **Cliente** (`src/x32.js`): `setSend` descarta qualquer canal fora do mapa atual e qualquer canal âncora. A âncora tem um método separado, `setKeyboardSend`. `setChannels` troca o mapa em execução e recalcula as duas listas.

O único endereço escrito em ambos os casos é `/ch/NN/mix/BB/level`, onde `BB` é o bus configurado.

## 9. Troca de mesa e de bus em execução

| Operação | Função | Efeito no motor | Persistência |
|---|---|---|---|
| Trocar IP ou ir para o simulador | `connectTo` (`src/app.js:161`) | `resetMixer()`: zera envios, envelopes, solista e referência do teclado; modo volta a `off` | IP e porta gravados em `config.json` (apenas mesa real) |
| Trocar bus do fone | `setBus` (`src/app.js:204`) | `resetBus()`: zera envios e travas; modo volta a `off`; a referência do teclado é mantida | `bus` gravado em `config.json` (apenas mesa real) |
| Procurar mesas | `scanMixers` (`src/x32.js:144`) | — | — |

A gravação em `config.json` substitui apenas o trecho alterado (por expressão regular para `mixer` e `bus`; por `replaceTopLevel` de `src/configfile.js` para `channels`), preservando a formatação do restante do arquivo.

## 9.1 Mapa de canais dinâmico

```mermaid
sequenceDiagram
  participant U as Página
  participant S as app.js
  participant X as X32Client
  participant M as Mesa
  participant A as automap.js
  X->>M: /ch/01..32/config/name, icon, color, mix/BB/on (scanChannels)
  M-->>X: respostas (e, via /xremote, toda alteração de nome/ícone)
  X-->>S: eventos name / icon / color / sendOn → patch[1..32]
  S->>A: diffMap(config.channels, patch)
  A-->>S: divergências → engine.setBlock(...) + patchDiffs no estado
  U->>S: proposeMap
  S->>A: buildProposal(patch, { previous, rules, icons, busName })
  S-->>U: proposal { rows[32], anchorGroup, busGroup }
  U->>S: applyMap { anchorGroup, rows }
  S->>A: finalizeMap(rows, anchorGroup, { patch, previous })
  A-->>S: channels (com seen) ou erros
  S->>S: novo MixEngine (modo off), x32.setChannels, grava config (mesa real)
  S-->>U: mapResult { ok, error }
```

Classificação (`classifyChannel`): o nome é normalizado (sem acentos, maiúsculas) e testado contra as regras em ordem — a primeira que casa vence; `role: "ignore"` deixa o canal de fora. Só se nenhuma regra casar é que o ícone é consultado. O nome vem antes porque é texto explícito do operador e porque a numeração dos ícones precisa ser conferida por firmware.

Sugestão (`buildProposal`): para cada canal 1–32, se ele já está no mapa e o nome não mudou (comparado com `seen.name` ou `name`), mantém papel e grupo anteriores (`source: "config"`); senão, classifica. A âncora sugerida é o grupo da âncora atual ou, sem mapa anterior, o grupo inferido do nome do bus do fone.

Confirmação (`finalizeMap`): canais `ref` do grupo escolhido viram `anchor`; vozes nunca viram âncora. Cada canal guarda `seen: { name, icon }`. `ceilingDb` por canal é preservado se o grupo não mudou. Sem nenhum canal do grupo âncora, o mapa é recusado.

Troca de patch (`diffMap`): só canais com `seen` são verificados, e só campos já lidos da mesa contam, para que um pacote ainda não recebido não gere alarme falso. Ao trocar de mesa, o patch lido é zerado e o bloqueio, removido.

## 10. Protocolo WebSocket

### Servidor → página

Uma mensagem `state` a cada 150 ms:

| Campo | Descrição |
|---|---|
| `connected`, `simulated`, `switching`, `connError` | Estado da conexão com a mesa |
| `mixer`, `realMixer` | Destino atual (com `name`, `model`, `fw` de `/info`) e mesa real configurada |
| `scan` | `{ running, found[], at }` da descoberta de mesas |
| `bus`, `busNames`, `busFaderDb`, `busDb` | Bus do fone, nomes dos 16 buses, fader e meter do bus |
| `mode`, `block`, `anchorName`, `ready`, `soloist`, `keyContrib`, `keyRefDb` | Estado do motor (`block`: motivo do bloqueio ou `null`; `anchorName`: grupo da âncora) |
| `patchDiffs[]` | `{ ch, reasons, expected, actual }` para canais cujo nome/ícone na mesa não bate com o mapa confirmado |
| `channels[]` | Por canal: `ch`, `name`, `role`, `group`, `ceilingDb`, `sendDb`, `baseDb`, `on`, `envDb`, `contribDb`, `targetContribDb`, `active`, `solo`, `target`, `approved`, `held`, `holdLeftSec`, `reason` |
| `suggestions[]` | `{ ch, name, from, to, reason }`; inclui alerta de bus próximo de clipar |
| `history[]` | Últimas 60 alterações, mais recentes primeiro |

### Página → servidor

| `type` | Campos | Efeito |
|---|---|---|
| `mode` | `mode`: `off` \| `assist` \| `auto` | Altera o modo |
| `approve` | `ch` | Aprova a sugestão do canal (modo assistido) |
| `approveAll` | — | Aprova todas as sugestões |
| `saveBase` | — | Grava os envios atuais como mix base |
| `restoreBase` | — | Restaura a mix base e trava os canais alterados |
| `setSend` | `ch`, `db` (−90 a +10) | Ajuste manual de um envio (exceto âncora) |
| `anchor` (ou `keyboard`) | `delta` (−6 a +6 dB) | Ajuste manual da âncora; L e R juntos |
| `scanChannels` | — | Relê nome, ícone, cor e envio ligado dos 32 canais |
| `proposeMap` | — | Responde só a quem pediu com `{ type: "proposal", rows[32], anchorGroup, busName, busGroup }` |
| `applyMap` | `anchorGroup`, `rows[] { ch, role, group }` | Aplica o mapa confirmado; responde `{ type: "mapResult", ok, error }` |
| `refresh` | — | Relê envios, nomes e nomes de bus |
| `busNames` | — | Relê os nomes dos buses |
| `connect` | `source: "sim"` ou `host`, `port` | Troca a mesa em execução |
| `scan` | — | Procura mesas na rede por broadcast |
| `setBus` | `bus` (1–16) | Troca o bus do fone |

## 11. Lei de fader

Conversão implementada em `src/osc.js:97`. O valor float é quantizado em 1024 passos.

| Faixa (dB) | float → dB |
|---|---|
| ≥ −10 | `f · 40 − 30` |
| −30 a −10 | `f · 80 − 50` |
| −60 a −30 | `f · 160 − 70` |
| −90 a −60 | `f · 480 − 90` |
| `f ≤ 0` | −90 (−∞) |
