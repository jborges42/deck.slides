// Escolha de mídia: biblioteca do evento, envio de arquivo (com progresso) ou URL externa.
// Compartilhado pelo inspetor de cenas, pela aparência e pela página de mídia.
import { useRef, useState } from 'react'
import { UploadSimpleIcon } from '@phosphor-icons/react/UploadSimple'
import { XIcon } from '@phosphor-icons/react/X'
import { ApiError, upload } from '../lib/api.ts'
import { Button, IconButton, Select, inputClass, notify, cx } from '../ui'
import type { Media } from '../../shared/types.ts'

const ACCEPT: Record<Media['kind'], string> = {
  image: 'image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml',
  video: 'video/mp4,video/webm,video/ogg,video/quicktime',
  font: '.woff2,.woff,.ttf,.otf',
}

/** Envia um arquivo para a biblioteca do evento. Retorna a mídia criada ou null (erro já avisado). */
export async function uploadMedia(eventId: string, file: File, onProgress?: (f: number) => void): Promise<Media | null> {
  try {
    return await upload<Media>(`/events/${eventId}/media`, file, onProgress)
  } catch (e) {
    notify(e instanceof ApiError ? e.message : 'Falha no envio do arquivo.', { tone: 'critical' })
    return null
  }
}

/** Botão que abre o seletor de arquivos e envia, mostrando o progresso no próprio botão. */
export function UploadButton({
  eventId,
  kind,
  onUploaded,
  label = 'Enviar arquivo',
  size = 'md',
}: {
  eventId: string
  kind: Media['kind']
  onUploaded?: (m: Media) => void
  label?: string
  size?: 'sm' | 'md'
}) {
  const input = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<number | null>(null)
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={ACCEPT[kind]}
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (!file) return
          setProgress(0)
          const m = await uploadMedia(eventId, file, setProgress)
          setProgress(null)
          if (m) onUploaded?.(m)
        }}
      />
      <Button size={size} icon={<UploadSimpleIcon />} disabled={progress !== null} onClick={() => input.current?.click()}>
        {progress === null ? label : `Enviando… ${Math.round(progress * 100)}%`}
      </Button>
    </>
  )
}

/**
 * Campo de mídia: seleciona da biblioteca (filtrada por tipo), envia um arquivo novo ou aceita URL.
 * `value` é a URL usada pela cena/tema ("/media/…" ou "https://…"); null/"" = vazio.
 */
export function MediaPicker({
  eventId,
  media,
  kind,
  value,
  onChange,
  allowUrl = true,
  label,
}: {
  eventId: string
  media: Media[]
  kind: Media['kind']
  value: string | null
  onChange: (url: string | null, media?: Media) => void
  allowUrl?: boolean
  label: string
}) {
  const own = media.filter((m) => m.kind === kind)
  const external = !!value && !own.some((m) => m.url === value)
  const [mode, setMode] = useState<'library' | 'url'>(external ? 'url' : 'library')
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {mode === 'library' ? (
          <Select
            label={label}
            className="min-w-0 flex-1"
            value={value && !external ? value : ''}
            onChange={(url) => onChange(url || null, own.find((m) => m.url === url))}
            options={[{ value: '', label: own.length ? 'Nenhum' : 'Biblioteca vazia' }, ...own.map((m) => ({ value: m.url, label: m.name }))]}
          />
        ) : (
          <input
            aria-label={`${label} (URL)`}
            defaultValue={external ? value! : ''}
            placeholder="https://…"
            onBlur={(e) => onChange(e.target.value.trim() || null)}
            className={cx(inputClass, 'h-8 min-w-0 flex-1 text-ui')}
          />
        )}
        {value && <IconButton label="Remover" size="sm" icon={<XIcon size={14} />} onClick={() => onChange(null)} />}
      </div>
      <div className="flex items-center gap-2">
        <UploadButton eventId={eventId} kind={kind} size="sm" onUploaded={(m) => onChange(m.url, m)} />
        {allowUrl && (
          <Button size="sm" variant="ghost" onClick={() => setMode(mode === 'library' ? 'url' : 'library')}>
            {mode === 'library' ? 'Usar URL' : 'Usar biblioteca'}
          </Button>
        )}
      </div>
    </div>
  )
}
