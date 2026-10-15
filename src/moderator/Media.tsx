// Biblioteca de mídia (/eventos/:id/midia): imagens, vídeos e fontes do evento; envio por botão ou arrastando arquivos.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LinkSimpleIcon } from '@phosphor-icons/react/LinkSimple'
import { TrashIcon } from '@phosphor-icons/react/Trash'
import { UploadSimpleIcon } from '@phosphor-icons/react/UploadSimple'
import { del } from '../lib/api.ts'
import { bytes, plural } from '../lib/format.ts'
import { Button, Empty, IconButton, TabBar, Tooltip, confirm, notify } from '../ui'
import { run, useEvent } from './context.ts'
import { uploadMedia } from './MediaPicker.tsx'
import { Page, copy, iconOnly, longDate } from './setup/kit.tsx'
import type { Media as MediaFile, ModeratorSnapshot } from '../../shared/types.ts'

const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml,video/mp4,video/webm,video/ogg,video/quicktime,.woff2,.woff,.ttf,.otf'
const KIND: Record<MediaFile['kind'], string> = { image: 'Imagem', video: 'Vídeo', font: 'Fonte' }
const list = new Intl.ListFormat('pt-BR', { type: 'conjunction' })

/** Onde cada arquivo é usado (por URL): cenas de imagem/vídeo e a aparência do evento. */
function usage({ scenes, event }: ModeratorSnapshot): Map<string, string[]> {
  const map = new Map<string, string[]>()
  const add = (url: string | null | undefined, place: string) => url && map.set(url, [...(map.get(url) ?? []), place])
  for (const s of scenes) if (s.type === 'image' || s.type === 'video') add(s.content.src, `na cena “${s.name}”`)
  const t = event.theme
  add(t.logo, 'no logo do evento')
  add(t.backgroundImage, 'na imagem de fundo da tela')
  add(t.fonts.heading.url, 'na fonte dos títulos')
  add(t.fonts.body.url, 'na fonte do texto')
  add(t.fonts.numbers.url, 'na fonte dos números')
  return map
}
const usedText = (places: string[]) => `Usado ${list.format(places)}.`

interface Upload {
  key: number
  file: File
  progress: number
}
let seq = 0

export default function Media() {
  const { id, snap } = useEvent()
  const [tab, setTab] = useState<'all' | MediaFile['kind']>('all')
  const [queue, setQueue] = useState<Upload[]>([])
  const [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const pending = useRef<Upload[]>([])
  const running = useRef(false)
  const used = useMemo(() => usage(snap), [snap])

  // Um arquivo por vez, na ordem em que chegaram; o que for solto durante um envio entra na fila.
  const send = useCallback(async (files: Iterable<File>) => {
    const items = Array.from(files, (file) => ({ key: ++seq, file, progress: 0 }))
    if (!items.length) return
    pending.current.push(...items)
    setQueue((q) => [...q, ...items])
    if (running.current) return
    running.current = true
    let sent = 0
    while (pending.current.length) {
      const item = pending.current.shift()!
      const progress = (f: number) => setQueue((q) => q.map((x) => (x.key === item.key ? { ...x, progress: f } : x)))
      if (await uploadMedia(id, item.file, progress)) sent++
      setQueue((q) => q.filter((x) => x.key !== item.key))
    }
    running.current = false
    if (sent) notify(`${plural(sent, 'arquivo enviado', 'arquivos enviados')}.`)
  }, [id])

  // A janela inteira recebe arquivos enquanto esta página está aberta: soltar fora da área (na barra do evento,
  // por exemplo) não faz o navegador abrir o arquivo e sair do console. O contador evita piscar entre elementos.
  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth++
      setDragging(true)
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e) || --depth > 0) return
      depth = 0
      setDragging(false)
    }
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer!.dropEffect = 'copy'
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      void send(e.dataTransfer!.files)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [send])

  const remove = async (m: MediaFile) => {
    const places = used.get(m.url)
    const ok = await confirm({
      title: 'Excluir o arquivo?',
      body: `${places ? `${usedText(places)} ` : ''}“${m.name}” é apagado do servidor. Não é possível desfazer.`,
      confirm: 'Excluir arquivo',
    })
    if (ok && (await run(() => del(`/events/${id}/media/${m.id}`)))) notify('Arquivo excluído.', { description: m.name })
  }

  const files = tab === 'all' ? snap.media : snap.media.filter((m) => m.kind === tab)
  const total = (kind: MediaFile['kind']) => snap.media.filter((m) => m.kind === kind).length
  const pick = () => picker.current?.click()

  return (
    <Page
      title="Mídia"
      description="Imagens, vídeos e fontes usados nas cenas e na aparência. Para enviar, você também pode arrastar arquivos para esta página."
      actions={
        snap.media.length > 0 && (
          <Button variant="primary" icon={<UploadSimpleIcon />} onClick={pick}>
            Enviar arquivos
          </Button>
        )
      }
    >
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        accept={ACCEPT}
        onChange={(e) => {
          const chosen = Array.from(e.target.files ?? [])
          e.target.value = ''
          void send(chosen)
        }}
      />

      {queue.length > 0 && (
        <ul aria-label="Envios" className="mb-6 divide-y divide-line border-y border-line">
          {queue.map((u, i) => (
            <li key={u.key} className="flex h-10 items-center gap-4 text-ui">
              <span className="min-w-0 flex-1 truncate text-fg">{u.file.name}</span>
              <span className="w-20 text-right text-fg-subtle">{bytes(u.file.size)}</span>
              <span
                role="progressbar"
                aria-label={`Envio de ${u.file.name}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(u.progress * 100)}
                className="h-1 w-48 overflow-hidden rounded-full bg-line"
              >
                <span className="block h-full bg-fg-muted" style={{ width: `${u.progress * 100}%` }} />
              </span>
              <span className="w-20 text-fg-muted tabular-nums">{i === 0 ? `${Math.round(u.progress * 100)}%` : 'Na fila'}</span>
            </li>
          ))}
        </ul>
      )}

      {snap.media.length === 0 ? (
        queue.length === 0 && (
          <Empty
            title="Nenhum arquivo enviado."
            action={
              <Button variant="primary" icon={<UploadSimpleIcon />} onClick={pick}>
                Enviar arquivos
              </Button>
            }
          >
            Os arquivos enviados aparecem aqui, prontos para usar nas cenas e na aparência.
          </Empty>
        )
      ) : (
        <>
          <TabBar
            value={tab}
            onChange={setTab}
            items={[
              { value: 'all', label: 'Todos', count: snap.media.length },
              { value: 'image', label: 'Imagens', count: total('image') },
              { value: 'video', label: 'Vídeos', count: total('video') },
              { value: 'font', label: 'Fontes', count: total('font') },
            ]}
          />
          {files.length ? (
            <ul className="divide-y divide-line">
              {files.map((m) => {
                const places = used.get(m.url)
                return (
                  <li key={m.id} className="flex items-center gap-4 py-2.5 text-ui">
                    <Thumb m={m} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-fg" title={m.name}>
                        {m.name}
                      </p>
                      {places && (
                        <p className="truncate text-meta text-fg-subtle" title={usedText(places)}>
                          {usedText(places)}
                        </p>
                      )}
                    </div>
                    <span className="w-14 text-fg-muted">{KIND[m.kind]}</span>
                    <span className="w-20 text-right text-fg-muted">{bytes(m.size)}</span>
                    <span className="w-28 text-fg-subtle">{longDate.format(m.createdAt)}</span>
                    <span className="flex">
                      <Tooltip label="Copiar URL">
                        <IconButton
                          className={iconOnly}
                          label={`Copiar URL de ${m.name}`}
                          icon={<LinkSimpleIcon />}
                          onClick={() => copy(new URL(m.url, snap.publicUrl ?? location.origin).href, 'URL copiada.')}
                        />
                      </Tooltip>
                      <Tooltip label="Excluir">
                        <IconButton className={iconOnly} label={`Excluir ${m.name}`} icon={<TrashIcon />} onClick={() => remove(m)} />
                      </Tooltip>
                    </span>
                  </li>
                )
              })}
            </ul>
          ) : (
            <Empty title={tab === 'image' ? 'Nenhuma imagem enviada.' : tab === 'video' ? 'Nenhum vídeo enviado.' : 'Nenhuma fonte enviada.'}>
              {tab === 'font'
                ? 'Fontes WOFF2, WOFF, TTF ou OTF enviadas aqui ficam disponíveis no editor de aparência.'
                : 'Os arquivos enviados aparecem aqui e podem ser usados nas cenas.'}
            </Empty>
          )}
        </>
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-x-0 top-12 bottom-0 z-30 grid place-items-center bg-canvas/85 outline-2 -outline-offset-8 outline-line-strong outline-dashed">
          <p className="text-title font-semibold text-fg">Solte os arquivos para enviar</p>
        </div>
      )}
    </Page>
  )
}

const box = 'grid h-[54px] w-24 shrink-0 place-items-center overflow-hidden rounded-monitor bg-raised'

function Thumb({ m }: { m: MediaFile }) {
  if (m.kind === 'image')
    return (
      <span className={box}>
        <img src={m.url} alt="" loading="lazy" className="max-h-full max-w-full object-contain" />
      </span>
    )
  if (m.kind === 'video')
    return (
      <span className={box}>
        {/* #t=0.1 faz o navegador mostrar um quadro do começo em vez de um retângulo vazio */}
        <video src={`${m.url}#t=0.1`} preload="metadata" muted playsInline className="h-full w-full object-cover" />
      </span>
    )
  return (
    <span className={box}>
      <FontSample m={m} />
    </span>
  )
}

const faces = new Map<string, Promise<FontFace>>()

/** Amostra da fonte enviada, carregada do próprio arquivo com um nome de família exclusivo. */
function FontSample({ m }: { m: MediaFile }) {
  const family = `media-${m.id}`
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let face = faces.get(m.url)
    if (!face) {
      face = new FontFace(family, `url("${m.url}")`).load().then((f) => (document.fonts.add(f), f))
      faces.set(m.url, face)
    }
    let alive = true
    face.catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [m.url, family])
  if (failed) return <span className="px-1 text-center text-meta text-fg-subtle">Fonte ilegível</span>
  return (
    <span aria-hidden style={{ fontFamily: `"${family}", ui-sans-serif` }} className="px-1 text-center text-title leading-tight text-fg">
      Aa Áç 0123
    </span>
  )
}
