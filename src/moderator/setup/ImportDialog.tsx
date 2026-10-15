// Importar lista de participantes: colar do Excel/Planilhas ou escolher arquivo, conferir linha a linha e importar.
import { useMemo, useRef, useState, type ChangeEvent } from 'react'
import { FileArrowUpIcon } from '@phosphor-icons/react/FileArrowUp'
import { post } from '../../lib/api.ts'
import { plural } from '../../lib/format.ts'
import { Button, Dialog, Field, Textarea, notify } from '../../ui'
import { run } from '../context.ts'
import { readPeople, readText } from './csv.ts'
import { Stat } from './kit.tsx'
import type { Participant } from '../../../shared/types.ts'

const PREVIEW = 50 // linhas mostradas na conferência
const ISSUES = 30 // mensagens por linha mostradas

export function ImportDialog({
  open,
  onOpenChange,
  eventId,
  participants,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  eventId: string
  participants: Participant[]
}) {
  const [text, setText] = useState('')
  const [file, setFile] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const known = useMemo(() => participants.map((p) => p.email), [participants])
  const r = useMemo(() => readPeople(text, known), [text, known])
  const n = r.people.length
  const errors = r.issues.filter((i) => i.kind === 'error').length
  const repeated = r.issues.length - errors

  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    setText(await readText(f))
    setFile(f.name)
  }

  const submit = async () => {
    setBusy(true)
    const people = r.people.map(({ name, email, group }) => ({ name, email, group }))
    const res = await run(() => post<{ created: number }>(`/events/${eventId}/participants`, { people }))
    setBusy(false)
    if (!res) return
    notify(
      `${plural(res.created, 'participante importado', 'participantes importados')}.`,
      errors ? { description: `${plural(errors, 'linha com erro ficou', 'linhas com erro ficaram')} de fora.` } : {},
    )
    setText('')
    setFile(null)
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      width={760}
      title="Importar lista"
      description="Cole as linhas copiadas do Excel ou do Google Planilhas, ou escolha um arquivo. Colunas reconhecidas: nome, e-mail e grupo (ou turma)."
      footer={
        <>
          {n > 0 && r.issues.length > 0 && !r.problem && (
            <p className="mr-auto self-center text-meta text-fg-subtle">Linhas com erro ou e-mail repetido ficam de fora.</p>
          )}
          <Button onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button variant="primary" loading={busy} disabled={!n || !!r.problem} onClick={submit}>
            {n ? `Importar ${plural(n, 'participante', 'participantes')}` : 'Importar participantes'}
          </Button>
        </>
      }
    >
      <Field label="Lista" hint="Sem cabeçalho, as colunas são lidas na ordem nome, e-mail e grupo. O separador (tabulação, ponto e vírgula ou vírgula) é detectado sozinho.">
        <Textarea
          rows={7}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setFile(null)
          }}
          placeholder={'Nome\tE-mail\tGrupo\nAna Souza\tana@exemplo.com\tTurma A'}
          spellCheck={false}
          wrap="off"
          autoFocus
        />
      </Field>
      <div className="mt-3 flex items-center gap-3">
        <input ref={picker} type="file" hidden accept=".csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values" onChange={pick} />
        <Button size="sm" icon={<FileArrowUpIcon />} onClick={() => picker.current?.click()}>
          Escolher arquivo
        </Button>
        <span className="truncate text-meta text-fg-subtle">{file ?? 'CSV, TSV ou TXT. Arquivos do Excel em pt-BR são lidos com acentos.'}</span>
      </div>

      {text.trim() && (
        <section aria-label="Conferência" className="mt-6 border-t border-line pt-4">
          {r.problem ? (
            <p role="alert" className="text-ui text-critical">
              {r.problem}
            </p>
          ) : (
            <dl className="flex flex-wrap gap-x-6 gap-y-1 text-ui">
              <Stat label="Para importar" value={n} />
              <Stat label="Repetidos" value={repeated} />
              <Stat label="Com erro" value={errors} critical={errors > 0} />
            </dl>
          )}

          {r.issues.length > 0 && (
            <ul className="mt-3 flex flex-col gap-0.5 text-meta">
              {r.issues.slice(0, ISSUES).map((i, k) => (
                <li key={k} className={i.kind === 'error' ? 'text-critical' : 'text-fg-muted'}>
                  {i.text}
                </li>
              ))}
              {r.issues.length > ISSUES && (
                <li className="text-fg-subtle">E mais {plural(r.issues.length - ISSUES, 'aviso', 'avisos')}.</li>
              )}
            </ul>
          )}

          {n > 0 && (
            <table className="mt-4 w-full table-fixed text-ui">
              <thead>
                <tr className="border-b border-line text-left text-meta text-fg-subtle">
                  <th className="h-7 w-16 pr-3 font-medium">Linha</th>
                  <th className="h-7 pr-3 font-medium">Nome</th>
                  <th className="h-7 pr-3 font-medium">E-mail</th>
                  <th className="h-7 w-40 font-medium">Grupo</th>
                </tr>
              </thead>
              <tbody>
                {r.people.slice(0, PREVIEW).map((p) => (
                  <tr key={p.line} className="h-8 border-b border-line">
                    <td className="pr-3 text-fg-subtle tabular-nums">{p.line}</td>
                    <td className="truncate pr-3">{p.name}</td>
                    <td className="truncate pr-3 text-fg-muted">{p.email}</td>
                    <td className="truncate text-fg-muted">{p.group}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {n > PREVIEW && (
            <p className="mt-2 text-meta text-fg-subtle">Mostrando as primeiras {PREVIEW} de {n.toLocaleString('pt-BR')} linhas.</p>
          )}
        </section>
      )}
    </Dialog>
  )
}
