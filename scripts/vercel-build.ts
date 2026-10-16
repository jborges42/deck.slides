// Build para a Vercel (Build Output API v3): o front compilado vai para a CDN e a API vira uma função Node
// empacotada num arquivo só. É o buildCommand do vercel.json (`pnpm build:vercel`).
// Gerar a saída pronta evita depender de como a Vercel compilaria o servidor (TypeScript com imports .ts).
import { cpSync, rmSync, writeFileSync } from 'node:fs'
import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import { build } from 'vite'
import { ROBOTS, securityHeaders } from '../server/headers.ts'

export const OUT = '.vercel/output'
const FUNC = `${OUT}/functions/api.func`
// Com Fluid compute, 300 s cabe em todos os planos. O SSE se despede 20 s antes e o navegador reabre na hora.
const MAX_DURATION = 300

rmSync(OUT, { recursive: true, force: true })

// Front: o mesmo build do `pnpm build`.
await build({ logLevel: 'warn' })
cpSync('dist', `${OUT}/static`, { recursive: true })

// API: ESM com as dependências dentro. O libSQL vai na versão só HTTP (fala com o Turso, sem binário nativo).
await build({
  configFile: false,
  publicDir: false,
  logLevel: 'warn',
  resolve: { alias: [{ find: /^@libsql\/client$/, replacement: '@libsql/client/web' }] },
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: 'server/vercel.ts',
    outDir: FUNC,
    emptyOutDir: true,
    target: 'node24',
    minify: false,
    chunkSizeWarningLimit: 8192, // roda no servidor: o tamanho não pesa como no navegador
    rolldownOptions: { output: { entryFileNames: 'index.mjs', codeSplitting: false } },
  },
})
writeFileSync(
  `${FUNC}/.vc-config.json`,
  JSON.stringify(
    {
      runtime: 'nodejs24.x',
      handler: 'index.mjs',
      launcherType: 'Nodejs',
      supportsResponseStreaming: true, // SSE
      maxDuration: MAX_DURATION,
      environment: { NODE_ENV: 'production', STREAM_MAX_S: String(MAX_DURATION - 20) },
    },
    null,
    2,
  ),
)

// Páginas estáticas saem da CDN sem passar pela função: levam os mesmos cabeçalhos que o app.ts põe nas respostas.
const probe = new Hono().use(secureHeaders(securityHeaders(true, true))).get('/', (c) => c.body(null))
const headers = { ...Object.fromEntries((await probe.request('/')).headers), 'x-robots-tag': ROBOTS }

writeFileSync(
  `${OUT}/config.json`,
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '^/(?!api/|media/).*', headers, continue: true },
        // Nome com hash: um deploy novo troca o arquivo, então pode ficar em cache para sempre.
        { src: '^/assets/.*', headers: { 'cache-control': 'public, max-age=31536000, immutable' }, continue: true },
        { handle: 'filesystem' },
        // API e mídia: a função, que recebe o caminho original.
        { src: '^/(api|media)/.*', dest: '/api' },
        // SPA: caminho sem extensão vira index.html; com extensão e sem arquivo, 404 (nunca index.html para "/x.json").
        { src: '^/[^.]*$', dest: '/index.html' },
      ],
    },
    null,
    2,
  ),
)
console.info(`Saída da Vercel em ${OUT}`)
