import { useEffect, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router'
import { api, ApiError } from '../lib/api.ts'
import { notify } from '../ui'
import type { Counts, ModeratorSnapshot } from '../../shared/types.ts'

export interface Moderator {
  id: string
  name: string
  email: string
}

/** Sessão do moderador. Sem sessão, leva para /entrar. `null` enquanto carrega. */
export function useModerator(): Moderator | null {
  const [me, setMe] = useState<Moderator | null>(null)
  const navigate = useNavigate()
  useEffect(() => {
    api<{ moderator: Moderator | null }>('/auth/me')
      .then(({ moderator }) => (moderator ? setMe(moderator) : navigate('/entrar', { replace: true })))
      .catch(() => navigate('/entrar', { replace: true }))
  }, [navigate])
  return me
}

/** Executa um comando da API; em erro, mostra o aviso com a mensagem do servidor e retorna undefined. */
export async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e) {
    notify(e instanceof ApiError ? e.message : 'Não foi possível concluir. Tente novamente.', { tone: 'critical' })
    return undefined
  }
}

export interface EventContext {
  id: string
  /** Snapshot confirmado pelo servidor. As páginas só renderizam depois do primeiro. */
  snap: ModeratorSnapshot
  /** Totais de reações e curtidas, atualizados até 4 vezes por segundo. */
  counts: Counts
  /** Somar a Date.now() para obter o relógio do servidor. */
  offset: number
  links: {
    /** Tela aberta neste computador (usa a sessão do moderador). */
    screen: string
    /** Página que o computador da projeção abre para parear por código. */
    pair: string
    /** Página do evento para participantes (entrada aberta, se habilitada). */
    join: string
    /** Link pessoal de convite. */
    invite: (token: string) => string
  }
}

/** Dados do evento aberto no console (fornecidos por EventLayout via <Outlet context>). */
export const useEvent = () => useOutletContext<EventContext>()

export function eventLinks(snap: ModeratorSnapshot): EventContext['links'] {
  const base = snap.publicUrl ?? location.origin
  const id = snap.event.id
  return {
    screen: `${location.origin}/tela/${id}`,
    pair: `${base}/tela`,
    join: `${base}/e/${id}`,
    invite: (token) => `${base}/convite/${token}`,
  }
}
