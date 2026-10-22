// Configuração conferida antes de abrir o banco: valor inválido impede a inicialização em vez de virar
// comportamento silencioso (porta aleatória, upload sem limite, cookie forjável). Nunca imprime segredos.
export function configErrors(env = process.env): string[] {
  const errors: string[] = []
  if (env.SESSION_SECRET !== undefined && env.SESSION_SECRET.length < 32)
    errors.push('SESSION_SECRET com menos de 32 caracteres. Gere um valor com "openssl rand -base64 48" ou remova a variável para o app gerar um e guardar no banco.')
  for (const name of ['PORT', 'MAX_UPLOAD_MB']) {
    const value = env[name]
    if (value !== undefined && !(Number(value) > 0))
      errors.push(`${name} precisa ser um número maior que zero. Corrija o valor ou remova a variável para usar o padrão.`)
  }
  if (env.PUBLIC_URL && !/^https?:\/\/[^\s/]+/.test(env.PUBLIC_URL))
    errors.push('PUBLIC_URL precisa ser um endereço completo, como https://deck.exemplo.com.')
  const pg = env.DATABASE_URL || env.POSTGRES_URL
  if (pg && !/^postgres(ql)?:\/\/[^\s]+$/.test(pg))
    errors.push('DATABASE_URL precisa ser um endereço postgresql://. No Supabase: Connect → Transaction pooler, com a senha do banco no lugar de [YOUR-PASSWORD].')
  // Na Vercel não há disco: sem um banco externo os dados não teriam onde ficar.
  if (env.VERCEL && !pg && !env.TURSO_DATABASE_URL)
    errors.push('Banco não configurado. Na Vercel, defina DATABASE_URL com a conexão do Supabase (Transaction pooler, porta 6543) ou conecte um Turso (TURSO_DATABASE_URL).')
  return errors
}

/**
 * Base dos links (QR da entrada, convites, pareamento). Sem PUBLIC_URL, na Vercel, o domínio de produção do projeto:
 * o endereço de cada deploy (deck-slides-<hash>-<time>.vercel.app) pede login na Vercel, e o celular do aluno que
 * lesse o QR de uma tela aberta nele cairia nesse login. Fora da Vercel, null: vale o endereço da página aberta.
 */
export function publicBase(env = process.env): string | null {
  const url = env.PUBLIC_URL?.trim() || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '')
  return url.replace(/\/$/, '') || null
}

/** Avisos que não impedem a inicialização. */
export function configWarnings(env = process.env): string[] {
  const warnings: string[] = []
  if (env.NODE_ENV === 'production' && env.PUBLIC_URL?.startsWith('http://'))
    warnings.push('PUBLIC_URL usa http://. Convites e pareamento trafegam sem criptografia; use assim só em rede local fechada.')
  if (env.TRUST_PROXY && env.TRUST_PROXY !== '0' && env.TRUST_PROXY !== '1')
    warnings.push('TRUST_PROXY só reconhece 1. Com outro valor, os limites de tentativas contam o IP do proxy, não o do cliente.')
  if (env.ADMIN_EMAIL && (env.ADMIN_PASSWORD ?? '').length < 8)
    warnings.push('ADMIN_EMAIL definido sem ADMIN_PASSWORD de pelo menos 8 caracteres: a conta de gestor não foi criada.')
  if (env.VERCEL && !env.BLOB_READ_WRITE_TOKEN)
    warnings.push('BLOB_READ_WRITE_TOKEN ausente. Sem um Vercel Blob conectado ao projeto, o envio de imagens, vídeos e fontes falha.')
  return warnings
}
