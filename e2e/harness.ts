// Ambiente dos testes de ponta a ponta: build de produção servido por um processo isolado
// (porta e banco temporários) e o Chrome instalado no sistema, sem janela.
// Rodar com `pnpm test:e2e` (faz o build antes).
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'

export const SETUP_TOKEN = 'e2e-setup-token'
export const MOD = { name: 'Ana Moderadora', email: 'ana@exemplo.com', password: 'senha-segura-123' }

export interface Env {
  base: string
  browser: Browser
  server: ChildProcess
  logs: string[]
  /** Notebook do moderador (1440 × 900). */
  desktop: () => Promise<BrowserContext>
  /** Computador da projeção (1920 × 1080). */
  projector: () => Promise<BrowserContext>
  /** Celular de participante (390 × 844, toque). */
  phone: () => Promise<BrowserContext>
  close: () => Promise<void>
}

export async function start(): Promise<Env> {
  const port = 41_000 + Math.floor(Math.random() * 2000)
  const logs: string[] = []
  const server = spawn(process.execPath, [new URL('../server/index.ts', import.meta.url).pathname], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      DATA_DIR: mkdtempSync(join(tmpdir(), 'deck-e2e-')),
      SETUP_TOKEN,
      SESSION_SECRET: 'e2e-session-secret-with-at-least-32-chars',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout!.on('data', (d) => logs.push(String(d)))
  server.stderr!.on('data', (d) => logs.push(String(d)))
  await new Promise<void>((resolve, reject) => {
    server.stdout!.once('data', () => resolve())
    server.once('exit', (code) => reject(new Error(`servidor saiu (${code}): ${logs.join('')}`)))
  })
  const base = `http://localhost:${port}`
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = (opts: Parameters<Browser['newContext']>[0]) => browser.newContext({ baseURL: base, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', ...opts })
  return {
    base,
    browser,
    server,
    logs,
    desktop: () => context({ viewport: { width: 1440, height: 900 } }),
    projector: () => context({ viewport: { width: 1920, height: 1080 } }),
    phone: () => context({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }),
    close: async () => {
      await browser.close()
      server.kill()
    },
  }
}

/** Falha o teste se a página registrar erro de JavaScript ou de console (exceto falhas de rede esperadas). */
export function watchErrors(page: Page, allow: RegExp[] = []): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error' && !allow.some((r) => r.test(m.text()))) errors.push(`console: ${m.text()}`)
  })
  return errors
}

/** Cria a conta inicial pela interface (exige o código de instalação em produção) e deixa a sessão aberta. */
export async function setupModerator(page: Page) {
  await page.goto('/entrar')
  await page.getByLabel('Nome').fill(MOD.name)
  await page.getByLabel('E-mail').fill(MOD.email)
  await page.getByLabel('Senha').fill(MOD.password)
  const token = page.getByLabel(/código de instalação/i)
  if (await token.count()) await token.fill(SETUP_TOKEN)
  await page.getByRole('button', { name: /criar conta/i }).click()
  await page.waitForURL('**/eventos')
}
