import { serve } from '@hono/node-server'

// Configuração conferida antes de abrir o banco: valor inválido impede a inicialização em vez de virar
// comportamento silencioso (porta aleatória, upload sem limite, cookie forjável). Nunca imprime segredos.
const env = process.env
const production = env.NODE_ENV === 'production'
const errors: string[] = []
if (production && (env.SESSION_SECRET ?? '').length < 32)
  errors.push('SESSION_SECRET ausente ou com menos de 32 caracteres. Gere um valor com "openssl rand -base64 48" e defina a variável.')
for (const name of ['PORT', 'MAX_UPLOAD_MB']) {
  const value = env[name]
  if (value !== undefined && !(Number(value) > 0))
    errors.push(`${name} precisa ser um número maior que zero. Corrija o valor ou remova a variável para usar o padrão.`)
}
if (env.PUBLIC_URL && !/^https?:\/\/[^\s/]+/.test(env.PUBLIC_URL))
  errors.push('PUBLIC_URL precisa ser um endereço completo, como https://deck.exemplo.com.')

if (errors.length) {
  for (const e of errors) console.error(`Configuração inválida: ${e}`)
  process.exitCode = 1 // sem process.exit(): a mensagem termina de sair mesmo quando stderr é um pipe
} else {
  if (production && env.PUBLIC_URL?.startsWith('http://'))
    console.warn('Aviso: PUBLIC_URL usa http://. Convites e pareamento trafegam sem criptografia; use assim só em rede local fechada.')
  if (env.TRUST_PROXY && env.TRUST_PROXY !== '0' && env.TRUST_PROXY !== '1')
    console.warn('Aviso: TRUST_PROXY só reconhece 1. Com outro valor, os limites de tentativas contam o IP do proxy, não o do cliente.')
  const { app } = await import('./app.ts')
  const port = Number(env.PORT ?? 3000)
  serve({ fetch: app.fetch, port }, (info) => console.info(`deck.slides em http://localhost:${info.port}`))
}
