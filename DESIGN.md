# Sistema de design: sala de controle

A identidade vem de duas coisas: tipografia e a semântica de transmissão de TV. Cor indica **estado**, nunca decoração. Pesquisa de origem: Material Design 3, bibliotecas headless de 2026, catálogos de padrões que denunciam interface gerada por IA e ferramentas de evento e transmissão (Slido, Mentimeter, ATEM, vMix, OBS, StageTimer).

## 1. Princípios

1. **Escolhido, não padrão.** Cada valor visual existe por um motivo. Se algo parece "o padrão de uma biblioteca", está errado.
2. **Cor = estado.** Vermelho (`program`) = no ar. Verde (`preview`) = prévia. Âmbar (`attention`) = aguardando ação ou conexão instável. Fora disso, a interface é neutra.
3. **O console recua, o conteúdo aparece.** Navegação e molduras são discretas. Fila de perguntas, prévia e no ar têm o contraste.
4. **Rápido sob pressão.** Teclado primeiro, nada de animação em ação frequente, desfazer em vez de confirmar.
5. **Legível de longe.** A tela do evento é lida a 30 m: tipografia grande, contraste garantido, nunca texto cortado.

## 2. Tokens (use só classes destes tokens)

A paleta padrão do Tailwind foi apagada. `bg-indigo-500`, `text-gray-400`, `shadow-lg`, `rounded-xl` **não existem**.

| Classe | Uso |
|---|---|
| `bg-canvas` | fundo da página |
| `bg-surface` | painéis, colunas, barra superior |
| `bg-raised` | linha selecionada, hover, popovers, campos em destaque |
| `border-line` | divisórias de agrupamento (só onde agrupam algo) |
| `border-line-strong` | bordas que identificam controles (inputs) |
| `text-fg` / `text-fg-muted` / `text-fg-subtle` | texto principal / secundário / metadado |
| `bg-accent` + `text-on-accent` | ação principal (no console é neutra: fundo claro, texto escuro) |
| `text-accent-fg` | cor da marca do evento usada como texto/ícone (celular e tela) |
| `bg-accent-soft` | contêiner levemente tingido pela marca (celular e tela) |
| `text-critical` / `border-critical` | erro e exclusão |
| `bg-program` · `tally-program` · `bg-program-strong` | **no ar** (moldura, chip com texto branco) |
| `bg-preview` · `tally-preview` | **prévia** (texto sobre ele: `text-on-signal`) |
| `bg-attention` | aguardando ação, conexão instável (texto: `text-on-signal`) |

O mesmo vocabulário vale nas três superfícies. O console usa os valores fixos de `:root`. O celular e a tela aplicam a paleta do evento com `tokenVars(eventPalette(theme))` (de `src/lib/theme.ts`) num elemento raiz, e as mesmas classes passam a usar as cores da marca, com contraste WCAG garantido pelo gerador `shared/screen-theme.ts`.

**Raios:** `rounded-chip` 4 px (chips de estado, que **não** são pílulas), `rounded-control` 6 px (botões, campos), `rounded-panel` 10 px (diálogos), `rounded-monitor` 2 px (monitores e miniaturas). `rounded-full` só em interruptores, pontos e avatares.

**Elevação:** só por luminosidade (`canvas` → `surface` → `raised`). Sem sombras, sem vidro, sem brilho, sem gradientes. Sobreposições = `bg-raised` + `border-line`.

**Tally (assinatura):** o que está no ar recebe moldura vermelha de 2 px em **todos os lados** (`tally-program`); o que está na prévia, verde (`tally-preview`). Nunca uma faixa colorida só na lateral.

## 3. Tipografia

- Interface: **Schibsted Grotesk Variable** (`font-ui`, padrão). PIN e códigos: **Spline Sans Mono Variable** (`font-code`, zero pontilhado). Mono **só** para PIN/códigos, nunca como enfeite.
- Peso padrão 450. Títulos 600–650. Nada abaixo de 12 px.
- Escala do console: `text-meta` 12/16, `text-ui` 13/20, `text-read` 15/22 (texto de pergunta), `text-title` 17/24, `text-page` 20/26, `text-readout` 28/32 (leitura de cronômetro).
- Escala do celular: `text-body` 16/24 (campos com 16 px ou mais para o iOS não dar zoom), `text-head` 20/26, `text-event` 28/32.
- Todo número que muda (contadores, cronômetro, relógio, curtidas): `tabular-nums`.
- **Sentence case** em tudo. Caixa-alta só em siglas (PIN, QR, CSV). Sem sobretítulos espaçados em caixa-alta.
- Tela do evento: fontes do tema via `font-heading`, `font-body`, `font-numbers`. Altura de linha mínima em títulos: 1,15 (acentos do português colidem abaixo disso).

## 4. Componentes (`src/ui`)

Use os componentes prontos antes de estilizar elementos na mão: `Button` (variantes `primary` `secondary` `ghost` `danger` `program`; tamanhos `sm` `md` `lg` `xl`; props `icon`, `kbd`, `loading`), `IconButton` (sempre com `label`), `Field` + `Input`/`Textarea`, `Switch`, `Select`, `Segmented`, `Slider`, `ColorField`, `TabBar`, `Chip`, `Dot`, `Kbd`, `Spinner`, `Empty`, `Panel`, `Code`, `Dialog`, `confirm()`, `Menu`, `Tooltip`, `Popover`, `notify()`, `undoable()`, `undoLast()`.

- Uma ação `primary` por região. `program` (vermelho) só para **Colocar no ar** e **Atualizar no ar**.
- Ação que muda o que está no ar sempre tem **ícone + texto**, nunca só ícone.
- Ações reversíveis (aprovar, rejeitar, marcar respondida, destacar, revogar) executam na hora e mostram `undoable('Pergunta aprovada', desfazer)`. `confirm()` só para o que é irreversível ou público: excluir cena/evento, gerar novo PIN, gerar novo link, encerrar evento.
- Todo componente tem os estados hover, foco visível, desabilitado, carregando, erro e vazio.
- Listas e filas são linhas com divisórias finas, não cartões. Nada de cartão dentro de cartão.

## 5. Movimento

- 0 ms para ações por teclado e frequentes (corte, aprovar, rejeitar, navegar).
- 100–150 ms para resposta a ponteiro (hover, press). Até 220 ms com `ease-out` para painéis.
- Sem animação de entrada, sem números contando, sem bounce, sem `transition-all`.
- Na tela do evento: corte (instantâneo) ou fusão (padrão 500 ms) entre cenas, 300 ms para troca de conteúdo dentro da cena. Reações sobem e somem (2,4 s), com no máximo 16 ao mesmo tempo e "+N" no excedente.
- Respeite `prefers-reduced-motion` no celular.

## 6. Ícones

Phosphor, importado **por ícone**: `import { PlayIcon } from '@phosphor-icons/react/Play'` (nunca do pacote raiz). Peso `regular` no console (16 px, padrão via `IconContext`), `bold` na tela, `fill` = estado ativo (reação marcada, no ar). Proibido: emoji, `Sparkle`, `lucide-react`, caracteres Unicode como ícone.

Reações (rótulo pt-BR + ícone): `applause` Aplaudir (`HandsClapping`), `love` Adorei (`Heart`), `like` Curtir (`ThumbsUp`), `insight` Boa ideia (`Lightbulb`), `doubt` Dúvida (`Question`), `laugh` Engraçado (`Smiley`).

## 7. Texto (pt-BR)

- Trate por "você". Frases curtas, voz ativa, tempo presente. Neutro em gênero **reescrevendo** a frase: "Olá, Ana." e não "Bem-vindo(a)"; "Conexão restabelecida" e não "Conectado".
- Botões: verbo no infinitivo + objeto, 1 a 3 palavras ("Enviar pergunta", "Copiar link"). O mesmo verbo nomeia o resultado: "Aprovar" → "Pergunta aprovada".
- Sem "!", sem emoji, sem "com sucesso", sem "Ops", sem desculpas, sem "Clique aqui".
- Erro = o que aconteceu + o que fazer: "PIN incorreto. Confira os números com a organização do evento."
- Vazio = o que aparece aqui + como fazer aparecer + no máximo um botão: "Nenhuma pergunta aguardando. As novas perguntas aparecem aqui assim que forem enviadas."
- Zero é especial: "Nenhuma pergunta", nunca "0 perguntas". Use `plural()` de `src/lib/format.ts`.
- Proibidas: potencializar, elevar, desbloquear, revolucionar, turbinar, alavancar, mergulhar, jornada, experiência única/incrível/fluida, poderoso, inovador, disruptivo, dinâmico, crucial, fundamental, insight, "Vale ressaltar", "Fique à vontade", "Seja bem-vindo".
- Use o caractere `…`, aspas curvas “ ”, travessão em intervalos (19:00–21:00) e espaço inseparável entre número e unidade (5 min, 12 MB).

**Glossário fixo:** evento · PIN do evento · convite / link do convite · participante · moderação · organização · **tela** (só o telão; as páginas do celular são "página") · roteiro · cena · prévia · no ar · colocar/tirar do ar · corte / fusão · tela de espera · fila · envio de perguntas (aberto/fechado), nunca "perguntas abertas" · reações (liberadas/pausadas) · cronômetro / contagem regressiva · zerar (nunca reiniciar/resetar) · excluir (permanente) × remover (da tela, da lista).

**Estados de pergunta:** moderação vê Aguardando / Aprovada / Na prévia / No ar / Respondida / Rejeitada / Editada. Quem enviou vê Aguardando aprovação / Aprovada / Na tela agora / Respondida / Não aprovada / Texto ajustado pela moderação.

## 8. Superfícies

### Console do moderador (desktop, só escuro, largura mínima 1100 px, sem rolagem da página)
- Barra superior de 48 px (`EventLayout`): Eventos › nome do evento, abas (Ao vivo, Participantes, Aparência, Mídia, Ajustes), chaves "Envio de perguntas" e "Reações", presença, conexão (só aparece com problema), relógio, "Abrir tela".
- **Ao vivo**, em três colunas: **Roteiro** (264 px; 300 px a partir de 1920 px) | centro com monitores **Prévia** (esquerda, verde) e **No ar** (direita, vermelho) na proporção do evento, barra de transição entre eles ("Corte" e "Fusão" com atalhos, botão `program` "Colocar no ar"), controles do que está no ar (cronômetro, vídeo, tela de espera, sobreposições) e o **inspetor** da cena em prévia | **Perguntas** (440 px; 520 px a partir de 1920 px). As colunas rolam; a página não.
- O monitor No ar mostra **só o estado confirmado pelo servidor**, com o mesmo `<Stage>` da tela.
- Editar a cena que está no ar não publica sozinho: as mudanças ficam locais até "Atualizar no ar" (botão `program`).

**Atalhos (ignorados durante digitação e com diálogo aberto):**

| Tecla | Ação |
|---|---|
| Espaço | Corte: prévia vai ao ar (prévia e no ar trocam de lugar; cortar de novo desfaz) |
| Enter | Fusão |
| 1–9, 0 | Cena 1–10 do roteiro para a prévia |
| ↑ / ↓ | Cena anterior / seguinte para a prévia |
| B | Tela de espera liga/desliga |
| T | Cronômetro inicia/pausa |
| P | Vídeo toca/pausa |
| J / K | Próxima / anterior na fila de perguntas |
| A / R / E | Aprovar / Rejeitar / Editar a pergunta selecionada |
| D | Destacar na tela (só esta pergunta) |
| M | Marcar como respondida |
| ⌘Z / Ctrl+Z | Desfazer a última ação |
| ? | Folha de atalhos |

Cada botão com atalho mostra a dica (`kbd` / `Tooltip`).

### Página do participante (celular, segue claro/escuro do sistema)
- Paleta: `tokenVars(eventPalette(theme, { mode: sistema, contrast: 'high' se prefers-contrast }))`. A marca do evento entra como acento. O fundo é neutro, nunca creme.
- Uma página só: cabeçalho (logo/nome do evento), cartão **Na tela agora** (adaptado ao tipo da cena; perguntas na tela com Curtir), barra de reações (botões de 56 px com rótulo), campo de pergunta (contador "212/280", identidade conforme o evento) e **Minhas perguntas** com estado.
- Envio fechado: o campo vira uma linha explicando o estado, e o rascunho é mantido. Reações pausadas: a barra some.
- Sem conexão (após 3 s): faixa discreta "Sem conexão. Tentando reconectar…", com botões de envio desabilitados.
- Alvos de toque de pelo menos 48 px, texto de 16 px ou mais.

### Tela do evento (telão)
- Canvas lógico com 1080 de altura (16:9 = 1920 × 1080); tamanhos em unidades do canvas, escalados com container queries para manter o texto nítido.
- Margem de segurança padrão de 5 %, com texto e sobreposições dentro dela. O fundo vai até a borda.
- Pergunta em destaque: 80 px (mínimo 64), até 6 linhas, coluna de 1536 px, autor em 40 px. Mural: 3 perguntas por padrão (até 6), de 56 a 40 px. **Nunca truncar**: se não couber, avisar o console (`onOverflow`).
- Cronômetro: algarismos tabulares, âmbar no aviso, vermelho no crítico. No zero: tempo extra em "+m:ss" vermelho, parar em 00:00 ou mostrar a mensagem.
- Reações: faixa no canto inferior direito, dentro da área segura, ícones de 64 px. Ocultas em cenas de vídeo.
- Entrada: QR escuro sobre ladrilho claro (ECC M, borda de 4 módulos, mínimo de 300 px), URL sem "https://", PIN em 72 px agrupado 3 + 3. Evento só com convidados: "Use o link do seu convite" e "PIN 482 913" em linhas separadas.
- Tela de espera: marca (logo, nome do evento, entrada) ou preto.
- Abre com um portão "Iniciar exibição" (tela cheia, áudio liberado, tela sempre ligada, cursor oculto após 2 s parado). Sem conexão, congela o último quadro; o público nunca vê erro.

## 9. Lista de verificação anti-"cara de IA"

Não pode existir: emoji · "!" em texto da interface · palavras proibidas da seção 7 · gradientes, `backdrop-blur`, brilho, sombra colorida · borda colorida só na lateral · `uppercase` + `tracking` em rótulos · `transition-all`, `animate-bounce`, `animate-pulse` · pílula pulsante de "ao vivo" · cartão dentro de cartão · ícone em cima de todo cartão · `font-mono` fora de PIN/código · `lucide-react`, `Sparkle` · ilustração em estado vazio · número sem `tabular-nums` quando muda.
