// Barreira contra CSRF por Fetch Metadata (OWASP CSRF Cheat Sheet), para /api. Complementa o cookie SameSite=Lax
// (que já não vai em POST de outro site) e o csrf() do Hono (que só olha formulários: urlencoded, multipart,
// text/plain). Esta camada recusa qualquer escrita de outra origem, inclusive JSON e DELETE.
import type { Context, MiddlewareHandler } from 'hono'

const SAFE_METHOD = /^(GET|HEAD|OPTIONS)$/

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return null // inclui "Origin: null" (iframe com sandbox, redirecionamentos)
  }
}

function sameHost(c: Context, origin: string): boolean {
  const host = hostOf(origin)
  if (!host) return false
  const own = (c.req.header('host') ?? new URL(c.req.url).host).toLowerCase()
  return host === own || (!!process.env.PUBLIC_URL && host === hostOf(process.env.PUBLIC_URL))
}

/**
 * Métodos que alteram estado (POST, PUT, PATCH, DELETE...):
 * - navegador moderno manda Sec-Fetch-Site: só "same-origin" passa ("none" é navegação digitada, só GET);
 * - navegador antigo, sem Sec-Fetch-Site: Origin, se vier, precisa ter o host da requisição (ou o de PUBLIC_URL);
 * - sem nenhum dos dois (curl, servidor a servidor, testes): passa; não há navegador para ser enganado.
 * GET, HEAD e OPTIONS sempre passam.
 */
export const fetchMetadata: MiddlewareHandler = async (c, next) => {
  if (!SAFE_METHOD.test(c.req.method)) {
    const site = c.req.header('sec-fetch-site')
    const origin = c.req.header('origin')
    const allowed = site !== undefined ? site === 'same-origin' : origin === undefined || sameHost(c, origin)
    if (!allowed)
      return c.json(
        { error: 'Pedido recusado porque veio de fora do deck.slides. Abra o sistema pelo endereço de sempre e tente de novo.', code: 'forbidden' },
        403,
      )
  }
  await next()
}
