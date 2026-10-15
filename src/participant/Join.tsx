// Convite pessoal (/i/:token): confirma o PIN do evento e leva à página do evento.
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { ApiError, api, post } from '../lib/api.ts'
import { EntryForm, EventHeader, LoadError, Loading, Notice, PhonePage, firstName, type EventBrand } from './shell.tsx'

interface Invite {
  event: EventBrand
  participant: { name: string }
  joined: boolean
}

export default function Join() {
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const [invite, setInvite] = useState<Invite | null>(null)
  const [fail, setFail] = useState<ApiError | null>(null)
  const [attempt, setAttempt] = useState(0)
  const path = `/invite/${encodeURIComponent(token)}`

  useEffect(() => {
    let live = true
    api<Invite>(path).then(
      (r) => live && (r.joined ? navigate(`/e/${r.event.id}`, { replace: true }) : setInvite(r)),
      (e: ApiError) => live && setFail(e),
    )
    return () => {
      live = false
    }
  }, [path, attempt, navigate])

  const ev = invite?.event
  return (
    <PhonePage brand={ev} title={ev?.name}>
      {fail?.status === 404 ? (
        <Notice title="Este convite não é válido.">Peça um novo link à organização do evento.</Notice>
      ) : fail ? (
        <LoadError
          error={fail}
          onRetry={() => {
            setFail(null)
            setAttempt((a) => a + 1)
          }}
        />
      ) : !invite || !ev ? (
        <Loading />
      ) : (
        <div className="flex flex-col gap-8">
          <EventHeader name={ev.name} logo={ev.logo} />
          <div className="flex flex-col gap-1">
            <p className="text-head font-semibold">Olá, {firstName(invite.participant.name)}.</p>
            <p className="text-fg-muted">Informe o PIN do evento para entrar.</p>
          </div>
          <EntryForm
            length={ev.pinLength}
            onSubmit={(pin) => post<{ eventId: string }>(path, { pin }).then((r) => navigate(`/e/${r.eventId}`, { replace: true }))}
          />
        </div>
      )}
    </PhonePage>
  )
}
