import { serve } from '@hono/node-server'
import { configErrors, configWarnings } from './config.ts'

const errors = configErrors()
if (errors.length) {
  for (const e of errors) console.error(`Configuração inválida: ${e}`)
  process.exitCode = 1 // sem process.exit(): a mensagem termina de sair mesmo quando stderr é um pipe
} else {
  for (const w of configWarnings()) console.warn(`Aviso: ${w}`)
  const { app } = await import('./app.ts')
  const port = Number(process.env.PORT ?? 3000)
  serve({ fetch: app.fetch, port }, (info) => console.info(`deck.slides em http://localhost:${info.port}`))
}
