// Cabeçalhos de segurança. Os mesmos no servidor Node (app.ts) e nas páginas estáticas que a CDN da Vercel
// entrega sem passar pela função (scripts/vercel-build.ts os copia para o config.json da Build Output API).
import type { secureHeaders } from 'hono/secure-headers'

type Options = NonNullable<Parameters<typeof secureHeaders>[0]>

/** Páginas do telão: a moldura mostra o conteúdo num iframe da mesma origem (src/screen/Screen.tsx). */
const TELA = /^\/tela(\/|$)/

/** `blob`: mídia no Vercel Blob (outro domínio) e envio direto do navegador para a API dele. */
export function securityHeaders(production: boolean, blob: boolean): Options {
  const blobFiles = blob ? ['https://*.public.blob.vercel-storage.com'] : []
  return {
    // Em desenvolvimento o Vite injeta scripts inline; a CSP vale para o build de produção.
    contentSecurityPolicy: production
      ? {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', ...blobFiles],
          imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
          mediaSrc: ["'self'", 'blob:', 'https:'],
          frameSrc: ["'self'", 'https:'], // moldura do telão (também em http na rede local) e cena "Página web"
          connectSrc: ["'self'", ...(blob ? ['https://vercel.com'] : [])],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          // Só o telão entra num iframe, e só no da própria moldura; as demais páginas, em nenhum.
          frameAncestors: [(c) => (TELA.test(c.req.path) ? "'self'" : "'none'")],
        }
      : undefined,
    referrerPolicy: 'same-origin', // tokens de convite não vazam para sites externos (fontes, embeds)
    crossOriginEmbedderPolicy: false, // imagens e vídeos externos nas cenas
    permissionsPolicy: { camera: [], microphone: [], geolocation: [], payment: [], usb: [] },
  }
}

export const ROBOTS = 'noindex, nofollow' // convites e eventos não devem aparecer em buscadores
