// Verificação da cena "Página web": o site aceita aparecer dentro de outra página? Muitos recusam
// (X-Frame-Options, CSP frame-ancestors ou bloqueio de robôs com 403) e o telão mostraria o erro do navegador.
// Lê só os cabeçalhos. Contra SSRF: só https, e o endereço resolvido é conferido na conexão (DNS que troca de
// IP entre a checagem e a conexão não passa), sem rede interna, local ou de metadados.
import { lookup, type LookupAddress } from 'node:dns'
import { request } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'

import type { EmbedCheck } from '../shared/types.ts'

const PRIVATE = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // metadados da nuvem
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3], // multicast e reservados
] as const)
  PRIVATE.addSubnet(net, bits, 'ipv4')
for (const [net, bits] of [
  ['::', 127], // :: e ::1
  ['64:ff9b::', 96], // NAT64: aponta para IPv4 (pode ser interno)
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  PRIVATE.addSubnet(net, bits, 'ipv6')

export function isPrivate(ip: string): boolean {
  // IPv4 escrito como IPv6 (::ffff:127.0.0.1 ou ::ffff:7f00:1): confere o IPv4. Uma faixa ::ffff:0:0/96
  // no BlockList pegaria todo IPv4, porque ele compara IPv4 nessa forma.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mapped) return PRIVATE.check(mapped[1]!, 'ipv4')
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip)
  if (hex) {
    const [a, b] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)]
    return PRIVATE.check(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`, 'ipv4')
  }
  const family = isIP(ip)
  return family === 0 || PRIVATE.check(ip, family === 4 ? 'ipv4' : 'ipv6')
}

// Resolve e recusa a conexão se algum endereço for interno (o Node pode pedir um ou todos).
export const guardedLookup: LookupFunction = (host, options, done) =>
  lookup(host, { ...options, all: true }, (err, list: LookupAddress[]) => {
    if (err) return done(err, '', 0)
    if (!list.length || list.some((a) => isPrivate(a.address))) return done(Object.assign(new Error('endereço interno'), { code: 'EPRIVATE' }), '', 0)
    if (options.all) return done(null, list)
    done(null, list[0]!.address, list[0]!.family)
  })

/** Cabeçalhos dizem que o site recusa ser exibido dentro de outro site? */
export function framingBlocked(headers: Record<string, string | string[] | undefined>): boolean {
  const xfo = String(headers['x-frame-options'] ?? '').trim().toLowerCase()
  if (xfo === 'deny' || xfo === 'sameorigin' || xfo.startsWith('allow-from')) return true
  const csp = [headers['content-security-policy'] ?? []].flat().join(',')
  const ancestors = /(?:^|[;,])\s*frame-ancestors\s+([^;,]*)/i.exec(csp)?.[1]?.trim().split(/\s+/)
  return !!ancestors && !ancestors.some((s) => s === '*' || s === 'https:')
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'

function head(url: URL, timeoutMs: number) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET', // muitos sites respondem HEAD diferente do que o navegador recebe
        lookup: guardedLookup,
        timeout: timeoutMs,
        headers: { 'user-agent': UA, accept: 'text/html', 'accept-language': 'pt-BR', 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate' },
      },
      (res) => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers })
        res.destroy() // o corpo não interessa
      },
    )
    req.on('timeout', () => req.destroy(new Error('tempo esgotado')))
    req.on('error', reject)
    req.end()
  })
}

const site = (u: URL) => u.hostname.replace(/^www\./, '')

/**
 * Segue até 4 redirecionamentos (cada um por https e conferido de novo; redirecionamento para http vira https,
 * como o navegador faz na tela, onde só https carrega). null = não deu para saber.
 */
export async function checkEmbed(raw: string, timeoutMs = 6000): Promise<EmbedCheck> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { embeddable: null }
  }
  if (url.protocol !== 'https:') return { embeddable: null }
  const start = url
  // Endereço final, só se for o mesmo site (www, https): nunca troca a cena por uma página de login de outro domínio.
  const final = () => (url.href !== start.href && site(url) === site(start) ? { url: url.href } : {})
  for (let hop = 0; hop <= 4; hop++) {
    if (url.protocol !== 'https:' || url.username || url.password) return { embeddable: null }
    // IP digitado direto não passa pelo DNS (nem pelo lookup acima): confere aqui.
    const literal = url.hostname.replace(/^\[|\]$/g, '')
    if (isIP(literal) && isPrivate(literal)) return { embeddable: null }
    let res
    try {
      res = await head(url, timeoutMs)
    } catch {
      return { embeddable: null }
    }
    if (framingBlocked(res.headers)) return { embeddable: false, reason: 'blocked', ...final() }
    const location = res.headers.location
    if (res.status >= 300 && res.status < 400 && typeof location === 'string') {
      url = new URL(location, url)
      if (url.protocol === 'http:') url.protocol = 'https:'
      continue
    }
    if (res.status >= 400) return { embeddable: false, reason: 'refused', status: res.status, ...final() }
    return { embeddable: true, ...final() }
  }
  return { embeddable: null }
}
