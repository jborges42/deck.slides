// Apresentação em PDF e console aberto antes de um deploy: cada deploy troca o nome dos arquivos sob demanda (pdf.js,
// páginas do console) e os da versão anterior somem do servidor. Aqui o "deploy" é simulado devolvendo 404 a eles.
// Rodar com `pnpm test:e2e`.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { BrowserContext, Page } from 'playwright-core'
import { setupModerator, start, type Env } from './harness.ts'

let env: Env
let session: Awaited<ReturnType<BrowserContext['storageState']>> // a conta inicial só pode ser criada uma vez
before(async () => {
  env = await start()
  const ctx = await env.desktop()
  await setupModerator(await ctx.newPage())
  session = await ctx.storageState()
  await ctx.close()
})
after(() => env?.close())

const PDF_CHUNK = /\/assets\/pdf-[\w-]+\.js$/

/** PDF de 3 páginas 16:9, como o exportado do PowerPoint, do Keynote ou do Canva. */
async function deck(): Promise<Buffer> {
  const page = await env.browser.newPage()
  await page.setContent(
    `<style>@page{margin:0}body{margin:0}section{width:1920px;height:1080px;display:grid;place-items:center;font:bold 180px sans-serif;break-after:page}</style>` +
      [1, 2, 3].map((n) => `<section>Slide ${n}</section>`).join(''),
  )
  const pdf = await page.pdf({ width: '1920px', height: '1080px' })
  await page.close()
  return pdf
}

/** Console com uma apresentação vazia na prévia. */
async function consoleWithSlides(onBeforeOpen?: (page: Page) => Promise<unknown>) {
  const ctx = await env.browser.newContext({ baseURL: env.base, viewport: { width: 1440, height: 900 }, locale: 'pt-BR', storageState: session })
  const page = await ctx.newPage()
  const headers = { origin: env.base }
  const { id } = (await (await page.request.post('/api/events', { data: { name: 'Conexão Profissional' }, headers })).json()) as { id: string }
  const scene = (await (await page.request.post(`/api/events/${id}/scenes`, { data: { type: 'slides', content: { slides: [] } }, headers })).json()) as { id: string }
  await page.request.post(`/api/events/${id}/live`, { data: { op: 'preview', sceneId: scene.id }, headers })
  await onBeforeOpen?.(page)
  await page.goto(`/eventos/${id}`)
  await page.getByRole('button', { name: 'Enviar apresentação' }).waitFor()
  const live = (cmd: object) => page.request.post(`/api/events/${id}/live`, { data: cmd, headers })
  return { page, id, live }
}

const send = async (page: Page) =>
  page.locator('input[type=file][accept^="application/pdf"]').setInputFiles({ name: 'Educação financeira.pdf', mimeType: 'application/pdf', buffer: await deck() })

test('PDF enviado depois de um deploy: vira slides, vai ao ar e passa pelo teclado e pelos botões', async () => {
  // Sem a correção, o pdf.js só seria pedido no envio: espera um pouco e segue para mostrar o sintoma real.
  let loaded: Promise<unknown> = Promise.resolve()
  const { page, live } = await consoleWithSlides(async (p) => {
    loaded = p.waitForResponse((r) => PDF_CHUNK.test(r.url()), { timeout: 10_000 }).catch(() => null)
  })
  await loaded
  await page.route(PDF_CHUNK, (route) => route.fulfill({ status: 404, body: 'Não encontrado.' })) // o deploy
  await send(page)
  await page.getByText('3 slides', { exact: true }).waitFor() // salvo: a linha do roteiro vem do servidor
  assert.ok((await page.getByText('Educação financeira', { exact: true }).count()) > 0) // a cena ganhou o nome do arquivo

  await live({ op: 'take' })
  // O monitor No ar usa o mesmo palco do telão. A imagem tem de carregar de verdade, não só existir.
  const shown = async (alt: string) => {
    const img = `section[aria-label="No ar"] img[alt="${alt}"]`
    await page.locator(img).waitFor()
    assert.ok(await page.evaluate<boolean>(`(async (img) => { await img.decode(); return img.naturalWidth > 0 })(document.querySelector('${img}'))`))
  }
  await shown('Slide 1 de 3')
  await page.evaluate('document.activeElement?.blur()') // atalhos não valem com foco em campo
  await page.keyboard.press('ArrowRight')
  await shown('Slide 2 de 3')
  await page.keyboard.press('PageDown') // passador
  await shown('Slide 3 de 3')
  await page.getByRole('button', { name: 'Anterior' }).click()
  await shown('Slide 2 de 3')
})

test('sem o leitor de PDF (fora do ar), o envio avisa em português e a apresentação continua vazia', async () => {
  const { page } = await consoleWithSlides((p) => p.route(PDF_CHUNK, (route) => route.abort('internetdisconnected')))
  await send(page)
  await page.getByText('Não foi possível carregar o leitor de PDF. Recarregue a página e envie o arquivo de novo.').waitFor()
  assert.equal(await page.getByText('Apresentação sem slides').count(), 1)
  assert.equal(await page.getByRole('button', { name: 'Enviar apresentação' }).isEnabled(), true)
})

/** Abre a página Mídia com o arquivo dela sumido do servidor; `deployed`: o index.html já aponta outra versão. */
async function openMediaAfter(deployed: boolean) {
  const { page } = await consoleWithSlides()
  await page.evaluate(() => Object.assign(globalThis, { antes: true })) // some se a página recarregar
  let gone = true // o arquivo da página Mídia volta junto com a conferência de versão: a recarga recebe o real
  await page.route(/\/assets\/Media-[\w-]+\.js$/, (route) => (gone ? route.fulfill({ status: 404, body: 'Não encontrado.' }) : route.fallback()))
  await page.route(
    (url) => url.pathname === '/',
    async (route) => {
      gone = false
      const res = await route.fetch()
      const html = await res.text()
      await route.fulfill({ response: res, body: deployed ? html.replace(/\/assets\/index-[\w-]+\.js/, '/assets/index-nova.js') : html })
    },
  )
  const checked = page.waitForResponse((r) => new URL(r.url()).pathname === '/')
  await page.getByRole('link', { name: 'Mídia' }).click()
  await checked
  return page
}

test('console aberto antes de um deploy: abrir outra página recarrega na versão nova em vez de ficar em branco', async () => {
  const page = await openMediaAfter(true)
  await page.getByRole('heading', { name: 'Mídia' }).waitFor()
  assert.equal(await page.evaluate(() => 'antes' in globalThis), false)
  assert.match(page.url(), /\/midia$/)
})

test('arquivo sumido sem versão nova publicada: não recarrega (nada de recarga em laço)', async () => {
  const page = await openMediaAfter(false)
  await page.waitForTimeout(1000)
  assert.equal(await page.evaluate(() => 'antes' in globalThis), true)
})
