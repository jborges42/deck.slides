// Página do evento no celular (/e/:id): entrada pelo link aberto (nome + PIN) ou aviso de evento só com
// convidados; depois de confirmado, a página do participante.
import { useEffect, useState } from 'react'
import { useParams } from 'react-router'
import { ApiError, api, post } from '../lib/api.ts'
import { Home } from './Home.tsx'
import { EntryForm, EventHeader, LoadError, Loading, Notice, PhonePage, type EventBrand } from './shell.tsx'

interface Entry {
  event: EventBrand | null // null: evento só com convidados, para quem ainda não entrou
  openJoin: boolean
  joined: boolean
}

export default function Event() {
  const { id = '' } = useParams()
  const [entry, setEntry] = useState<Entry | null>(null)
  const [fail, setFail] = useState<ApiError | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    api<Entry>(`/open/${encodeURIComponent(id)}`).then(
      (r) => live && setEntry(r),
      (e: ApiError) => live && setFail(e),
    )
    return () => {
      live = false
    }
  }, [id, attempt])

  if (entry?.joined) return <Home id={id} brand={entry.event} onLeave={() => setEntry({ ...entry, joined: false })} />

  const ev = entry?.event
  return (
    <PhonePage brand={ev} title={ev?.name}>
      {fail ? (
        fail.status === 404 ? (
          <Notice title={fail.message} />
        ) : (
          <LoadError
            error={fail}
            onRetry={() => {
              setFail(null)
              setAttempt((a) => a + 1)
            }}
          />
        )
      ) : !entry ? (
        <Loading />
      ) : entry.openJoin && ev ? (
        <div className="flex flex-col gap-8">
          <EventHeader name={ev.name} logo={ev.logo}>
            <p className="text-fg-muted">Informe seu nome e o PIN do evento para entrar.</p>
          </EventHeader>
          <EntryForm
            withName
            length={ev.pinLength}
            onSubmit={(pin, name) => post(`/open/${encodeURIComponent(id)}`, { name, pin }).then(() => setEntry({ ...entry, joined: true }))}
          />
        </div>
      ) : (
        <Notice title="Este evento aceita apenas convidados.">Abra o link do seu convite.</Notice>
      )}
    </PhonePage>
  )
}
