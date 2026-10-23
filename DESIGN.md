# Sistema de design: Conexão Profissional 2026

A identidade visual é a do **Conexão Profissional 2026 — Finanças, Carreira e Mercado na Prática** (SENAI Fraiburgo), tirada do manual em `_Identidade Visual conexão profissional/`. Por baixo dela continua a semântica de transmissão de TV: vermelho, verde e âmbar indicam **estado**, nunca decoração. Pesquisa de origem: Material Design 3, bibliotecas headless de 2026, catálogos de padrões que denunciam interface gerada por IA e ferramentas de evento e transmissão (Slido, Mentimeter, ATEM, vMix, OBS, StageTimer).

## 0. Marca (manual)

| Cor | Valor | Uso no app |
|---|---|---|
| Azul SENAI | `#004098` | cor primária: ação principal, seleção, foco, barras superiores, fundo do telão |
| Laranja SENAI | `#E8490F` | acento **com moderação**: só no logo (ponto do ícone, selo “2026”, “SENAI FRAIBURGO”). Fica fora da interface porque se confunde com o vermelho de “no ar” |
| Grafite | `#221F1F` | texto |
| Branco | `#FFFFFF` | fundo e versão negativa |

Cinzas quentes do manual: `#E5E1DC` (bordas) e `#5B5754` (texto secundário).

- **Logo** em `src/ui/brand.tsx`, com a geometria dos arquivos oficiais: `BrandLogo` (completo, uso geral ou `negative`), `BrandMark` (ícone + “Conexão Profissional” numa linha, como no cabeçalho do manual) e `BrandIcon` (ícone isolado). O logo usa as cores fixas da marca, nunca tokens.
- Logo completo com pelo menos 160 px de largura; abaixo disso, o ícone. Espaço livre ao redor equivalente à altura do ícone.
- Sobre azul, sempre a versão negativa (arco branco, ponto final branco a 35 %, ponto laranja).
- Proibido (manual): alterar as cores oficiais, gradientes, distorcer, inclinar, espelhar ou girar o ícone, sombras, contornos extras e efeitos 3D.
- Favicon: o selo (ícone negativo num círculo azul), `public/favicon.svg`.
- **Rodapé fixo da marca em todas as páginas**: `BrandFooter` com a `BrandStrip`, os elementos do logo numa linha com texto de verdade (14 px; 12 px no celular, em duas linhas). O logo completo encolhido a altura de rodapé fica ilegível: a frase e o “SENAI FRAIBURGO” ocupam 7–10 % da altura dele. Positivo sobre fundo claro (console, entrada, celular claro), negativo sobre azul ou escuro (portão e pareamento do telão, celular escuro); no negativo, “SENAI FRAIBURGO” vai em branco (o laranja sobre o azul fica a 2,5:1). No celular ele some quando o teclado encolhe a janela (campo focado e altura até 560 px). Telas de carregamento ficam sem rodapé. A faixa e o logo são a única exceção à regra de caixa-alta.

## 1. Princípios

1. **Escolhido, não padrão.** Cada valor visual existe por um motivo. Se algo parece "o padrão de uma biblioteca", está errado.
2. **Cor = estado; azul = marca.** Vermelho (`program`) = no ar. Verde (`preview`) = prévia. Âmbar (`attention`) = aguardando ação ou conexão instável. O Azul SENAI (`accent`) marca ação principal, seleção e foco. Fora disso, a interface é neutra (branco, grafite e os cinzas do manual).
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
| `bg-accent` + `text-on-accent` | ação principal, interruptor ligado, aba ativa (no console: Azul SENAI com texto branco) |
| `text-accent-fg` | cor da marca usada como texto/ícone; item selecionado em `Segmented` e reações marcadas |
| `bg-accent-soft` | contêiner levemente tingido pela marca; fundo do item selecionado |
| `on-brand` | faixa na cor da marca (versão negativa): redefine os tokens sobre o azul. Barras superiores do console, painel da entrada, portão e pareamento do telão |
| `text-critical` / `border-critical` | erro e exclusão |
| `bg-program` · `tally-program` · `bg-program-strong` | **no ar** (moldura, chip com texto branco) |
| `bg-preview` · `tally-preview` | **prévia** (texto sobre ele: `text-on-signal`) |
| `bg-attention` | aguardando ação, conexão instável (texto: `text-on-signal`) |

O mesmo vocabulário vale nas três superfícies. O console usa os valores fixos de `:root` (claro, nas cores do manual). O celular e a tela aplicam a paleta do evento com `tokenVars(eventPalette(theme))` (de `src/lib/theme.ts`) num elemento raiz, e as mesmas classes passam a usar as cores da marca, com contraste WCAG garantido pelo gerador `shared/screen-theme.ts`.

**Raios:** `rounded-chip` 4 px (chips de estado, que **não** são pílulas), `rounded-control` 6 px (botões, campos), `rounded-panel` 10 px (diálogos), `rounded-monitor` 2 px (monitores e miniaturas). `rounded-full` só em interruptores, pontos e avatares.

**Elevação:** só por luminosidade (`canvas` → `surface` → `raised`; no claro, cada passo escurece em direção ao texto). Sem sombras, sem vidro, sem brilho, sem gradientes. `bg-raised` é seleção e hover. Sobreposições (menus, dicas, avisos, listas) = `bg-canvas` + `border-line-strong/50`: no claro, o que sobe fica branco com borda firme. Diálogos = `bg-surface` + `border-line` sobre o véu.

**Tally (assinatura):** o que está no ar recebe moldura vermelha de 2 px em **todos os lados** (`tally-program`); o que está na prévia, verde (`tally-preview`). Nunca uma faixa colorida só na lateral.

## 3. Tipografia

- Texto da interface: **Helvetica Neue / Arial**, fontes do sistema (`font-ui`, padrão; o manual pede Univers/Helvetica Neue, com Arial como alternativa).
- Títulos e logo: **Poppins** (`font-brand`; `font-heading` cai nela fora do celular e da tela). É a alternativa gratuita do manual a Futura/Century Gothic, servida pelo app (`@fontsource/poppins`). Use em títulos de página, nome do evento e diálogos de página inteira; listas, painéis densos e rótulos ficam em `font-ui`.
- Poppins **não tem algarismos de largura fixa**: nunca em cronômetro, contadores ou PIN (o editor da tela a tira da lista de números).
- PIN e códigos: **Spline Sans Mono Variable** (`font-code`, zero pontilhado). Mono **só** para PIN/códigos, nunca como enfeite.
- Peso padrão 400. Títulos 600–700. Nada abaixo de 12 px.
- Escala do console: `text-meta` 12/16, `text-ui` 13/20, `text-read` 15/22 (texto de pergunta), `text-title` 17/24, `text-page` 20/26, `text-readout` 28/32 (leitura de cronômetro).
- Escala do celular: `text-body` 16/24 (campos com 16 px ou mais para o iOS não dar zoom), `text-head` 20/26, `text-event` 28/32.
- Todo número que muda (contadores, cronômetro, relógio, curtidas): `tabular-nums`.
- **Sentence case** em tudo. Caixa-alta só em siglas (PIN, QR, CSV). Sem sobretítulos espaçados em caixa-alta.
- Tela do evento: fontes do tema via `font-heading`, `font-body`, `font-numbers`. Tema padrão: Poppins 700 nos títulos, Arial no texto e nos números. Altura de linha mínima em títulos: 1,15 (acentos do português colidem abaixo disso).

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
- Na tela do evento: corte (instantâneo) ou fusão (padrão 500 ms) entre cenas, 300 ms para troca de conteúdo dentro da cena. Reações aparecem em 0,3 s, sobem devagar em velocidade constante e só começam a sumir no último quarto do caminho (5 s ao todo), com no máximo 16 ao mesmo tempo e "+N" no excedente.
- Respeite `prefers-reduced-motion` no celular.

## 6. Ícones

Phosphor, importado **por ícone**: `import { PlayIcon } from '@phosphor-icons/react/Play'` (nunca do pacote raiz). Peso `regular` no console (16 px, padrão via `IconContext`), `bold` na tela, `fill` = estado ativo (no ar). Proibido: emoji como caractere no texto, `Sparkle`, `lucide-react`, caracteres Unicode como ícone.

Reações (rótulo pt-BR + **emoji colorido do Twemoji**, a única exceção à regra de emoji): `applause` Aplaudir (palmas), `love` Adorei (coração vermelho), `like` Curtir (joinha), `insight` Boa ideia (lâmpada), `doubt` Dúvida (rosto pensativo), `laugh` Engraçado (rindo até chorar). Os SVGs ficam em `src/assets/emoji/` e são desenhados por `ReactionEmoji` (`src/lib/reactions.tsx`), com as cores originais, do tamanho do texto (1em): saem iguais em todo celular e no telão e não dependem da fonte de emoji do aparelho. Na página de ajustes, a reação desligada fica em cinza. No telão, as que sobem têm 80 de altura no canvas e o contador, 56. Crédito exigido pela licença (CC-BY 4.0): Twemoji, de Twitter, Inc. e colaboradores.

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

### Console do moderador (desktop, claro, largura mínima 1100 px, sem rolagem da página)
- Barra superior de 48 px em `on-brand` (`EventLayout`): ícone da marca + Eventos › nome do evento, abas (Ao vivo, Participantes, Aparência, Mídia, Ajustes), chaves "Envio de perguntas" e "Reações", presença, conexão (só aparece com problema), relógio, "Abrir tela".
- Console aberto fora do endereço público (`PUBLIC_URL` ou, na Vercel, o domínio de produção): faixa âmbar abaixo da barra superior, com o link para o endereço do evento. O endereço de cada deploy da Vercel fica preso àquela versão e pede login, e o histórico do navegador leva a ele sem ninguém perceber.
- **Ao vivo**, em três colunas: **Roteiro** (264 px; 300 px a partir de 1920 px) | centro com monitores **Prévia** (esquerda, verde) e **No ar** (direita, vermelho) na proporção do evento, barra de transição entre eles ("Corte" e "Fusão" com atalhos, botão `program` "Colocar no ar"), controles do que está no ar (cronômetro, vídeo, tela de espera, sobreposições) e o **inspetor** da cena em prévia | **Perguntas** (440 px; 520 px a partir de 1920 px). As colunas rolam; a página não.
- O monitor No ar mostra **só o estado confirmado pelo servidor**, com o mesmo `<Stage>` da tela.
- **Pastas no roteiro** (por momento ou palestrante): uma cena do tipo `section` é o título da pasta, e as cenas abaixo dela são dela até a próxima pasta. O título recolhe e abre as cenas (estado guardado neste computador), mostra quantas são e, recolhido, avisa “No ar” ou “Prévia” se uma delas estiver lá. “+” cria cena no fim da pasta; arrastar o título leva a pasta inteira, sem nunca engolir as cenas soltas do começo. Pastas nunca vão para a prévia nem para a tela, e numeração, teclas 1 a 0 e ↑/↓ contam só as cenas.
- **Apresentação** (`slides`): os slides do palestrante como imagens. O PDF, exportado do PowerPoint, Keynote, Google Slides ou Canva, é convertido no navegador do console pelo pdf.js (`src/moderator/live/slides.ts`): cada página vira um WebP de até 1920 × 1080 enviado à biblioteca. Imagens também servem. Animações e vídeos dos slides não vêm junto. No ar, o slide muda sem passar pela prévia (← → ou Page Up/Down, as teclas dos passadores; ou clique na miniatura). Cada apresentação guarda o próprio slide em `live.slides`, então voltar a ela retoma de onde parou, e na prévia o clique escolhe de onde ela começa.
- Editar a cena que está no ar não publica sozinho: as mudanças ficam locais até "Atualizar no ar" (botão `program`).
- **Sobre o conteúdo** (controles do No ar): a chave “Cronômetro sobre o conteúdo” mostra os controles do cronômetro (os mesmos da cena de cronômetro, tecla T inclusive) e a posição, “Em cima à esquerda” (padrão) ou “Em cima à direita”. Sem cena de cronômetro no ar, “Duração da fala” + “Definir tempo” (ou Enter) prepara a contagem regressiva sem trocar a cena; com ela no ar, o campo some, porque definir à mão desvincula o relógio da cena. A pergunta sobreposta (tecla S na fila) aparece em “Pergunta sobre o conteúdo”, com texto em até 2 linhas, autor e “Remover de cima do conteúdo” (com desfazer). Na fila, “Sobrepor ao conteúdo” fica no menu “Mais ações”: um quarto botão não cabe na linha da coluna de 440 px. Ela é independente do “Destacar” e da cena de perguntas.

**Atalhos (ignorados durante digitação e com diálogo aberto):**

| Tecla | Ação |
|---|---|
| Espaço | Corte: prévia vai ao ar (prévia e no ar trocam de lugar; cortar de novo desfaz) |
| Enter | Fusão |
| 1–9, 0 | Cena 1–10 do roteiro para a prévia |
| ↑ / ↓ | Cena anterior / seguinte para a prévia |
| ← / → · Page Up / Page Down | Slide anterior / seguinte da apresentação no ar (passador sem fio) |
| B | Tela de espera liga/desliga |
| T | Cronômetro inicia/pausa (com cena de cronômetro no ar, cronômetro correndo ou sobre o conteúdo) |
| P | Vídeo toca/pausa |
| J / K | Próxima / anterior na fila de perguntas |
| A / R / E | Aprovar / Rejeitar / Editar a pergunta selecionada |
| D | Destacar na tela (só esta pergunta) |
| S | Sobrepor a pergunta ao conteúdo no ar; de novo, remove |
| M | Marcar como respondida |
| ⌘Z / Ctrl+Z | Desfazer a última ação |
| ? | Folha de atalhos |

Cada botão com atalho mostra a dica (`kbd` / `Tooltip`).

### Página do participante (celular, segue claro/escuro do sistema)
- Paleta: `tokenVars(eventPalette(theme, { mode: sistema, contrast: 'high' se prefers-contrast }))`. A marca do evento entra como acento (no tema padrão, botões no Azul SENAI exato com texto branco). O fundo é neutro, nunca creme.
- Cabeçalho: logo enviado pela organização ou, sem logo, o ícone da marca (negativo no modo escuro) acima do nome do evento em Poppins.
- Uma página só: cabeçalho (logo/nome do evento), cartão **Na tela agora** (adaptado ao tipo da cena; perguntas na tela com Curtir), barra de reações (botões de 56 px com rótulo), campo de pergunta (contador "212/280", identidade conforme o evento) e **Minhas perguntas** com estado.
- Envio fechado: o campo vira uma linha explicando o estado, e o rascunho é mantido. Reações pausadas: a barra some.
- Sem conexão (após 3 s): faixa discreta "Sem conexão. Tentando reconectar…", com botões de envio desabilitados.
- Alvos de toque de pelo menos 48 px, texto de 16 px ou mais.

### Tela do evento (telão)
- Tema padrão (predefinição “Conexão azul”): versão negativa do manual, fundo no Azul SENAI exato. O gerador escureceria o fundo para o texto passar 7:1 nos cartões; os ajustes finos fixam `canvas` em `#004098` e os cartões em `#0C4DA8` (texto branco a 7,95:1). Trocar fundo, modo ou contraste no editor descarta esses ajustes e volta ao gerador. “Conexão branco” é a versão de uso geral (fundo branco, destaque azul).
- **Marca fixa** no canto inferior direito de toda cena e da tela de espera: `BrandStrip` em duas linhas com corpo de 30 (`BRAND_FONT`, `BRAND`, `BRAND_W` em `src/stage/lib.ts`), legível do fundo do auditório; negativa no tema escuro e positiva no claro. A linha de baixo da área segura é sempre reservada para ela: texto, aviso de “não cabe” e reações ficam acima; o rodapé de texto e o logo do tema em baixo terminam antes dela. A faixa de entrada fica em cima por padrão (vista também por quem senta na frente, abaixo do telão) ou embaixo, escolhida no Ao vivo: em cima, o texto da cena começa abaixo dela e o cronômetro sobre o conteúdo desce para logo abaixo dela; embaixo, a marca sobe para logo acima da faixa (e o texto da cena termina acima dela). A tela de espera preta cobre tudo. Com a marca fixa, o logo enviado pelo evento repete a marca: use a posição “Oculta”.
- Logo do telão: o PNG negativo oficial tem fundo `#004098` sólido, por isso o fundo do tema precisa ser exatamente esse azul (senão o logo vira um retângulo visível).
- Portão, pareamento e avisos da técnica em `on-brand`; antes do primeiro quadro, preto (nunca branco no projetor).
- Canvas lógico com 1080 de altura (16:9 = 1920 × 1080); tamanhos em unidades do canvas, escalados com container queries para manter o texto nítido.
- Margem de segurança padrão de 5 %, com texto e sobreposições dentro dela. O fundo vai até a borda.
- Pergunta em destaque: 80 px (mínimo 64), até 6 linhas, coluna de 1536 px, autor em 40 px. Mural: 3 perguntas por padrão (até 6), de 56 a 40 px. **Nunca truncar**: se não couber, avisar o console (`onOverflow`).
- Cronômetro: algarismos tabulares, âmbar no aviso, vermelho no crítico. No zero: tempo extra em "+m:ss" vermelho, parar em 00:00 ou mostrar a mensagem.
- Reações: faixa no canto inferior direito, dentro da área segura, ícones de 64 px. Ocultas em cenas de vídeo e sob a pergunta sobre o conteúdo.
- **Sobre o conteúdo**: cronômetro e pergunta ficam por cima da cena no ar, sem trocá-la. O cronômetro (cerca de 120 de altura, mesmas cores de aviso e crítico) vai no canto de cima escolhido, dentro da área segura. A pergunta vai num cartão de até 1536 de largura na base da área do texto, acima da linha da marca, de 72 a 40 conforme o comprimento (nunca truncada), com o autor; um véu da cor de fundo (70%) recua a cena, que continua visível. As duas somem na tela de espera, sem nada no ar e nas miniaturas; o cronômetro também some com uma cena de cronômetro no ar (repetiria). Com a pergunta na tela, as reações e a faixa de entrada ficam ocultas: o cartão ocupa a base (e, com o cronômetro também ligado, sobraria pouco espaço para a pergunta). Cronômetro e faixa de entrada ficam acima do véu.
- Página web: a maioria dos sites grandes proíbe aparecer dentro de outra página (`X-Frame-Options`, CSP `frame-ancestors`, ou bloqueio de robôs com 403), e o navegador obedece. Por isso:
  - Links com versão própria para incorporar viram essa versão (`embedUrl`): YouTube, Vimeo, apresentação, documento e planilha do Google, Google Drive e Canva.
  - Ao salvar o endereço, o servidor verifica o site (`POST /events/:id/embed-check`, em `server/embed.ts`). A verificação lê só os cabeçalhos, aceita só https, recusa rede interna na conexão, segue até 4 redirecionamentos (http vira https) e tem limite de 6 s.
  - O endereço final do mesmo site (com www e https) substitui o digitado.
  - Site que bloqueia vai para a tela como **endereço e QR code** (“Acesse pelo celular”), em vez do erro do navegador. A troca é automática para endereço recém-digitado ou cena sem escolha (as antigas incluídas); a escolha feita à mão em “Na tela” é respeitada.
- Apresentação: o slide inteiro, contido na área acima da linha da marca (a marca nunca cobre o slide), com fusão de 300 ms entre slides; os vizinhos ficam pré-carregados.
- Entrada: QR escuro sobre ladrilho claro (ECC M, borda de 4 módulos, mínimo de 300 px), URL sem "https://", PIN em 72 px agrupado 3 + 3. Evento só com convidados: "Use o link do seu convite" e "PIN 482 913" em linhas separadas. O endereço só quebra antes de um ponto do domínio ou antes do caminho (`addressParts`): nunca no hífen, que pareceria hifenização, nem no meio do código. Alcance medido com leitores em tempo real: o QR de 300 da faixa é lido até umas 4 vezes a altura da tela (8 m numa tela de 2 m); para o fundo do auditório, a cena Entrada.
- Cena **Entrada**: a faixa em tela cheia, para o começo do evento e para o credenciamento. QR com a altura da área do texto (até 42 % da largura), que cede espaço até 300 para o texto caber ao lado; título, “Aponte a câmera para o QR code ou acesse”, o endereço e o PIN em 128. Lida até umas 9 vezes a altura da tela (18 a 21 m numa tela de 2 m). Com ela no ar, a faixa some (repetiria o QR). Texto que não cabe, na altura ou na largura, gera o aviso “Não cabe na tela”. O QR só existe com a entrada aberta; desligada, o console avisa abaixo das chaves do No ar (com o botão “Ligar entrada aberta”) e no inspetor da cena.
- Tela de espera: marca (logo, nome do evento, entrada) ou preto.
- Abre com um portão "Iniciar exibição" (tela cheia, áudio liberado, tela sempre ligada, cursor oculto após 2 s parado). Sem conexão, congela o último quadro; o público nunca vê erro. Com versão nova publicada, fora da tela cheia, recarrega sozinha e volta à exibição sem o portão; em tela cheia, espera (recarregar sairia dela).

## 9. Lista de verificação anti-"cara de IA"

Não pode existir: laranja da marca fora do logo · logo distorcido, com sombra ou recolorido · Poppins em número que muda · emoji fora das reações · "!" em texto da interface · palavras proibidas da seção 7 · gradientes, `backdrop-blur`, brilho, sombra colorida · borda colorida só na lateral · `uppercase` + `tracking` em rótulos · `transition-all`, `animate-bounce`, `animate-pulse` · pílula pulsante de "ao vivo" · cartão dentro de cartão · ícone em cima de todo cartão · `font-mono` fora de PIN/código · `lucide-react`, `Sparkle` · ilustração em estado vazio · número sem `tabular-nums` quando muda.
