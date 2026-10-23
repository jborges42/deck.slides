// Moldura do telão: versão nova publicada troca só o conteúdo (iframe), sem recarregar a página. A tela cheia e a
// página continuam; vídeo ou página web no ar adiam a troca; a recarga inteira das versões sem moldura volta direto à
// exibição. Rodar com `pnpm test:e2e`. O relógio da página é simulado para não esperar o minuto entre as conferências.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { BrowserContext, Page } from 'playwright-core'
import { setupModerator, start, watchErrors, type Env } from './harness.ts'

let env: Env
let console_: BrowserContext
let page: Page
before(async () => {
  env = await start()
  console_ = await env.desktop()
  page = await console_.newPage()
  await setupModerator(page)
})
after(() => env?.close())

const ACTIVE = 'iframe[data-quadro="ativo"]'

async function api(method: string, path: string, data?: unknown) {
  const r = await page.request.fetch(`/api${path}`, { method, data, headers: { origin: env.base } })
  assert.ok(r.ok(), `${method} ${path} -> ${r.status()} ${await r.text()}`)
  return r.json()
}

/** Telão aberto pela sessão do console, num computador de projeção (1920 × 1080). */
async function projector(id: string) {
  const context = await env.projector()
  await context.addCookies(await console_.cookies())
  const tela = await context.newPage()
  return { context, tela, view: tela.frameLocator(ACTIVE), url: `/tela/${id}` }
}

/** Avança o relógio simulado em passos até a condição valer. */
async function pump(tela: Page, what: string, ok: () => Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    if (await ok().catch(() => false)) return
    await tela.clock.runFor(200)
    await tela.waitForTimeout(20)
  }
  assert.fail(what)
}

test('versão nova troca só o conteúdo: a página e a tela cheia continuam; página web no ar adia a troca', async () => {
  const { id } = (await api('POST', '/events', { name: 'Conexão Profissional' })) as { id: string }
  const { context, tela, view, url } = await projector(id)
  const errors = watchErrors(tela, [/example\.com/])
  await tela.clock.install()
  await tela.goto(url)
  await view.getByRole('button', { name: 'Iniciar exibição' }).click()
  await view.getByText('Conexão Profissional').first().waitFor()
  // Texto, não função: o tsconfig do e2e não tem os tipos do navegador.
  const fullscreen = () => tela.evaluate<boolean>('!!document.fullscreenElement')
  assert.equal(await fullscreen(), true, 'o portão não pôs a moldura em tela cheia')
  await tela.evaluate(() => Object.assign(globalThis, { moldura: true })) // some se a página recarregar
  const sameShell = () => tela.evaluate(() => 'moldura' in globalThis)
  const frames = () => tela.locator('iframe').count()
  const markActive = () => view.locator('body').evaluate(() => Object.assign(globalThis, { antigo: true }))
  const swapped = async () => (await frames()) === 1 && (await view.locator('body').evaluate(() => !('antigo' in globalThis)))

  // Mesma versão: confere e não cria iframe.
  const checked = tela.waitForResponse((r) => r.request().resourceType() === 'fetch' && r.url().endsWith(url))
  await tela.clock.runFor(61_000)
  await checked
  await tela.waitForTimeout(300)
  assert.equal(await frames(), 1)

  // Versão nova: outro script principal no index.html, só na conferência (o iframe novo recebe o index.html real).
  let version = 0
  await tela.route(`**${url}`, async (route) => {
    if (route.request().resourceType() !== 'fetch') return route.fallback()
    const res = await route.fetch()
    await route.fulfill({ response: res, body: (await res.text()).replace(/\/assets\/index-[\w-]+\.js/, `/assets/index-nova${version}.js`) })
  })

  // Tela de espera da marca no ar (cena calma): a versão nova assume numa fusão.
  await markActive()
  version = 1
  await tela.clock.runFor(61_000)
  await pump(tela, 'a versão nova não assumiu', swapped)
  assert.equal(await sameShell(), true, 'a página recarregou')
  assert.equal(await fullscreen(), true, 'a troca saiu da tela cheia')
  await view.getByText('Conexão Profissional').first().waitFor()
  assert.equal(await view.getByRole('button', { name: 'Iniciar exibição' }).count(), 0)

  // Página web no ar: a versão nova carrega por trás e espera; com uma cena calma, assume.
  const site = (await api('POST', `/events/${id}/scenes`, { type: 'embed', name: 'Site', content: { url: 'https://example.com/' } })) as { id: string }
  await api('POST', `/events/${id}/live`, { op: 'preview', sceneId: site.id })
  await api('POST', `/events/${id}/live`, { op: 'take' })
  await view.locator('iframe').first().waitFor()
  await markActive()
  version = 2
  await tela.clock.runFor(61_000)
  await pump(tela, 'a versão nova não carregou por trás', async () => (await tela.locator('iframe[data-quadro="carregando"]').count()) === 1)
  await tela.clock.runFor(5000)
  await tela.waitForTimeout(500)
  assert.equal(await frames(), 2, 'trocou com a página web no ar')
  await api('POST', `/events/${id}/live`, { op: 'standby', on: true })
  await pump(tela, 'a versão nova não assumiu depois da cena calma', swapped)
  assert.equal(await sameShell(), true, 'a página recarregou')
  assert.equal(await fullscreen(), true, 'a troca saiu da tela cheia')

  await tela.unrouteAll()
  assert.deepEqual(errors, [])
  await context.close()
})

test('recarga inteira de uma versão sem moldura volta direto à exibição, sem o portão', async () => {
  const { id } = (await api('POST', '/events', { name: 'Conexão Profissional' })) as { id: string }
  const { context, tela, view, url } = await projector(id)
  const errors = watchErrors(tela)
  // A versão anterior deixava esta marca antes de recarregar a página inteira (só na página de cima, uma vez).
  await tela.addInitScript(
    "if (window === window.top && !sessionStorage.getItem('deck:marcado')) { sessionStorage.setItem('deck:marcado', '1'); sessionStorage.setItem('deck:tela-retomar', '1') }",
  )
  await tela.goto(url)
  await view.getByText('Conexão Profissional').first().waitFor()
  assert.equal(await view.getByRole('button', { name: 'Iniciar exibição' }).count(), 0)

  // Sem a marca (abrir a tela normalmente), o portão aparece.
  await tela.reload()
  await view.getByRole('button', { name: 'Iniciar exibição' }).waitFor()
  assert.deepEqual(errors, [])
  await context.close()
})
