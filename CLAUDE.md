# deck.slides

Gerenciador de perguntas e conteúdo para eventos ao vivo. Três superfícies, interface em pt-BR:

| Superfície | URL | Acesso |
|---|---|---|
| Console do moderador | `/entrar`, `/eventos`, `/eventos/K7QX2M/…` | e-mail + senha (sessão assinada, validada no servidor) |
| Página do participante (celular) | `/convite/<token>` (pessoal) e `/e/K7QX2M` (página do evento / entrada aberta) | convite ou nome, mais o PIN do evento |
| Tela do evento (telão) | `/tela` (pareamento por código) ou `/tela/K7QX2M` (com sessão de moderador) | código digitado no console; nenhum segredo na URL |

Cada evento tem um **código curto** (6 caracteres, alfabeto Crockford sem I/L/O/U) que é o seu id em todas as URLs.

**Antes de mexer na interface, leia `DESIGN.md`.** Ele tem os tokens, os componentes, as regras de texto e a lista do que é proibido (emoji, gradientes, padrões de interface genérica).

## Rodar

```
pnpm install
pnpm dev        # Vite (5173, também na rede local) + API em node --watch (3000)
pnpm test       # node --test: fluxo completo da API + gerador de paleta
pnpm check      # tsc -p . (SPA) && tsc -p server (Node)
pnpm build && pnpm start   # produção: um processo serve API + front em :3000
```

Variáveis: `PORT`, `DATA_DIR` (padrão `./data`, com SQLite e uploads), `PUBLIC_URL` (base dos links de convite e de pareamento, quando o endereço público difere do local), `SESSION_SECRET`, `SETUP_TOKEN` (obrigatório em produção para criar a conta inicial), `TRUST_PROXY=1` (atrás de proxy reverso, para o IP real nos limites de tentativas), `MAX_UPLOAD_MB`.

## Arquitetura

- **Servidor** (`server/`): Node 24 executa TypeScript direto (sem build). Hono + SQLite nativo (`node:sqlite`). Só sintaxe TS apagável (sem `enum`, `namespace` ou parameter properties). Imports relativos **com `.ts`**.
- **Tempo real**: SSE. Cada conexão recebe o **snapshot completo** da sua audiência (`state`), totais de reações/curtidas (`counts`, até 4 por segundo) e `ping` com o relógio do servidor. Comandos chegam por POST. Moderação e tela recebem em até 40 ms; celulares, em até 500 ms. `server/hub.ts`.
- **Contrato** (`shared/types.ts`): tipos e funções puras usados dos dois lados. Cronômetro e vídeo são carimbos de tempo do servidor (`timerElapsed`, `playbackPosition`); o cliente corrige o relógio com `offset`.
- **Paleta do evento** (`shared/screen-theme.ts`): uma cor de marca entra e saem 12 tokens com contraste WCAG garantido. Testado em `shared/screen-theme.test.ts`.
- **Cliente** (`src/`): React 19, React Router 8 (modo declarativo, uma rota preguiçosa por superfície), Tailwind 4 com tokens próprios, Base UI (headless) por trás de `src/ui`, ícones Phosphor importados por ícone.
- `src/stage/Stage.tsx` é o **único** renderizador do que vai para a tela: telão, monitores do console e pré-visualização da aparência usam o mesmo componente.
- Console: `EventLayout` abre o stream e fornece `useEvent()` (snapshot, counts, offset, links) às páginas. Comandos via `run(() => post(...))`; a interface só reflete o que o servidor confirmar no próximo snapshot.

## Convenções

- Menos código: recurso nativo antes de dependência (`<input type="color">`, `EventSource`, `FontFace`, Wake Lock).
- Comentários em português, curtos, explicando o porquê.
- Toda entrada externa passa por zod no servidor. Erros para o usuário em pt-BR: o que aconteceu + o que fazer. Erro 500 nunca expõe detalhes (ficam no log).
- Segurança: sessões com data de emissão e época (troca de senha / novo link derrubam sessões antigas), limites de tentativas por IP, CSRF, CSP e cabeçalhos via `secureHeaders`, uploads com extensão derivada do tipo e servidos com `sandbox` + `nosniff`, nada fora de `dist/` e `data/uploads` é servido. No `pnpm dev`, o Vite nega acesso a `server/`, `data/`, `.env` e arquivos de configuração.
- Testes: `server/tests/*.test.ts` chamam a aplicação em processo (`app.request`) com banco temporário; `flow.test.ts` sobe o servidor real. Toda mudança de comportamento vem com teste de sucesso e de falha.
- Não adicione dependências sem necessidade real.
