# deck.slides

Gerenciador de perguntas e conteúdo para eventos ao vivo. A moderação conduz o roteiro de cenas do telão (título, perguntas da plateia, cronômetro, imagem, vídeo, página web), aprova e edita as perguntas que chegam pelo celular e acompanha as reações em tempo real. Um único processo Node serve a API e a interface; os dados ficam num arquivo SQLite.

Documentos de apoio: `CLAUDE.md` (arquitetura e convenções) e `DESIGN.md` (sistema visual e regras de texto).

## Superfícies e endereços

| Superfície | Endereço | Acesso |
|---|---|---|
| Console da moderação (notebook) | `/entrar`, `/eventos`, `/eventos/K7QX2M` e as abas `participantes`, `aparencia`, `midia`, `ajustes` | e-mail e senha da equipe |
| Página do participante (celular) | `/convite/<token>` (convite pessoal) e `/e/K7QX2M` (página do evento, entrada aberta) | link do convite, ou nome; nos dois casos, o PIN do evento |
| Tela do evento (telão) | `/tela` (pareamento por código) ou `/tela/K7QX2M` (navegador com a sessão do console) | código mostrado na tela e digitado no console; nenhum segredo na URL |

`K7QX2M` é o código curto do evento: 6 caracteres, sem I, L, O e U, fácil de ler em voz alta. É o id do evento em todos os endereços.

## Começo rápido

Requisitos: Node 24.7 ou mais recente (testado com 24.18) e pnpm 11.

```sh
pnpm install
pnpm dev      # interface em http://localhost:5173 e API em :3000; recarregam sozinhas a cada mudança
pnpm seed     # em outro terminal: cria o evento de demonstração e imprime os links
```

Sem nenhuma conta no banco, o seed cria a conta de demonstração `demo@deck.local` (senha `demo-deck-2026`). Se já houver conta, o evento fica disponível para ela.

**Celulares na mesma rede.** O `pnpm dev` mostra também o endereço da rede local (linha "Network", por exemplo `http://192.168.0.10:5173`). Abra o console por esse endereço, e não por `localhost`: o QR da tela e os links de convite usam o endereço da página aberta. Para fixar um endereço, defina `PUBLIC_URL`:

```sh
PUBLIC_URL=http://192.168.0.10:5173 pnpm dev
PUBLIC_URL=http://192.168.0.10:5173 pnpm seed
```

## Demonstração

1. Abra o link "Console" impresso pelo seed e entre.
2. **Ao vivo**: o roteiro fica à esquerda. Leve uma cena para a prévia (clique ou teclas 1 a 9) e coloque no ar com Corte (Espaço) ou Fusão (Enter). O monitor "No ar" mostra só o que o servidor confirmou.
3. **Telão**: abra `/tela` em outra janela ou em outro computador, clique em "Iniciar exibição" e digite o código mostrado em "Conectar tela" (na barra do console, junto da contagem de telas).
4. **Celular**: abra o link "Entrada aberta" ou um dos convites e informe o PIN impresso pelo seed. Envie uma pergunta e reaja.
5. **Moderação**: a pergunta chega como Aguardando. Aprove (A), edite (E), destaque na tela (D), marque como respondida (M). Desfaça com ⌘Z ou Ctrl+Z.
6. **Cronômetro**: coloque "Intervalo" no ar e inicie com T.

A tecla `?` mostra todos os atalhos.

## Testes e verificações

| Comando | O que faz |
|---|---|
| `pnpm test` | API em processo com banco temporário (sucesso, falha, autorização e segurança por funcionalidade), fluxo completo com o servidor real, tempo real, inicialização, paleta de cores, lógica do cliente e autoteste do lint |
| `pnpm test:coverage` | `pnpm test` com cobertura de `server/`, `shared/` e `src/lib` |
| `pnpm check` | TypeScript do cliente e do servidor |
| `pnpm lint` | regras do `DESIGN.md` (emoji, "!", palavras proibidas, classes e ícones proibidos) e padrões inseguros (HTML injetado sem justificativa, `eval`, `target="_blank"` sem `noopener`, `console.log` e `process.env` em respostas no servidor) |
| `pnpm verify` | `check`, `lint` e `test` |
| `pnpm build:vercel` | gera `.vercel/output` (front estático + função da API), o mesmo build que a Vercel roda |
| `PG_TEST_URL=postgres://… pnpm test:pg` | testes do servidor contra Postgres, num banco novo por arquivo, imitando o Supabase (papéis `anon`/`authenticated` com acesso automático às tabelas novas) |
| `BUNDLE=1 PG_TEST_URL=postgres://… node --test --test-force-exit server/tests/instances.test.ts` | depois do `build:vercel`: o pacote da função em duas instâncias sobre o mesmo Postgres, como na Vercel com Supabase (`SQLD=<binário sqld>` no lugar de `PG_TEST_URL` faz o mesmo com libSQL, como o Turso) |
| `pnpm run audit` | vulnerabilidades conhecidas nas dependências de produção (precisa de rede) |
| `node scripts/load.ts` | teste de carga do tempo real: centenas de celulares e telas, latência de propagação |

Exceção justificada ao lint: `// lint-ok: <motivo>` na linha de cima (no JSX, `{/* lint-ok: <motivo> */}`). HTML injetado só vale em arquivo listado em `SAFE_HTML` (`scripts/lint.ts`) e com `// seguro: <motivo>` na linha de cima.

## Produção

```sh
pnpm install
pnpm build
SESSION_SECRET="$(openssl rand -base64 48)" SETUP_TOKEN="<código de instalação>" pnpm start   # porta 3000
```

HTTPS, domínio e proxy reverso ficam a cargo da implantação. O proxy não deve fazer buffer de respostas `text/event-stream` (o tempo real usa SSE) e deve repassar `X-Forwarded-For` e `X-Forwarded-Proto` (com `TRUST_PROXY=1`). A primeira conta é criada em `/entrar` com o código de instalação.

| Variável | Padrão | Uso |
|---|---|---|
| `SESSION_SECRET` | obrigatória em produção (32 caracteres ou mais) | assina os cookies de sessão; trocar encerra todas as sessões |
| `SETUP_TOKEN` | sem valor | código exigido em produção para criar a primeira conta |
| `PUBLIC_URL` | endereço da página aberta (na Vercel, o domínio de produção do projeto) | base dos links de convite, do QR e do pareamento |
| `TRUST_PROXY` | desligado | `1` atrás de proxy reverso: IP real do cliente nos limites de tentativas |
| `DATA_DIR` | `./data` | banco SQLite e arquivos enviados (`uploads/`) |
| `MAX_UPLOAD_MB` | `1024` | limite por arquivo enviado |
| `PORT` | `3000` | porta HTTP |

O servidor não sobe com configuração inválida ou insegura e diz o que corrigir, sem imprimir segredos.

## Vercel

A Vercel não tem disco nem processo contínuo: cada requisição pode cair numa instância diferente da função. Por isso, lá:

- o banco é o **Postgres do Supabase** (`DATABASE_URL`) ou o **Turso** (`TURSO_DATABASE_URL`), em vez do arquivo em `DATA_DIR`. O SQL do app vale nos três;
- os arquivos enviados vão para o **Vercel Blob**, direto do navegador (a função não aceita corpos acima de 4,5 MB);
- presença, pareamento de telas, limites de tentativas e avisos de tempo real ficam no banco, e cada instância lê os avisos das outras a cada 250 ms;
- cada conexão SSE dura até 280 s (a função tem 300 s) e o navegador reabre na hora, sem mostrar queda;
- sem `PUBLIC_URL`, o QR de entrada, os convites e o pareamento usam o domínio de produção (`VERCEL_PROJECT_PRODUCTION_URL`). O endereço de cada deploy (`deck-slides-<hash>-<time>.vercel.app`) pede login na Vercel e fica preso àquela versão: abra o console e a tela sempre pelo domínio de produção.

`pnpm build:vercel` (o `buildCommand` do `vercel.json`) gera a saída pronta em `.vercel/output`: o front vai para a CDN com os mesmos cabeçalhos de segurança do servidor, e `/api/*` e `/media/*` vão para uma função Node 24 com tudo empacotado.

Para publicar com o Supabase:

1. No Supabase, em **Connect → Direct → Transaction pooler**, copie a conexão (`postgresql://postgres.<projeto>:[YOUR-PASSWORD]@aws-0-<região>.pooler.supabase.com:6543/postgres`) e troque `[YOUR-PASSWORD]` pela senha do banco. Se a senha tiver símbolos (`@`, `:`, `/`, `#`, `%`...), codifique-os para URL (ex.: `@` vira `%40`).
2. Na Vercel, em **Settings → Environment Variables**, crie `DATABASE_URL` com esse valor, `SESSION_SECRET` (`openssl rand -base64 48`) e `SETUP_TOKEN`.
3. Em **Storage**, conecte um **Blob** ao projeto (ele cria `BLOB_READ_WRITE_TOKEN`).
4. Deixe a região das funções (**Settings → Functions**) igual à do banco (Supabase `us-east-1` = Vercel `iad1`): cada comando do console é uma ida e volta até o banco.
5. Publique de novo (as variáveis só valem em deploys novos) e crie a primeira conta em `/entrar` com o código do `SETUP_TOKEN`.

O app cria as tabelas sozinho na primeira requisição. No Supabase, elas ficam com RLS ligado e sem nenhum privilégio para `anon`/`authenticated`: a Data API (chave pública) não lê nem grava nada, mesmo com "Automatically expose new tables" ligado no painel. O servidor fala direto com o Postgres como dono das tabelas.

| Variável | Uso na Vercel |
|---|---|
| `DATABASE_URL` (ou `POSTGRES_URL`) | Postgres do Supabase, pelo Transaction pooler (porta 6543) |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | alternativa ao Supabase: banco Turso |
| `BLOB_READ_WRITE_TOKEN` | arquivos enviados. Sem ele, o envio de mídia falha |
| `SESSION_SECRET`, `SETUP_TOKEN` | como em produção |

Sem nenhum banco configurado, a função não sobe e o log da Vercel diz o motivo. O IP do cliente vem do cabeçalho da borda da Vercel (que ela não deixa o cliente forjar), sem precisar de `TRUST_PROXY`.

## Segurança da aplicação (ativa hoje)

- **Contas da equipe.** Senha com hash scrypt e comparação em tempo constante; o login responde igual para e-mail inexistente e senha errada, e paga o mesmo custo de hash. Cookie de sessão assinado (HMAC), `HttpOnly`, `SameSite=Lax`, `Secure` em HTTPS, com validade conferida no servidor; trocar a senha encerra as outras sessões. Em produção, a primeira conta exige `SETUP_TOKEN`, e a criação é atômica.
- **Tentativas.** Limites por IP (contados no banco, valem somados entre instâncias) no login, no PIN, na consulta de convites, no envio de perguntas, nas reações e no pareamento de telas.
- **Participantes e telas.** Convite com token aleatório de 144 bits, ou nome mais PIN do evento. Gerar um novo link derruba as sessões do convite antigo. Bloquear um participante encerra a conexão na hora. A tela é pareada por um código digitado no console; o servidor guarda só o hash do segredo da tela.
- **Entrada de dados.** Todo corpo de requisição é validado com zod (mensagens em pt-BR), com limite de 2 MB para JSON. Endereços de mídia e de página web aceitam só arquivos do próprio evento ou `http(s)`.
- **Navegador.** CSP sem scripts de terceiros (`script-src 'self'`, `frame-ancestors 'none'`; só o telão aceita um iframe, e só da própria origem, para a moldura), `nosniff`, `Referrer-Policy: same-origin`, Permissions-Policy restritiva e `noindex`. Escritas de outro site são recusadas (CSRF e cookie SameSite).
- **Arquivos enviados.** Extensão definida pelo tipo validado, nunca pelo nome; nome aleatório; servidos com CSP `sandbox` e `nosniff`; limite de tamanho por streaming. Só o front compilado e os arquivos enviados são públicos; arquivos do projeto e o banco nunca são servidos (também não no `pnpm dev`). No Vercel Blob, o token de envio vale só para um caminho, um tipo e um tamanho; o servidor confere tipo e tamanho reais antes de registrar, e os arquivos ficam no domínio do Blob, que não lê os cookies do app.
- **Erros.** Erro interno nunca expõe detalhes ao cliente; o detalhe vai para o log do servidor.

## Próxima etapa: administrador geral

O núcleo já está escrito e testado em `server/security/` e os contratos estão em `shared/admin.ts`, mas ainda não está ligado às rotas:

- papéis de administrador geral e moderação, com cada moderador restrito aos próprios eventos;
- sessões guardadas no servidor e revogáveis uma a uma;
- senhas em Argon2id, com migração automática do hash antigo no login;
- verificação em duas etapas (TOTP) com códigos de recuperação;
- confirmação de senha antes de ações críticas;
- bloqueio progressivo por conta;
- auditoria e proteção CSRF por Fetch Metadata.

As telas de administração e de "Minha conta" estão em `src/admin` e `src/account`.

## Créditos

Emojis das reações: [Twemoji](https://github.com/jdecked/twemoji), de Twitter, Inc. e colaboradores, licença CC-BY 4.0 (gráficos). Fontes: Poppins (OFL) e Spline Sans Mono (OFL), servidas pelo app. Conversão de PDF em slides: [pdf.js](https://mozilla.github.io/pdf.js/) (Apache 2.0).

## Solução de problemas

**A tela mostra "Iniciar exibição".** É de propósito: o navegador só libera tela cheia, som e tela sempre ligada depois de um clique. Clique uma vez no computador da projeção; ao recarregar a página, o portão volta.

**Versão nova publicada com o telão aberto.** O telão é uma moldura que fica em tela cheia, com o conteúdo num iframe. A cada minuto ela confere a versão publicada; com versão nova, o conteúdo novo carrega por trás e assume numa fusão, sem recarregar a página: tela cheia, som liberado e tela ligada continuam, e a plateia não percebe. Com vídeo ou página web no ar, a troca espera a próxima cena sem som. Um telão aberto antes da moldura precisa ser recarregado à mão uma vez (<kbd>F5</kbd> e "Iniciar exibição").

**Vídeo do YouTube.** Na cena Vídeo, use "Usar URL" e cole o link (watch, youtu.be, shorts ou live): o telão toca no player do YouTube e os botões Tocar, Pausar e Voltar ao início do console comandam o player. No console aparece só um aviso, como na página web. Para mostrar o YouTube sem os controles do console, use a cena Página web.

**Vídeo sem som no telão.** O som só sai depois do clique em "Iniciar exibição". Confira também a saída de áudio do sistema (HDMI) e o volume.

**A tela apaga no meio do evento.** Manter a tela ligada só funciona em HTTPS ou em `localhost`. Em HTTP pela rede local, desative a suspensão do computador da projeção.

**Celulares não abrem o endereço.** Confira se estão na mesma rede do notebook; redes de convidados costumam isolar os aparelhos entre si. Libere a porta 5173 no firewall do notebook no `pnpm dev`.

**"Sem conexão. Tentando reconectar…" no celular.** O tempo real volta sozinho quando a rede volta; enquanto isso, os botões de envio ficam desabilitados.

**Abas do evento param de atualizar.** Em HTTP simples o navegador mantém no máximo 6 conexões por endereço, e cada aba do evento usa uma para o tempo real. Feche abas que não estão em uso.
