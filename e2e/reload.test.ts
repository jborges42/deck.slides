// Telão aberto antes de uma versão nova: fora da tela cheia, recarrega sozinho e volta direto à exibição, sem o portão;
// em tela cheia, espera (a página recarregada voltaria fora dela). Rodar com `pnpm test:e2e`. O relógio da página é
// simulado para não esperar o minuto entre as conferências.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { setupModerator, start, type Env } from './harness.ts'

let env: Env
before(async () => {
  env = await start()
})
after(() => env?.close())

test('versão nova publicada: em tela cheia o telão espera; fora dela recarrega sozinho e volta à exibição', async () => {
  const console_ = await env.desktop()
  const page = await console_.newPage()
  await setupModerator(page)
  const created = await page.request.fetch('/api/events', { method: 'POST', data: { name: 'Conexão Profissional' }, headers: { origin: env.base } })
  const { id } = (await created.json()) as { id: string }

  const projector = await env.browser.newContext({ baseURL: env.base, viewport: { width: 1920, height: 1080 }, storageState: await console_.storageState() })
  const tela = await projector.newPage()
  await tela.clock.install()
  await tela.goto(`/tela/${id}`)
  await tela.getByRole('button', { name: 'Iniciar exibição' }).click()
  await tela.getByText('Conexão Profissional').first().waitFor()
  await tela.evaluate(() => Object.assign(globalThis, { antes: true })) // some se a página recarregar
  const same = () => tela.evaluate(() => 'antes' in globalThis)

  /** Avança até a próxima conferência e espera a resposta (e o que ela decidir). */
  const nextCheck = async () => {
    const checked = tela.waitForResponse((r) => r.request().resourceType() === 'fetch' && r.url().endsWith(`/tela/${id}`))
    await tela.clock.runFor(61_000)
    await checked
    await tela.waitForTimeout(300)
  }

  // Mesma versão: confere e continua na mesma página.
  await nextCheck()
  assert.equal(await same(), true)

  // Versão nova: o index.html passa a apontar outro script principal (só na conferência; a recarga recebe o real).
  await tela.route(`**/tela/${id}`, async (route) => {
    if (route.request().resourceType() !== 'fetch') return route.fallback()
    const res = await route.fetch()
    await route.fulfill({ response: res, body: (await res.text()).replace(/\/assets\/index-[\w-]+\.js/, '/assets/index-nova.js') })
  })
  // Em tela cheia (o portão pediu): confere e espera.
  assert.equal(await tela.evaluate<boolean>('!!document.fullscreenElement'), true, 'o portão não pediu tela cheia') // texto: o tsconfig do e2e não tem os tipos do navegador
  await nextCheck()
  assert.equal(await same(), true, 'recarregou em tela cheia')

  // Fora da tela cheia: a próxima conferência recarrega.
  await tela.evaluate('document.exitFullscreen()')
  const reloaded = tela.waitForEvent('load')
  await tela.clock.runFor(61_000)
  await reloaded
  await tela.unrouteAll()
  await tela.getByText('Conexão Profissional').first().waitFor()
  assert.equal(await same(), false)
  assert.equal(await tela.getByRole('button', { name: 'Iniciar exibição' }).count(), 0)
})
