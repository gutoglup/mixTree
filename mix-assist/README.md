# Mix Assist

Assistente inteligente de **mix de fone** para a Behringer **X32** do tecladista. Uma ponte em Node.js conversa com a mesa via OSC/UDP e serve uma página web que abre no Mac e no iPhone pela rede.

O app faz três coisas:

1. **Detecta quem está solando** entre as vozes.
2. **Vozes só como referência:** nenhum microfone de voz passa de **−8 dB** de envio no fone. Os backings ficam por volta de **−10 dB**; a solista acompanha o teclado entre −10 e −8 dB. Voz acima de −8 dB é baixada até em silêncio.
3. **Cada instrumento tem um limite em relação ao teclado** (o teto do seu grupo). Quando passa, o app abaixa o envio desse canal; nunca sobe instrumentos nem mexe no teclado sozinho.

   O teclado aparece como card **KEYS** na banda. Tocando nele, dá para baixar ou subir o teclado à mão (L e R juntos, mantendo o estéreo). Como os limites são relativos ao teclado, baixar o teclado baixa junto o teto de todos os instrumentos; as vozes, que são em dB de envio, ficam onde estão.

   Mix de partida para o tecladista (dB em relação ao teclado):

   | Grupo | Teto | Por quê |
   |---|---|---|
   | Bumbo (BB) | −4 | pulso principal |
   | Caixa | −5 | tempo forte (2 e 4) |
   | Resto da bateria (chimbal, toms, SD) | −10 | subdivisão e viradas; são os canais mais agressivos no fone |
   | Baixo | −3 | nota do baixo e harmonia: evita a mão esquerda brigar com ele |
   | Violão, guitarra, sax | −8 | mesma região de médios do teclado; altos demais mascaram os acordes |

   No card, a linha **amarela** é o teclado e a **pontilhada vermelha** é o limite daquele instrumento.

O Mixing Station continua rodando em paralelo. O modo "Personal Monitoring" dele não afeta o Mix Assist.

## Regras de segurança

- O app **só escreve** em `/ch/NN/mix/02/level`, que são os envios dos canais para o Bus 2. Ele não toca no PA, nos faders de canal, em outros buses nem no teclado.
- O canal de teclado **nunca** é alterado, nem pelo motor nem pela página.
- Se alguém mexer num envio (na mesa, no Mixing Station ou na página), o motor **trava aquele canal** por `manualHoldSec` segundos e adota o novo valor como base.

## Como rodar

Precisa do Node 20 ou mais novo.

```bash
npm install
npm test          # 11 testes do motor e do OSC
npm run sim       # X32 falsa em 127.0.0.1, para testar em casa
npm start         # mesa real (IP e Bus do config.json)
```

Ao subir, o terminal mostra as URLs. Abra a de **Rede** (`http://192.168.x.x:3000`) no iPhone, conectado ao mesmo Wi-Fi da mesa.

## Modos

| Modo | O que faz |
|---|---|
| **Desligado** | Só observa e mostra sugestões. Nada é escrito na mesa. |
| **Assistido** | Mostra sugestões e só aplica as que você aprova ("aplicar" ou "Aplicar todas"). |
| **Automático** | Aplica as metas sozinho, em rampa (no máximo `maxRateDbPerSec` dB/s). |

Botões extras:
- **Salvar como mix base:** grava os envios atuais como referência dos limites.
- **Voltar à mix base:** restaura os envios salvos e trava os canais por `manualHoldSec`.

## Configuração (`config.json`)

- `mixer.host` e `mixer.port`: IP da X32 e porta 10023.
- `bus`: bus do fone (2).
- `mixer.host` / `mixer.port`: IP e porta da mesa.

Mesa, simulador e bus também podem ser trocados pela página, sem reiniciar: toque no indicador "Bus N" no topo. Lá dá para digitar o IP, **procurar mesas na rede** (o app pergunta em broadcast quem é X32/M32), alternar para o **simulador** e escolher o bus. Cada troca desliga o assistente e lê tudo de novo; o IP e o bus da mesa real ficam salvos aqui (o simulador não grava nada).

### Suavidade do modo automático (`engine`)

O automático corrige em **etapas**, não continuamente:

- `dwellSec` (2,5): a diferença precisa durar isso — e o nível do momento confirmar — antes de começar uma etapa. Picos curtos não disparam nada.
- `maxMoveDb` (3): tamanho máximo de cada etapa. Correções maiores viram várias etapas.
- `maxRateDbPerSec` (0,6): velocidade, desacelerando no fim do movimento.
- `settleSec` (6): descanso depois de cada etapa antes da próxima.
- `ceilingDwellSec` (1): canal que passou do teclado é confirmado mais rápido.
- **Corte rápido** — só para instrumento acima do teclado, e só descendo: `cutMaxMoveDb` (6) por etapa, a `cutRateDbPerSec` (2) dB/s, com `cutSettleSec` (2) de descanso. Vozes e subidas seguem as regras suaves acima.

- `channels`: lista com `ch`, `role`, `name` e, opcional, `group` (bateria, guitarra, baixo...) — o grupo define a cor do card.
  O `role` pode ser `keyboard` (exatamente um canal), `vocal` (o motor escolhe a solista entre esses) ou `ref` (outros instrumentos, que só são cortados se passarem do seu teto). Um `ref` pode ter `ceilingDb` próprio, que vence o do grupo.
- `engine`: sobrescreve qualquer parâmetro da tabela abaixo.

### Parâmetros do motor

| chave | padrão | significado |
|---|---|---|
| gateDb | −45 | abaixo disso o canal está em silêncio |
| meterTauSec | 1.2 | suavização RMS dos meters |
| fastTauSec | 0.3 | envelope rápido, usado para detectar fim de frase |
| fadeDb | 6 | se o envelope rápido cair X dB abaixo do lento, o canal não é subido |
| keyRefTauSec | 8 | referência lenta do teclado, atualizada só enquanto ele toca |
| warmupSec | 4 | quanto tempo o teclado precisa tocar antes de o motor agir |
| soloLeadDb | 3 | quanto uma voz precisa liderar para virar solista |
| soloHoldSec | 1.5 | tempo liderando para trocar de solista |
| soloReleaseSec | 4 | depois de X s de silêncio, a solista é liberada |
| vocalBackingDb | -10 | envio (dB) dos backings no fone |
| vocalSoloMaxDb | -8 | envio máximo da solista — e teto de qualquer voz |
| soloVsKeyDb | 0 | onde a solista tenta ficar em relação ao teclado (dentro da faixa acima) |
| ceilingDb | −1 | teto padrão dos refs em relação ao teclado (quando nem o canal nem o grupo definem) |
| groupCeilingDb | `{ bateria: −10, baixo: −3, ... }` | teto por grupo, em dB em relação ao teclado |
| maxBoostDb | 6 | quanto o envio pode subir acima da base |
| maxCutDb | 10 | quanto pode cortar ao alinhar as vozes |
| maxCeilingCutDb | 30 | quanto pode cortar para algo não passar do teclado |
| maxRateDbPerSec | 1 | velocidade máxima da rampa |
| deadbandDb | 0.75 | diferença mínima para o motor mexer |
| manualHoldSec | 20 | duração da trava depois de um ajuste manual |
| busClipDb | −3 | alerta de bus perto de clipar |

## Como o motor pensa

A contribuição de cada canal no fone é **nível de entrada (meter) + envio para o Bus 2**. A do teclado é a referência lenta do teclado somada ao envio dele.

- **Solista:** a solista é a voz com mais energia de entrada. Para outra voz tomar o lugar, ela precisa liderar por `soloLeadDb` durante `soloHoldSec`.
- **Alvo da solista:** a contribuição do teclado + `soloVsKeyDb`, preso entre `vocalBackingDb` e `vocalSoloMaxDb` (envio).
- **Backings:** envio fixo em `vocalBackingDb`.
- **Teto das vozes:** qualquer voz acima de `vocalSoloMaxDb` desce até ele, mesmo calada (nunca sobe em silêncio).
- **Refs:** só são mexidos se passarem do teclado + o teto do canal (`ceilingDb` do canal → `groupCeilingDb` do grupo → `ceilingDb` padrão). Nesse caso, são cortados até esse teto.
- **Envio desejado:** o alvo − o nível de entrada, limitado pela mix base e arredondado para 0,5 dB.
- **Limite de subida:** se não der para chegar ao alvo sem passar de `maxBoostDb`, a página avisa: "peça mais ganho na mesa".

## Arquitetura

```
 ┌──────────── X32 (192.168.1.104:10023) ────────────┐
 │  /xremote  /meters/1 (canais)  /meters/2 (buses)  │
 └───────▲──────────────────────────────┬────────────┘
         │ só /ch/NN/mix/02/level       │ OSC/UDP
 ┌───────┴──────────────────────────────▼────────────┐
 │ src/x32.js     cliente UDP (EventEmitter)         │
 │ src/osc.js     codec OSC, lei de fader, meters    │
 │ src/engine.js  motor PURO (tick a cada 250 ms)    │
 │ src/server.js  HTTP estático + WebSocket :3000    │
 └───────────────────────▲───────────────────────────┘
                         │ WebSocket (estado a cada 150 ms)
              public/index.html  (Mac / iPhone)
```

`src/simulator.js` substitui a mesa quando o servidor roda com `--sim`.

## Limites conhecidos

- **Os meters dão nível, não espectro.** O motor equilibra volume. Ele não resolve máscara de frequência, como teclado e guitarra disputando os médios.
- **O envio do Bus 2 deve estar em pre-fader** para a estimativa ficar precisa. Em post-fader, o fader do canal no PA entra na conta sem o app saber.
- **Confirme os índices dos meters no primeiro uso com a mesa real.** O app assume que os 32 primeiros valores de `/meters/1` são os canais 1–32 e que o valor `bus − 1` de `/meters/2` é o bus.
- O motor não sobe um canal que está terminando uma frase, mas microfones com muito vazamento acima do gate (−45 dB) ainda contam como ativos. Nesse caso, ajuste o `gateDb`.
- Se um ajuste manual cair exatamente num valor que o motor acabou de mandar (diferença menor que 0,4 dB, nos últimos 3 s), ele não é reconhecido como manual.
