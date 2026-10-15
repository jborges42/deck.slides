// Autoteste do pnpm lint: cada regra com um caso que deve acusar e outro parecido que não deve.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lintSource } from './lint.ts'

const deps = new Set(['hono', 'zod', '@hono/node-server'])
/** Linhas do arquivo (a primeira é a linha 1) -> "linha:regra" de cada achado. */
const lint = (file: string, ...lines: string[]) => lintSource(file, lines.join('\n'), { runtimeDeps: deps }).map((f) => `${f.line}:${f.rule}`)

test('exclamação em texto da interface, não em operadores nem em classes', () => {
  const found = lint(
    'src/a.tsx',
    'const a = <p>Pronto!</p>',
    "const b = 'Olá, tudo certo!'",
    "const c = x !== y && !z ? 'a' : \"b\"",
    'const d = <p>Evento {nome}!</p>',
    'const e = `Olá, ${nome}!`',
    'const f = <div className="mt-0! flex" />',
    "if (!ok) throw new Error('Não foi possível salvar. Tente de novo.')",
  )
  assert.deepEqual(found, ['1:exclamacao', '2:exclamacao', '4:exclamacao', '5:exclamacao'])
})

test('emoji em qualquer lugar; símbolos de teclado não contam', () => {
  assert.deepEqual(lint('src/a.tsx', 'const a = <p>Feito ✅</p>', 'const k = <Kbd>⌘K ↑ ↓</Kbd>', '// comentário 🚀'), ['1:emoji', '3:emoji'])
})

test('palavras proibidas só em texto, não em chaves de código nem em comentários', () => {
  const found = lint(
    'src/a.tsx',
    'const a = <p>Uma jornada incrível</p>',
    "if (kind === 'insight') react()",
    "const b = 'Insight do dia'",
    '// mergulhar no código: comentário não conta',
    "const c = 'Pergunta enviada com sucesso.'",
    "const d = 'Seja bem-vindo'",
    "const e = 'Elevador do prédio'",
    "const f = 'Zerar cronômetro'",
  )
  assert.deepEqual(found, ['1:palavra-proibida', '3:palavra-proibida', '5:palavra-proibida', '6:palavra-proibida'])
})

test('leitor léxico: regex × divisão, genéricos × JSX', () => {
  assert.deepEqual(
    lint('server/a.ts', "const r = /it's! \"x\"/g.test(s) ? a / b / c : 0", "const s = 'Pronto!' // isn't it", "const t = x / 2 + 'ok!'"),
    ['2:exclamacao', '3:exclamacao'],
  )
  const found = lint(
    'src/a.tsx',
    "const [v, setV] = useState<string>('')",
    'const f = <T,>(x: T) => x',
    "const ok = a < b && c > d ? 'sim' : 'não'",
    'const el = <Select<Modo> value={v} onChange={(m) => setV(m)} label="Modo" />',
    "const msg = 'Feito!'",
  )
  assert.deepEqual(found, ['5:exclamacao'])
})

test('classes proibidas pelo DESIGN.md, só no cliente', () => {
  const found = lint(
    'src/a.tsx',
    'const a = <div className="shadow-md rounded-2xl bg-gray-500 text-fg shadow-none" />',
    'const b = <div className="hover:bg-indigo-500 uppercase tracking-tight" />',
    "const c = <div className={cx('border-l-4 animate-pulse transition-all backdrop-blur-sm bg-linear-to-r', ok && 'font-mono')} />",
    'const d = <p className="uppercase">PIN</p>',
    'const e = <div className="rounded-control rounded-full border-l text-white bg-black/50 tally-program" />',
    'const f = <p>O texto pode falar de shadow-md sem problema</p>',
    'const g = <input className="font-code tracking-[0.2em] uppercase" />',
  )
  assert.deepEqual(found, ['1:classe-proibida', '1:classe-proibida', '1:classe-proibida', '2:classe-proibida', '2:classe-proibida', ...Array(6).fill('3:classe-proibida')])
  assert.deepEqual(lint('server/a.ts', "const s = 'shadow-md bg-gray-500'"), [])
})

test('ícones proibidos e import do pacote raiz do Phosphor', () => {
  const found = lint(
    'src/a.tsx',
    "import { Sparkles } from 'lucide-react'",
    "import { PlayIcon } from '@phosphor-icons/react'",
    "import { SparkleIcon } from '@phosphor-icons/react/Sparkle'",
    "import { PlayIcon as Play } from '@phosphor-icons/react/Play'",
    "import { IconContext } from '@phosphor-icons/react/dist/lib/context'",
    "// import x from 'lucide-react'",
  )
  assert.deepEqual(found, ['1:icone-proibido', '2:icone-proibido', '3:icone-proibido'])
})

test('servidor só importa pacotes de "dependencies" em tempo de execução', () => {
  const found = lint(
    'server/a.ts',
    "import { Hono } from 'hono'",
    "import { getConnInfo } from '@hono/node-server/conninfo'",
    "import { renderSVG } from 'uqr'",
    "import type { ReactNode } from 'react'",
    "import { readFileSync } from 'node:fs'",
    "import path from 'path'",
    "const m = await import('react-dom')",
    "import { x } from '../shared/types.ts'",
  )
  assert.deepEqual(found, ['3:dependencia', '7:dependencia'])
  assert.deepEqual(lint('src/a.tsx', "import { useState } from 'react'"), [])
})

test('HTML injetado só em arquivo revisado e com justificativa na linha de cima', () => {
  const allowed = lint(
    'src/stage/overlays.tsx',
    'const a = <div',
    '  // seguro: SVG gerado pelo uqr a partir da URL; nenhum texto do usuário vira marcação',
    '  dangerouslySetInnerHTML={{ __html: svg }}',
    '/>',
    'const b = <div dangerouslySetInnerHTML={{ __html: svg }} />',
  )
  assert.deepEqual(allowed, ['5:html-inseguro'])
  const other = lint(
    'src/x.tsx',
    '// seguro: confie em mim',
    'const a = <div dangerouslySetInnerHTML={{ __html: html }} />',
    'el.innerHTML = texto',
    'const lido = el.innerHTML',
    "const s = 'dangerouslySetInnerHTML'",
  )
  assert.deepEqual(other, ['2:html-inseguro', '3:html-inseguro'])
})

test('eval, target=_blank, window.open e http:// no cliente', () => {
  const found = lint(
    'src/a.tsx',
    'const a = <a href={url} target="_blank">Abrir</a>',
    'const b = <a href={url} target="_blank" rel="noopener">Abrir</a>',
    'const c = <a target="_blank" onClick={() => go()} rel="noreferrer">Abrir</a>',
    'window.open(url)',
    "window.open(url, '_blank', 'noopener')",
    'eval(code)',
    "const f = new Function('return 1')",
    "const s = 'não use eval(x)'",
    "const u = 'http://exemplo.com/a'",
    'const v = <svg xmlns="http://www.w3.org/2000/svg" />',
    "const w = 'Use um endereço que comece com http:// ou https://.'",
    "const y = 'http://localhost:3000'",
    "console.log('no cliente não conta')",
  )
  assert.deepEqual(found, ['1:target-blank', '4:target-blank', '6:eval', '7:eval', '9:http'])
})

test('servidor: console.log e process.env na resposta', () => {
  const found = lint(
    'server/a.ts',
    "console.log('oi')",
    "console.error('Falhou ao salvar', err)",
    "app.get('/x', (c) => c.json({",
    '  token: process.env.SETUP_TOKEN,',
    '  setup: !!process.env.SETUP_TOKEN,',
    "  prod: process.env.NODE_ENV === 'production',",
    '}))',
    'const port = Number(process.env.PORT)',
    "const u = 'http://exemplo.com'",
  )
  assert.deepEqual(found, ['1:console-log', '4:env-na-resposta'])
})

test('"lint-ok:" com motivo na linha de cima libera a linha seguinte', () => {
  const found = lint(
    'src/a.tsx',
    '// lint-ok: nome do programa do cliente',
    "const a = 'Jornada'",
    '// lint-ok:',
    "const b = 'Jornada'",
    'const c = <p>',
    '  {/* lint-ok: citação literal do palestrante */}',
    '  Insight!',
    '</p>',
  )
  assert.deepEqual(found, ['4:palavra-proibida'])
  // Template de várias linhas: o comentário acima do literal vale para ele inteiro.
  assert.deepEqual(lint('server/a.ts', '// lint-ok: texto do edital, citado literalmente', 'const t = `Linha um', 'uma jornada incrível', '`'), [])
})

test('lista de palavras (dado) não é texto da interface; "Seguro:" vale com maiúscula', () => {
  assert.deepEqual(lint('server/a.ts', 'const LIST = `', 'senha acesso entrar bloqueado desbloquear liberado secret admin', 'deck evento`'), [])
  assert.deepEqual(lint('src/account/TwoStep.tsx', 'const a = <div', '  // Seguro: SVG do uqr, só retângulos', '  dangerouslySetInnerHTML={{ __html: qr }}', '/>'), [])
})
