/** 83_000 -> "01:23"; 3_723_000 -> "1:02:03". Arredonda para cima na contagem regressiva. */
export function clock(ms: number, roundUp = false): string {
  const total = Math.max(0, roundUp ? Math.ceil(ms / 1000) : Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto', style: 'short' })

/** "agora", "há 3 min", "há 2 h". */
export function ago(ts: number, now = Date.now()): string {
  const s = Math.round((now - ts) / 1000)
  if (s < 45) return 'agora'
  // Unidade escolhida pelo valor já arredondado: 59 min 40 s vira "há 1 h", nunca "há 60 min".
  const min = Math.round(s / 60)
  if (min < 60) return rtf.format(-min, 'minute')
  const h = Math.round(s / 3600)
  if (h < 24) return rtf.format(-h, 'hour')
  return new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
}

/** Tamanho de arquivo com espaço inseparável entre número e unidade ("12,5\u00a0MB"). */
export function bytes(n: number): string {
  if (n < 1024) return `${n}\u00a0B`
  // Unidade escolhida pelo valor já arredondado: logo abaixo de 1 MB mostra "1,0 MB", não "1024 KB".
  if (Math.round(n / 1024) < 1024) return `${Math.round(n / 1024)}\u00a0KB`
  if (Number((n / 1024 ** 2).toFixed(1)) < 1024) return `${(n / 1024 ** 2).toFixed(1).replace('.', ',')}\u00a0MB`
  return `${(n / 1024 ** 3).toFixed(2).replace('.', ',')}\u00a0GB`
}

export const plural = (n: number, one: string, many: string) => `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`
