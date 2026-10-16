// Aplicação HTTP (sem abrir porta): usada pelo servidor (index.ts), pela função da Vercel (vercel.ts) e pelos testes.
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { csrf } from 'hono/csrf'
import { HTTPException } from 'hono/http-exception'
import { secureHeaders } from 'hono/secure-headers'
import { fileURLToPath } from 'node:url'
import { get, UPLOADS_DIR } from './db.ts'
import { ROBOTS, securityHeaders } from './headers.ts'
import { BadRequest, moderator } from './moderator.ts'
import { pub } from './public.ts'

const production = process.env.NODE_ENV === 'production'
const blob = !!process.env.BLOB_READ_WRITE_TOKEN
export const app = new Hono()

// Cabeçalhos de arquivo servido vão depois de next(): o onFound do serveStatic roda com a resposta já criada e se perde.
const cache = (value: string): MiddlewareHandler => async (c, next) => {
  await next()
  if (c.res.ok) c.header('Cache-Control', value)
}

// Mídia enviada. Registrado antes de secureHeaders (que grava os dele depois de next()) para que esta CSP prevaleça.
app.use('/media/*', cache('public, max-age=31536000, immutable'), async (c, next) => {
  await next()
  if (!c.res.ok) return
  // Arquivo enviado nunca roda como página (ex.: SVG com script aberto direto no navegador).
  c.header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox")
  if (c.req.path.endsWith('.mov')) c.header('Content-Type', 'video/quicktime') // fora da tabela de tipos do serveStatic
})

app.use('*', secureHeaders(securityHeaders(production, blob)), async (c, next) => {
  await next()
  c.header('X-Robots-Tag', ROBOTS)
})

// JSON pequeno em todas as rotas, menos o upload (que grava em disco por streaming com limite próprio).
const jsonLimit = bodyLimit({
  maxSize: 2 * 1024 * 1024,
  onError: (c) => c.json({ error: 'Requisição grande demais.' }, 413),
})
app.use('/api/*', (c, next) => (c.req.method === 'POST' && c.req.path.endsWith('/media') ? next() : jsonLimit(c, next)))
app.use('/api/*', csrf())
// Verificação de saúde (HEALTHCHECK do Docker, proxy): só confirma que o processo responde, sem versão nem detalhes.
app.route('/api', pub)
app.route('/api', moderator)
app.all('/api/*', (c) => c.json({ error: 'Rota não encontrada.' }, 404))

// Vercel Blob: o arquivo mora em outro domínio (que não lê os cookies daqui). /media/<evento>/<arquivo> continua
// sendo o endereço gravado nas cenas e no tema, e redireciona para lá.
if (blob)
  app.get('/media/:event/:file', async (c, next) => {
    const m = await get<{ blob_url: string | null }>('SELECT blob_url FROM media WHERE event_id = ? AND file = ?', c.req.param('event'), c.req.param('file'))
    if (!m?.blob_url) return next()
    c.header('Cache-Control', 'public, max-age=31536000, immutable')
    return c.redirect(m.blob_url, 302)
  })

// Arquivos enviados; cache e CSP ficam no middleware do topo.
app.use('/media/*', serveStatic({ root: UPLOADS_DIR, rewriteRequestPath: (p) => p.replace(/^\/media/, '') }))
app.all('/media/*', (c) => c.text('Não encontrado.', 404))

// Em produção o mesmo processo serve o front-end compilado (SPA). Só a pasta dist/ é pública.
// Na Vercel, quem serve o front é a CDN (scripts/vercel-build.ts).
if (production && !process.env.VERCEL) {
  const dist = fileURLToPath(new URL('../dist', import.meta.url))
  app.use('/assets/*', cache('public, max-age=31536000, immutable'), serveStatic({ root: dist }))
  app.get('/assets/*', (c) => c.text('Não encontrado.', 404))
  // A página (inclusive "/" e o fallback da SPA) sempre revalida: um deploy novo troca os nomes dos assets.
  app.use('/*', cache('no-cache'), serveStatic({ root: dist }))
  // Caminho com extensão que não existe em dist/ é 404: nunca devolve index.html para "/package.json".
  app.get('*', (c, next) => (/\.[a-z0-9]+$/i.test(c.req.path) ? c.text('Não encontrado.', 404) : next()))
  app.get('*', serveStatic({ path: `${dist}/index.html` }))
}

app.notFound((c) => c.text('Não encontrado.', 404))

app.onError((err, c) => {
  if (err instanceof BadRequest) return c.json({ error: err.message }, 400)
  if (err instanceof HTTPException) {
    // Recusa do framework (ex.: CSRF) no mesmo formato das demais: JSON em pt-BR, sem detalhes internos.
    if (!c.req.path.startsWith('/api/')) return err.getResponse()
    const error = err.status === 403 ? 'Requisição recusada. Recarregue a página e tente de novo.' : 'Não foi possível concluir. Tente novamente.'
    return c.json({ error }, err.status)
  }
  // Detalhes ficam no log do servidor; o cliente recebe uma mensagem genérica.
  console.error(`[${new Date().toISOString()}] ${c.req.method} ${c.req.path}`, err)
  return c.json({ error: 'Erro interno. Tente novamente.' }, 500)
})
