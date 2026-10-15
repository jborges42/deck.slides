// Minha conta › Verificação em duas etapas: ativar (QR + chave + código), códigos de recuperação e desativar.
import { useMemo, useState } from 'react'
import { renderSVG } from 'uqr'
import { CopyIcon } from '@phosphor-icons/react/Copy'
import { DownloadSimpleIcon } from '@phosphor-icons/react/DownloadSimple'
import { del, post } from '../lib/api.ts'
import { Button, Chip, Field, confirm, notify } from '../ui'
import { copy, download, message } from '../moderator/setup/kit.tsx'
import { CodeInput, SudoCancelled, act, expired, withSudo } from '../moderator/auth/sudo.tsx'
import type { Me } from '../../shared/admin.ts'

type Setup = { secret: string; otpauthUri: string }

export function TwoStep({ me, onChange }: { me: Me; onChange: () => void }) {
  const [setup, setSetup] = useState<Setup | null>(null)
  const [codes, setCodes] = useState<string[] | null>(null)
  const [starting, setStarting] = useState(false)

  // Os códigos ficam na tela até "Concluir", mesmo depois de a conta ser relida.
  if (codes) return <RecoveryCodes codes={codes} email={me.email} onDone={() => setCodes(null)} />
  if (setup)
    return (
      <SetupPanel
        setup={setup}
        onCancel={() => setSetup(null)}
        onConfirmed={(list) => {
          setSetup(null)
          setCodes(list)
          onChange()
        }}
      />
    )

  const start = async () => {
    setStarting(true)
    const s = await act(() => post<Setup>('/account/mfa/setup'))
    setStarting(false)
    if (s) setSetup(s)
  }

  const regenerate = async () => {
    const ok = await confirm({
      title: 'Gerar novos códigos de recuperação?',
      body: 'Os códigos atuais deixam de funcionar. Guarde os novos assim que aparecerem.',
      confirm: 'Gerar novos códigos',
      tone: 'primary',
    })
    const r = ok && (await act(() => post<{ recoveryCodes: string[] }>('/account/mfa/recovery-codes')))
    if (r) setCodes(r.recoveryCodes)
  }

  const disable = async () => {
    const ok = await confirm({
      title: 'Desativar a verificação em duas etapas?',
      body: 'Para entrar, volta a bastar a senha. Os códigos de recuperação deixam de funcionar.',
      confirm: 'Desativar verificação',
    })
    if (ok && (await act(() => del('/account/mfa')))) {
      notify('Verificação em duas etapas desativada.')
      onChange()
    }
  }

  if (!me.mfaEnabled)
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-ui text-fg-muted">Inativa. Hoje basta a senha para entrar na sua conta.</p>
        <Button variant="primary" loading={starting} onClick={() => void start()}>
          Ativar verificação
        </Button>
      </div>
    )

  return (
    <div className="flex flex-col items-start gap-3">
      <p className="flex items-center gap-2 text-ui text-fg-muted">
        <Chip tone="outline">Ativa</Chip>
        Ao entrar, você digita a senha e um código do aplicativo autenticador.
      </p>
      <div className="flex gap-2">
        <Button onClick={() => void regenerate()}>Gerar novos códigos</Button>
        {me.role !== 'admin' && (
          <Button variant="danger" onClick={() => void disable()}>
            Desativar verificação
          </Button>
        )}
      </div>
      {me.role === 'admin' && <p className="text-meta text-fg-subtle">A administração exige a verificação em duas etapas.</p>}
    </div>
  )
}

function SetupPanel({ setup, onCancel, onConfirmed }: { setup: Setup; onCancel: () => void; onConfirmed: (codes: string[]) => void }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // QR gerado no navegador a partir da URI: o segredo não passa por nenhum serviço externo.
  const qr = useMemo(() => renderSVG(setup.otpauthUri, { ecc: 'M', border: 2, pixelSize: 1, blackColor: '#000', whiteColor: '#fff' }), [setup.otpauthUri])

  const submit = async (value = code) => {
    if (busy) return
    if (value.length !== 6) return setError('Digite os 6 dígitos que aparecem no aplicativo.')
    setBusy(true)
    setError(null)
    try {
      const r = await withSudo(() => post<{ recoveryCodes: string[] }>('/account/mfa/confirm', { code: value }))
      onConfirmed(r.recoveryCodes)
    } catch (e) {
      if (e instanceof SudoCancelled || expired(e)) return
      setError(message(e))
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex max-w-[560px] flex-col gap-5">
      <p className="text-ui text-fg-muted">
        No aplicativo autenticador do celular (Google Authenticator, Microsoft Authenticator, 1Password ou outro), adicione uma conta e
        leia o QR code.
      </p>
      <div className="flex flex-wrap items-start gap-6">
        {/* Seguro: o SVG sai do uqr aqui mesmo e só tem retângulos; o texto da URI nunca entra na marcação. */}
        <div
          role="img"
          aria-label="QR code para o aplicativo autenticador"
          className="size-48 shrink-0 rounded-control bg-white p-2 [&_svg]:size-full [&_svg]:[shape-rendering:crispEdges]"
          // seguro: SVG gerado no próprio navegador pelo uqr a partir do otpauth do servidor; só retângulos, sem texto
          dangerouslySetInnerHTML={{ __html: qr }}
        />
        <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
          <p className="text-meta text-fg-subtle">Sem câmera? Digite esta chave no aplicativo:</p>
          <p className="font-code text-ui break-all text-fg">{setup.secret.replace(/(.{4})(?=.)/g, '$1 ')}</p>
          <Button size="sm" icon={<CopyIcon />} onClick={() => void copy(setup.secret, 'Chave copiada.')}>
            Copiar chave
          </Button>
        </div>
      </div>
      <form
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Field label="Digite o código de 6 dígitos" className="max-w-56">
          <CodeInput autoFocus value={code} onChange={setCode} onComplete={(c) => void submit(c)} readOnly={busy} />
        </Field>
        {error && (
          <p role="alert" className="text-ui text-critical">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={busy}>
            Ativar
          </Button>
          <Button onClick={onCancel}>Cancelar</Button>
        </div>
      </form>
    </div>
  )
}

function RecoveryCodes({ codes, email, onDone }: { codes: string[]; email: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false)

  const save = () => {
    const text = [
      'deck.slides: códigos de recuperação',
      `Conta: ${email}`,
      `Gerados em ${new Date().toLocaleString('pt-BR')}`,
      '',
      ...codes,
      '',
      'Cada código funciona uma vez. Guarde este arquivo em local seguro.',
      '',
    ].join('\n')
    download('deck-slides-codigos-de-recuperacao.txt', text, 'text/plain;charset=utf-8')
    setSaved(true)
  }

  const finish = async () => {
    if (
      !saved &&
      !(await confirm({
        title: 'Fechar sem guardar os códigos?',
        body: 'Eles não aparecem de novo. Sem os códigos e sem o aplicativo, só a administração consegue liberar o seu acesso.',
        confirm: 'Fechar sem guardar',
      }))
    )
      return
    onDone()
  }

  return (
    <div className="flex max-w-[560px] flex-col gap-4">
      <div>
        <h3 className="text-ui font-semibold text-fg">Códigos de recuperação</h3>
        <p className="mt-1 text-ui text-fg-muted">Se perder o acesso ao aplicativo, entre com um destes códigos. Eles aparecem só agora.</p>
      </div>
      <ul className="grid grid-cols-2 gap-x-8 gap-y-1 rounded-control border border-line bg-canvas px-4 py-3 font-code text-read tabular-nums">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <p className="text-ui font-medium text-fg">Guarde estes códigos em local seguro. Cada código funciona uma vez.</p>
      <div className="flex flex-wrap gap-2">
        <Button
          icon={<CopyIcon />}
          onClick={() => {
            void copy(codes.join('\n'), 'Códigos copiados.')
            setSaved(true)
          }}
        >
          Copiar códigos
        </Button>
        <Button icon={<DownloadSimpleIcon />} onClick={save}>
          Baixar arquivo .txt
        </Button>
        <Button variant="primary" className="ml-auto" onClick={() => void finish()}>
          Concluir
        </Button>
      </div>
    </div>
  )
}
