import { useEffect, useState } from 'react'
import type { Counts } from '../../shared/types.ts'

/** busy = o servidor recusou por excesso de abas/conexões (429); tenta de novo devagar. */
export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'busy' | 'denied' | 'gone'

export interface Stream<S> {
  state: S | null
  counts: Counts
  status: StreamStatus
  /** Somar a Date.now() para obter o relógio do servidor. */
  offset: number
}

const EMPTY: Counts = { reactions: {}, likes: {} }
const SILENCE_MS = 35_000 // o servidor manda ping a cada 15 s; sem nada por 35 s, a conexão está morta
const BACKOFF = [1000, 2000, 5000, 10_000, 30_000]

/**
 * Assina o SSE de uma audiência e mantém a conexão viva:
 * - falha de rede: o EventSource reconecta sozinho;
 * - resposta HTTP de erro: ele desiste, então reabrimos com espera crescente, salvo 401/403/404 (acesso negado);
 * - conexão "muda" (Wi-Fi sem internet não dispara erro): sem mensagem por 35 s, reabrimos;
 * - volta da rede ou da aba para o primeiro plano: reabre na hora se não estiver ao vivo.
 */
export function useStream<S extends { serverNow: number }>(url: string | null): Stream<S> {
  const [stream, setStream] = useState<Stream<S>>({ state: null, counts: EMPTY, status: 'connecting', offset: 0 })

  useEffect(() => {
    if (!url) return
    let es: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    let attempt = 0
    let last = Date.now()
    let status: StreamStatus = 'connecting'
    const set = (patch: Partial<Stream<S>>) => {
      if (patch.status) status = patch.status
      setStream((s) => ({ ...s, ...patch }))
    }
    const heard = () => {
      last = Date.now()
      attempt = 0
    }

    const close = () => {
      es?.close()
      es = null
      clearTimeout(retry)
    }

    const open = () => {
      close()
      last = Date.now()
      es = new EventSource(url)
      es.addEventListener('open', () => {
        heard()
        set({ status: 'live' })
      })
      es.addEventListener('state', (e) => {
        heard()
        const state = JSON.parse(e.data) as S
        set({ state, status: 'live', offset: state.serverNow - Date.now() })
      })
      es.addEventListener('counts', (e) => {
        heard()
        set({ counts: JSON.parse(e.data) })
      })
      es.addEventListener('ping', (e) => {
        heard()
        set({ offset: Number(e.data) - Date.now() })
      })
      es.addEventListener('gone', () => {
        stopped = true
        close()
        set({ status: 'gone' })
      })
      es.addEventListener('error', () => {
        if (stopped) return
        if (es?.readyState !== EventSource.CLOSED) return set({ status: 'reconnecting' })
        set({ status: status === 'busy' ? 'busy' : 'reconnecting' })
        schedule()
      })
    }

    /** Reabre depois de uma espera crescente, perguntando antes ao servidor se o acesso ainda vale. */
    const schedule = () => {
      clearTimeout(retry)
      const wait = BACKOFF[Math.min(attempt++, BACKOFF.length - 1)]!
      retry = setTimeout(async () => {
        const ctrl = new AbortController()
        const res = await fetch(url, { signal: ctrl.signal }).catch(() => null)
        ctrl.abort()
        if (stopped) return
        if (res && [401, 403, 404].includes(res.status)) {
          stopped = true
          close()
          set({ status: 'denied' })
        } else if (res?.status === 429) {
          set({ status: 'busy' })
          schedule()
        } else open()
      }, wait)
    }

    const revive = () => {
      if (stopped || status === 'live' && Date.now() - last < SILENCE_MS) return
      attempt = 0
      set({ status: 'reconnecting' })
      open()
    }
    const watchdog = setInterval(() => {
      if (!stopped && status === 'live' && Date.now() - last > SILENCE_MS) revive()
    }, 5000)
    const onVisible = () => document.visibilityState === 'visible' && revive()
    window.addEventListener('online', revive)
    document.addEventListener('visibilitychange', onVisible)

    open()
    return () => {
      stopped = true
      close()
      clearInterval(watchdog)
      window.removeEventListener('online', revive)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [url])

  return stream
}

/** Re-renderiza a cada `ms` — para cronômetros. */
export function useNow(ms = 200): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}
