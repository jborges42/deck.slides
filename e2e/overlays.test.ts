// Pergunta e cronômetro sobre o conteúdo, de ponta a ponta: o console comanda pelos controles reais e duas telas
// (telão e tela frontal dos participantes) mostram o mesmo quadro. Rodar com `pnpm test:e2e`.
// Com E2E_SHOTS=<pasta>, guarda capturas do telão para conferir a legibilidade.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { FrameLocator, Page } from 'playwright-core'
import { setupModerator, start, watchErrors, type Env } from './harness.ts'

let env: Env
before(async () => {
  env = await start()
})
after(() => env?.close())

const QUESTION = 'Como o mercado avalia quem está começando a carreira e ainda não tem experiência formal?'
const shot = (page: Page, name: string) => (process.env.E2E_SHOTS ? page.screenshot({ path: join(process.env.E2E_SHOTS, `${name}.png`) }) : null)

/** Algarismos do cronômetro em segundos ("01:58" -> 118). */
async function seconds(screen: FrameLocator): Promise<number> {
  const [m, s] = (await screen.getByRole('timer').textContent())!.trim().split(':').map(Number)
  return m! * 60 + s!
}

/** Espera uma condição que depende do snapshot chegar (até 2 s). */
async function until(what: string, ok: () => Promise<boolean>) {
  for (let i = 0; i < 40; i++) {
    if (await ok()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.fail(what)
}

test('pergunta e cronômetro sobre o conteúdo, sincronizados em duas telas', async () => {
  const console_ = await env.desktop()
  const page = await console_.newPage()
  const errors = watchErrors(page)
  await setupModerator(page)

  // Preparação pela API, com a sessão do console: evento e uma pergunta já aprovada (feita pela moderação).
  const api = async (method: string, path: string, data?: unknown) => {
    const r = await page.request.fetch(`/api${path}`, { method, data, headers: { origin: env.base } })
    assert.ok(r.ok(), `${method} ${path} -> ${r.status()} ${await r.text()}`)
    return r.json()
  }
  const { id } = await api('POST', '/events', { name: 'Conexão Profissional' })
  await api('POST', `/events/${id}/questions`, { text: QUESTION, author: 'Ana Souza' })
  await page.goto(`/eventos/${id}`)

  /** Cena do roteiro para a prévia e ao ar. O console ignora um corte a menos de 500 ms do anterior (toque duplo). */
  const takeScene = async (name: string) => {
    await page.waitForTimeout(600)
    await page.getByRole('button', { name: new RegExp(name) }).first().click()
    await page.getByRole('button', { name: /Colocar no ar/ }).click()
    await page.locator('section[aria-label="No ar"]').getByText(name).first().waitFor()
  }
  /** Chave do No ar, esperando o console confirmar (a chave mostra só o estado do servidor). */
  const toggle = async (name: string, on: boolean) => {
    await page.getByRole('switch', { name, checked: !on }).click()
    await page.getByRole('switch', { name, checked: on }).waitFor()
  }
  await takeScene('Abertura')

  // Duas telas abertas com a sessão do console (telão e tela frontal), em 1920 × 1080.
  const projector = await env.browser.newContext({ baseURL: env.base, viewport: { width: 1920, height: 1080 }, storageState: await console_.storageState() })
  const screens = await Promise.all(
    [0, 1].map(async () => {
      const s = await projector.newPage()
      const e = watchErrors(s)
      await s.goto(`/tela/${id}`)
      // O conteúdo roda num iframe da moldura (a página que fica em tela cheia).
      const view = s.frameLocator('iframe[data-quadro="ativo"]')
      await view.getByRole('button', { name: 'Iniciar exibição' }).click()
      await view.getByText('Conexão Profissional').first().waitFor()
      return { page: s, view, errors: e }
    }),
  )
  const both = (fn: (s: FrameLocator) => Promise<unknown>) => Promise.all(screens.map((s) => fn(s.view)))
  const telao = screens[0]!.page

  // ---------- pergunta sobre o conteúdo (tecla S na fila) ----------
  await page.getByRole('tab', { name: /Aprovadas/ }).click()
  await page.getByText(QUESTION).click()
  await page.keyboard.press('KeyS')
  await both((s) => s.getByText(QUESTION).waitFor())
  await both((s) => s.getByText('Ana S.').waitFor())
  await page.getByText('Sobre o conteúdo').first().waitFor() // chip na fila
  await page.getByText('Pergunta sobre o conteúdo').waitFor() // linha no No ar
  await both((s) => s.getByText('Conexão Profissional').first().waitFor()) // a cena continua por baixo
  await shot(telao, '1-pergunta-sobre-titulo')

  // Faixa de entrada ligada com a pergunta na tela: espera a pergunta sair.
  await toggle('Entrada (QR e PIN)', true)
  const band = (s: FrameLocator) => s.getByText('Use o link do seu convite').locator('xpath=ancestor::*[contains(@style, "opacity")][1]').getAttribute('style')
  await page.waitForTimeout(400)
  for (const style of await Promise.all(screens.map((s) => band(s.view)))) assert.match(style!, /opacity: 0(;|$)/)
  await toggle('Entrada (QR e PIN)', false)

  // Tela de espera esconde; voltar mostra de novo.
  await page.keyboard.press('KeyB')
  await both((s) => s.getByText(QUESTION).waitFor({ state: 'hidden' }))
  await page.keyboard.press('KeyB')
  await both((s) => s.getByText(QUESTION).waitFor())

  // ---------- cronômetro sobre o conteúdo ----------
  await toggle('Cronômetro sobre o conteúdo', true)
  await both((s) => s.getByRole('timer').waitFor())
  await page.getByLabel('Duração da fala').fill('2')
  await page.getByRole('button', { name: 'Definir tempo' }).click()
  await both((s) => s.getByRole('timer').filter({ hasText: '02:00' }).waitFor())
  await page.getByRole('button', { name: 'Iniciar' }).click()
  await telao.waitForTimeout(2500)
  const [a, b] = await Promise.all(screens.map((s) => seconds(s.view)))
  assert.ok(a! <= 118 && a! >= 115, `telão em ${a} s`)
  assert.ok(Math.abs(a! - b!) <= 1, `telas fora de sincronia: ${a} e ${b}`)
  await shot(telao, '2-pergunta-e-cronometro')

  // Canto padrão: em cima à esquerda; trocar leva para a direita.
  const x = async (s: FrameLocator) => (await s.getByRole('timer').boundingBox())!.x
  assert.ok((await x(screens[0]!.view)) < 960)
  await page.getByRole('button', { name: 'Em cima à direita' }).click()
  await both((s) => until('cronômetro não foi para a direita', async () => (await x(s)) > 960))

  // Pausar congela as duas telas no mesmo número; continuar e zerar.
  await page.getByRole('button', { name: 'Pausar' }).click()
  await telao.waitForTimeout(400)
  const paused = await Promise.all(screens.map((s) => seconds(s.view)))
  await telao.waitForTimeout(1500)
  assert.deepEqual(await Promise.all(screens.map((s) => seconds(s.view))), paused)
  assert.equal(paused[0], paused[1])
  await page.getByRole('button', { name: 'Continuar' }).waitFor()
  await page.getByRole('button', { name: 'Zerar' }).click()
  await both((s) => s.getByRole('timer').filter({ hasText: '02:00' }).waitFor())

  // ---------- remover a pergunta pelo No ar ----------
  await page.getByRole('button', { name: 'Remover de cima do conteúdo' }).click()
  await both((s) => s.getByText(QUESTION).waitFor({ state: 'hidden' }))
  await shot(telao, '3-so-cronometro-direita')

  // Cena de cronômetro no ar: o cronômetro sobre o conteúdo some (fica só o da cena).
  await takeScene('Intervalo')
  await both((s) => until('dois cronômetros na tela', async () => (await s.getByRole('timer').count()) === 1))

  // De volta à abertura: o relógio da cena (10:00) segue sobre ela; desligar a chave tira.
  await takeScene('Abertura')
  await both((s) => s.getByRole('timer').filter({ hasText: '10:00' }).waitFor())
  await toggle('Cronômetro sobre o conteúdo', false)
  await both((s) => s.getByRole('timer').waitFor({ state: 'hidden' }))

  assert.deepEqual([...errors, ...screens.flatMap((s) => s.errors)], [])
  await projector.close()
  await console_.close()
})
