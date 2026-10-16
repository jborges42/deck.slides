// Entrada na Vercel: uma função Node recebe /api/* e /media/*; o front compilado sai pela CDN.
// Empacotada por scripts/vercel-build.ts (Build Output API).
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import { configErrors, configWarnings } from './config.ts'

// Configuração inválida derruba a função na inicialização: o motivo aparece no log da Vercel.
const errors = configErrors()
if (errors.length) throw new Error(`Configuração inválida: ${errors.join(' ')}`)
for (const w of configWarnings()) console.warn(`Aviso: ${w}`)

const { app } = await import('./app.ts')
const listener = getRequestListener(app.fetch)

export default function handler(req: IncomingMessage, res: ServerResponse) {
  // A Vercel termina o HTTPS antes da função. Sem isto o app veria http:// e o CSRF recusaria todo POST
  // (Origin https:// diferente da URL). URL absoluta: o adaptador a usa como está.
  if (req.headers['x-forwarded-proto'] === 'https' && req.url?.startsWith('/')) req.url = `https://${req.headers.host}${req.url}`
  return listener(req, res)
}
