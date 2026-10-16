// Configuração conferida antes de abrir o banco: valor inválido impede a inicialização em vez de virar
// comportamento silencioso (porta aleatória, upload sem limite, cookie forjável). Nunca imprime segredos.
export function configErrors(env = process.env): string[] {
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
  const pg = env.DATABASE_URL || env.POSTGRES_URL
  if (pg && !/^postgres(ql)?:\/\/[^\s]+$/.test(pg))
    errors.push('DATABASE_URL precisa ser um endereço postgresql://. No Supabase: Connect → Transaction pooler, com a senha do banco no lugar de [YOUR-PASSWORD].')
  // Na Vercel não há disco: sem um banco externo os dados não teriam onde ficar.
  if (env.VERCEL && !pg && !env.TURSO_DATABASE_URL)
    errors.push('Banco não configurado. Na Vercel, defina DATABASE_URL com a conexão do Supabase (Transaction pooler, porta 6543) ou conecte um Turso (TURSO_DATABASE_URL).')
  return errors
}

/** Avisos que não impedem a inicialização. */
export function configWarnings(env = process.env): string[] {
  const warnings: string[] = []
  if (env.NODE_ENV === 'production' && env.PUBLIC_URL?.startsWith('http://'))
    warnings.push('PUBLIC_URL usa http://. Convites e pareamento trafegam sem criptografia; use assim só em rede local fechada.')
  if (env.TRUST_PROXY && env.TRUST_PROXY !== '0' && env.TRUST_PROXY !== '1')
    warnings.push('TRUST_PROXY só reconhece 1. Com outro valor, os limites de tentativas contam o IP do proxy, não o do cliente.')
  if (env.VERCEL && !env.BLOB_READ_WRITE_TOKEN)
    warnings.push('BLOB_READ_WRITE_TOKEN ausente. Sem um Vercel Blob conectado ao projeto, o envio de imagens, vídeos e fontes falha.')
  return warnings
}
