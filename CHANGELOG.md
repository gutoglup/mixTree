# Changelog

Todas as alterações relevantes deste projeto são registradas neste arquivo.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto adota [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Não publicado]

### Adicionado

- Mapa de canais dinâmico ([#1](https://github.com/gutoglup/mixTree/issues/1)):
  - leitura do patch da mesa inteira (canais 1–32): `/ch/NN/config/name`, `/config/icon`, `/config/color` e envio ligado para o bus do fone (`X32Client.scanChannels`), ao conectar, ao trocar de bus, a cada 20 s e pela página;
  - classificador puro (`src/automap.js`) que sugere papel e grupo de cada canal pelo nome (regras configuráveis em `config.json → autoMap.rules`) e, quando o nome não diz nada, pelo ícone da X32 (`autoMap.icons`);
  - folha **Canais** na interface para revisar a sugestão, escolher de quem é o fone e confirmar; o mapa só vale após confirmação e é gravado em `config.json` (apenas com mesa real);
  - checagem de troca de patch: cada canal confirmado guarda o nome e o ícone vistos (`seen`); se mudarem na mesa, o assistente é desligado e bloqueado (`MixEngine.setBlock`) até o mapa ser revisado;
  - simulador com os 32 canais, ícones por instrumento e troca de nome/ícone por OSC (`/ch/NN/config/name` com argumento), como na mesa real.
- Edição do `config.json` por chave de primeiro nível, sensível a strings, preservando a formatação do restante do arquivo (`src/configfile.js`).
- Testes: classificador, sugestão, confirmação e checagem de patch (`test/automap.test.js`), edição do config (`test/configfile.test.js`), âncora genérica e bloqueio no motor, e integração UDP cliente ↔ simulador (`test/x32-sim.test.js`). Total: 91 casos.

### Alterado

- O papel `keyboard` passa a se chamar `anchor` (âncora): o instrumento do dono do fone, que o motor nunca altera e que serve de referência para os tetos. `keyboard` continua aceito como sinônimo, com grupo `teclado`. Textos da interface e motivos do motor usam o nome do grupo da âncora (ex.: "acima do limite (−8 dB do guitarra)").
- O snapshot do motor expõe `role: "anchor"`, `anchorName` e `block`; a mensagem WebSocket `anchor` substitui `keyboard` (que segue aceita).

### Documentação

- README na raiz do repositório com estrutura, execução, configuração e parâmetros do motor.
- `docs/ARQUITETURA.md` com diagramas de componentes, sequência, máquinas de estado (solista e modo automático), fluxo de cálculo de alvos e protocolo WebSocket.
- Correção do `mix-assist/README.md`: regra do teclado alinhada ao código (ajuste manual pela página permitido), número de testes e item duplicado de configuração.

## [1.0.0] - 2026-11-20

Primeira versão do `mix-assist`.

### Adicionado

- Codec OSC 1.0 (`i`, `f`, `s`, `b`), lei de fader da X32 com quantização em 1024 passos e decodificação de blobs de meters (`src/osc.js`).
- Cliente UDP da X32/M32 com assinatura de `/xremote` e meters, leitura de nomes, envios e estado `on`, e descoberta de mesas por broadcast `/info` (`src/x32.js`).
- Motor de regras puro com relógio injetado (`src/engine.js`):
  - envelopes lento e rápido por canal, gate e detecção de fim de frase;
  - referência do teclado mono ou estéreo (média de potência L/R) com aquecimento;
  - detecção de solista com histerese (`soloLeadDb`, `soloHoldSec`, `soloReleaseSec`);
  - vozes como referência: backings em `vocalBackingDb` e solista entre `vocalBackingDb` e `vocalSoloMaxDb`, com teto absoluto aplicado também em silêncio;
  - teto de instrumento relativo ao teclado, resolvido por canal, por grupo (`groupCeilingDb`) ou pelo padrão (`ceilingDb`);
  - modos Desligado, Assistido e Automático;
  - modo automático em etapas, com confirmação (`dwellSec`, `ceilingDwellSec`), tamanho máximo (`maxMoveDb`), rampa com desaceleração e descanso (`settleSec`);
  - corte rápido para instrumentos acima do teto (`cutMaxMoveDb`, `cutRateDbPerSec`, `cutSettleSec`);
  - trava de canal após ajuste manual e adoção do novo valor como mix base;
  - salvar e restaurar mix base;
  - histórico de alterações com fusão de etapas consecutivas;
  - alerta de bus próximo de clipar.
- Ajuste manual do teclado pela página, movendo L e R juntos; o motor continua sem alterar o teclado.
- Simulador de X32 com música sintética, alternância de solistas e mix inicial desbalanceada (`src/simulator.js`).
- Servidor HTTP estático e WebSocket com difusão de estado a cada 150 ms e laço do motor a cada 250 ms (`src/server.js`).
- Troca de mesa (IP, porta ou simulador) e de bus do fone em execução, com persistência pontual em `config.json`.
- Interface web única sem framework, com cards por canal, cores por grupo, linhas de referência do teclado e do teto, sugestões, histórico e seletor de mesa/bus (`public/index.html`).
- Mapa de canais da M32 da igreja, com teclado estéreo nos canais 15/16, vozes nos canais 20–28 e tetos por grupo.
- Suíte de 22 testes com `node:test`.

### Alterado em relação à especificação original

- Bus do fone: de 5 para 2.
- Teclado: de um canal mono (ch 9) para par estéreo (ch 15 e 16).
- Vozes: de "solista no nível do teclado, backings `backingGapDb` abaixo" para envio absoluto (backings em −10 dB, solista no máximo em −8 dB).
- Instrumentos: de teto único (`ceilingDb`) para teto por grupo e por canal.
- Teclado: passa a admitir ajuste manual explícito pela página; o motor permanece sem alterá-lo.

[Não publicado]: https://github.com/gutoglup/mixTree/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/gutoglup/mixTree/releases/tag/v1.0.0
