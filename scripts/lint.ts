// Verificações que o TypeScript não faz: regras de texto e de visual do DESIGN.md e padrões de segurança.
// Sem dependências: um leitor léxico pequeno separa código, comentários, strings e texto JSX, e as regras
// olham só a parte certa (palavra proibida em comentário não conta; "!==" no código não é exclamação).
// Uso: pnpm lint. Exceção justificada: "// lint-ok: <motivo>" (ou {/* lint-ok: <motivo> */}) na linha de cima.
import { readFileSync, readdirSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { join, sep } from 'node:path'

export interface Finding {
  file: string
  line: number
  rule: string
  message: string
}

interface Literal {
  text: string
  start: number
  /** Começa logo depois de uma expressão (`{x}` no JSX, `${x}` no template): "!" no início ainda é texto. */
  afterExpr: boolean
  /** Texto entre tags JSX (não é string: não tem classes). */
  jsx: boolean
}

type Frame = { t: 'js'; depth: number } | { t: 'tpl' } | { t: 'tag'; angle: number } | { t: 'text'; depth: number }

// Depois destes tokens começa uma expressão: "/" abre regex (não é divisão) e "<" abre JSX (não é menor que).
const EXPR_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await'])
const isWord = (s: string) => /^[\p{L}\p{N}_$]/u.test(s)
const startsExpr = (prev: string) => (isWord(prev) ? EXPR_KEYWORDS.has(prev) : prev !== ')' && prev !== ']')
const WORD = /[\p{L}\p{N}_$]+/uy
// "<T," e "<T extends" num .tsx são parâmetros de tipo, não JSX.
const TYPE_PARAMS = /<[\p{L}_$][\p{L}\p{N}_$]*\s*(?:,|extends\b)/uy

/**
 * Separa o arquivo. `code`: sem comentários e sem o conteúdo de strings, regex e texto JSX (mesmas posições).
 * `bare`: só sem comentários. `literals`: conteúdo de strings, partes de template e texto JSX.
 */
export function scan(src: string, jsx: boolean) {
  const code = src.split('')
  const bare = src.split('')
  const literals: Literal[] = []
  const blank = (arr: string[], from: number, to: number) => {
    for (let k = from; k < to; k++) if (arr[k] !== '\n') arr[k] = ' '
  }
  const n = src.length
  const stack: Frame[] = [{ t: 'js', depth: 0 }]
  let prev = '' // último token do código
  let exprEnd = -1 // posição logo depois do "}" que fechou a última expressão embutida
  let i = 0

  const literal = (from: number, to: number, text = false) => {
    literals.push({ text: src.slice(from, to), start: from, afterExpr: from === exprEnd, jsx: text })
    blank(code, from, to)
  }
  const comment = (): boolean => {
    if (src[i] !== '/' || (src[i + 1] !== '/' && src[i + 1] !== '*')) return false
    const close = src[i + 1] === '/' ? src.indexOf('\n', i) : src.indexOf('*/', i + 2)
    const end = close < 0 ? n : src[i + 1] === '/' ? close : close + 2
    blank(code, i, end)
    blank(bare, i, end)
    i = end
    return true
  }
  // Fim da tag: ">" abre um elemento (o texto ganha um nível); "/>" fecha; sem nível aberto, o JSX acabou.
  const closeTag = (opens: boolean) => {
    stack.pop()
    const text = stack[stack.length - 1] as { t: 'text'; depth: number }
    if (opens) text.depth++
    else if (text.depth === 0) {
      stack.pop()
      prev = ')'
    }
  }

  while (i < n) {
    const f = stack[stack.length - 1]!
    const c = src[i]!
    if (f.t === 'tpl') {
      const start = i
      while (i < n && src[i] !== '`' && !(src[i] === '$' && src[i + 1] === '{')) i += src[i] === '\\' ? 2 : 1
      literal(start, Math.min(i, n))
      if (i >= n) break
      if (src[i] === '`') {
        stack.pop()
        prev = ')'
        i++
      } else {
        stack.push({ t: 'js', depth: 0 })
        prev = '{'
        i += 2
      }
      continue
    }
    if (f.t === 'text') {
      if (c === '{') {
        stack.push({ t: 'js', depth: 0 })
        prev = '{'
        i++
      } else if (c === '<' && src[i + 1] === '/') {
        const end = src.indexOf('>', i)
        i = end < 0 ? n : end + 1
        if (--f.depth <= 0) {
          stack.pop()
          prev = ')'
        }
      } else if (c === '<' && src[i + 1] === '>') {
        f.depth++
        i += 2
      } else if (c === '<') {
        stack.push({ t: 'tag', angle: 0 })
        i++
      } else {
        const start = i
        while (i < n && src[i] !== '<' && src[i] !== '{') i++
        literal(start, i, true)
      }
      continue
    }
    if (f.t === 'tag') {
      if (comment()) continue
      if (c === '"' || c === "'") {
        const end = src.indexOf(c, i + 1)
        const e = end < 0 ? n : end
        literal(i + 1, e)
        i = e + 1
      } else if (c === '{') {
        stack.push({ t: 'js', depth: 0 })
        prev = '{'
        i++
      } else if (c === '<') {
        f.angle++ // argumento de tipo: <Select<Modo> ...>
        i++
      } else if (c === '>' && f.angle > 0) {
        f.angle--
        i++
      } else if (c === '/' && src[i + 1] === '>') {
        i += 2
        closeTag(false)
      } else if (c === '>') {
        i++
        closeTag(true)
      } else i++
      continue
    }
    // código
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (comment()) continue
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
      literal(i + 1, Math.min(j, n))
      i = j + 1
      prev = ')'
      continue
    }
    if (c === '`') {
      stack.push({ t: 'tpl' })
      i++
      continue
    }
    if (c === '/' && startsExpr(prev)) {
      let j = i + 1
      let cls = false
      while (j < n && src[j] !== '\n' && (cls || src[j] !== '/')) {
        if (src[j] === '\\') j++
        else if (src[j] === '[') cls = true
        else if (src[j] === ']') cls = false
        j++
      }
      if (src[j] === '/') {
        blank(code, i + 1, j)
        i = j + 1
        while (/[a-z]/i.test(src[i] ?? '')) i++
        prev = ')'
        continue
      }
    }
    if (c === '<' && jsx && startsExpr(prev) && prev !== '!' && /[\p{L}>]/u.test(src[i + 1] ?? '')) {
      TYPE_PARAMS.lastIndex = i
      if (!TYPE_PARAMS.test(src)) {
        if (src[i + 1] === '>') {
          stack.push({ t: 'text', depth: 1 })
          i += 2
        } else {
          stack.push({ t: 'text', depth: 0 }, { t: 'tag', angle: 0 })
          i++
        }
        continue
      }
    }
    if (c === '{') {
      f.depth++
      prev = '{'
      i++
      continue
    }
    if (c === '}') {
      i++
      if (f.depth === 0 && stack.length > 1) {
        stack.pop() // fim de ${...} ou de {...} no JSX
        exprEnd = i
      } else {
        f.depth--
        prev = '}'
      }
      continue
    }
    WORD.lastIndex = i
    const word = WORD.exec(src)
    if (word) {
      prev = word[0]
      i += word[0].length
    } else if (c === '=' && src[i + 1] === '>') {
      prev = '=>'
      i += 2
    } else {
      prev = c
      i++
    }
  }
  return { code: code.join(''), bare: bare.join(''), literals }
}

// ---------- regras ----------

// Lista de classes ("flex mt-0! hover:bg-raised") e chaves de código ("insight", "event-stream") não são texto da interface.
const looksLikeClasses = (text: string) => {
  const tokens = text.trim().split(/\s+/)
  return tokens.every((t) => /^[a-z0-9!@:/.\-_[\]()&>=%#,'*+~]+$/.test(t)) && tokens.some((t) => /[-:[]/.test(t))
}
const looksLikeKey = (text: string) => /^[a-z0-9_$.:/#@-]*$/.test(text)
// Lista de palavras em minúsculas sem pontuação (ex.: senhas comuns) é dado, não frase da interface.
const looksLikeWordList = (text: string) => /^[a-z0-9\s]+$/.test(text) && text.trim().split(/\s+/).length >= 8

const EXCLAIM = /[\p{L}\p{N}”’»)]!(?=[\s\\)\]"'”’»]|$)/gu
const EXCLAIM_START = /^!(?=[\s\\)\]"'”’»]|$)/u

// DESIGN.md §7: palavras proibidas, "com sucesso", "Ops", desculpas, "Clique aqui", "Bem-vindo(a)" e o glossário.
const BANNED = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${[
    'potencializ\\p{L}*',
    'elev(?:ar|e|a|am|ando)',
    'desbloque\\p{L}*',
    'revolucion\\p{L}*',
    'turbin(?:ar|e|ado|ada|ados|adas)',
    'alavanc\\p{L}*',
    'alavanqu\\p{L}*',
    'mergulh\\p{L}*',
    'jornadas?',
    'experi[eê]ncias? (?:[uú]nicas?|incr[ií]ve(?:l|is)|fluidas?)',
    'poderos[oa]s?',
    'inovador(?:a|es|as)?',
    'disruptiv[oa]s?',
    'din[aâ]mic[oa]s?',
    'crucia(?:l|is)',
    'fundamenta(?:l|is)',
    'insights?',
    'vale ressaltar',
    'fique [aà] vontade',
    'bem-vind\\p{L}*',
    'com sucesso',
    'o+ps',
    'desculp\\p{L}*',
    'clique aqui',
    'reset(?:ar|e|ado|ada)',
    'perguntas abertas',
  ].join('|')})(?![\\p{L}\\p{N}])`,
  'giu',
)

const PALETTE =
  /^(?:bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|outline|fill|stroke|from|via|to|decoration|divide|accent|caret|placeholder|shadow|inset-shadow|drop-shadow|text-shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|mauve|olive|mist|taupe)-(?:50|[1-9]00|950)(?:\/\S+)?$/
const CLASS_RULES: [RegExp, string][] = [
  [/^bg-(?:gradient|linear|radial|conic)-/, 'Gradiente é proibido (DESIGN.md §2). Use uma cor sólida do tema.'],
  [/^backdrop-blur/, 'Desfoque de fundo é proibido (DESIGN.md §2). Sobreposição = bg-raised + border-line.'],
  [/^(?:inset-|drop-|text-)?shadow-(?!none$)/, 'Sombra é proibida (DESIGN.md §2). A elevação vem da luminosidade: canvas, surface, raised.'],
  [/^transition-all$/, 'transition-all é proibido (DESIGN.md §5). Anime só a propriedade que muda (ex.: transition-colors).'],
  [/^animate-(?:bounce|pulse|ping)$/, 'Animação chamativa é proibida (DESIGN.md §5).'],
  [/^border-[lrse]-(?:[2-9]|\[)/, 'Faixa colorida só na lateral é proibida (DESIGN.md §2). Use moldura nos quatro lados (tally-program, tally-preview).'],
  [/^rounded(?:-[a-z]{1,2})?-(?:xs|sm|md|lg|xl|[2-4]xl)$/, 'Esse raio não existe no tema. Use rounded-chip, rounded-control, rounded-panel ou rounded-monitor (DESIGN.md §2).'],
  [/^font-mono$/, 'font-mono não existe no tema. Para PIN e códigos, use font-code (DESIGN.md §3).'],
  [PALETTE, 'A paleta padrão do Tailwind foi apagada (DESIGN.md §2). Use os tokens do tema (bg-surface, text-fg-muted, border-line…).'],
]

/** Classe sem variantes (hover:, md:, [&>svg]:) e sem marcadores de !important ou valor negativo. */
function utility(token: string) {
  let depth = 0
  let cut = 0
  for (let k = 0; k < token.length; k++) {
    const ch = token[k]
    if (ch === '[' || ch === '(') depth++
    else if (ch === ']' || ch === ')') depth--
    else if (ch === ':' && depth === 0) cut = k + 1
  }
  return token.slice(cut).replace(/^!|!$/g, '').replace(/^-/, '')
}

/** Arquivos revisados que podem injetar HTML; cada uso ainda exige "// seguro: <motivo>" na linha de cima. */
export const SAFE_HTML = new Set(['src/stage/overlays.tsx', 'src/account/TwoStep.tsx']) // QR gerado no cliente pelo uqr: só retângulos

const RAW_HTML = /\bdangerouslySetInnerHTML\b|\.(?:inner|outer)HTML\s*\+?=(?!=)|\binsertAdjacentHTML\s*\(|\bdocument\.write(?:ln)?\s*\(/g
const RESPONSE_CALL = /\b(?:c|ctx|context)\.(?:json|text|html|body)\s*\(|\bnew\s+Response\s*\(|\bResponse\.json\s*\(|\.writeSSE\s*\(/g
const IMPORT =
  /\b(import|export)\b(\s+type\b)?((?:(?!\b(?:import|export)\b)[^;'"`])*?)\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]/g

/** Texto entre o "(" em `open` e o ")" correspondente, contado em `code` (parênteses dentro de strings não contam). */
function callEnd(code: string, open: number) {
  let depth = 0
  for (let k = open; k < code.length; k++) {
    if (code[k] === '(') depth++
    else if (code[k] === ')' && --depth === 0) return k
  }
  return code.length
}

export interface Options {
  /** Pacotes de "dependencies": servidor e shared só podem importar estes em tempo de execução. */
  runtimeDeps?: Set<string>
}

/** `file` é o caminho relativo à raiz do projeto, com "/" (decide quais regras valem). */
export function lintSource(file: string, src: string, options: Options = {}): Finding[] {
  const client = file.startsWith('src/')
  const server = file.startsWith('server/')
  const runtime = server || file.startsWith('shared/')
  const tsx = file.endsWith('.tsx')
  const { code, bare, literals } = scan(src, tsx)
  const lines = src.split('\n')
  const lineStarts = [0]
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') lineStarts.push(k + 1)
  const lineOf = (pos: number) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid]! <= pos) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
  const marked = (line: number, tag: string) => new RegExp(`(?://|/\\*)\\s*${tag}:\\s*\\S`, 'i').test(lines[line - 2] ?? '')
  const out: Finding[] = []
  const seen = new Set<string>()
  // `anchor`: início do literal; "lint-ok" acima dele vale para o literal inteiro (template de várias linhas).
  const add = (pos: number, rule: string, message: string, anchor = pos) => {
    const line = lineOf(pos)
    const key = `${line}:${rule}:${message}`
    if (seen.has(key) || marked(line, 'lint-ok') || marked(lineOf(anchor), 'lint-ok')) return
    seen.add(key)
    out.push({ file, line, rule, message })
  }

  for (const m of src.matchAll(/\p{Extended_Pictographic}/gu))
    add(m.index, 'emoji', `Emoji ou símbolo pictográfico "${m[0]}" (DESIGN.md §6). Use um ícone Phosphor ou texto.`)

  for (const lit of literals) {
    const { text, start } = lit
    const classes = looksLikeClasses(text) || looksLikeWordList(text)
    if (!classes) {
      const hits = [...text.matchAll(EXCLAIM)].map((m) => m.index + 1)
      if (lit.afterExpr && EXCLAIM_START.test(text)) hits.push(0)
      for (const at of hits) add(start + at, 'exclamacao', '"!" em texto da interface (DESIGN.md §7). Reescreva a frase sem exclamação.', start)
    }
    if (!classes && !looksLikeKey(text))
      for (const m of text.matchAll(BANNED))
        add(start + m.index, 'palavra-proibida', `"${m[0]}" está na lista de palavras proibidas (DESIGN.md §7). Reescreva com palavras simples.`, start)
    if (client) {
      for (const m of text.matchAll(/http:\/\/([\w.-]+|\[[\w:]+\])/g))
        if (!/^(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|www\.w3\.org)$/.test(m[1]!))
          add(start + m.index, 'http', 'Endereço com http:// no cliente. Use https:// (ou um caminho relativo).')
    }
    if (client && !lit.jsx) {
      const used: string[] = []
      for (const t of text.matchAll(/\S+/g)) {
        const name = utility(t[0])
        used.push(name)
        for (const [re, message] of CLASS_RULES) if (re.test(name)) add(start + t.index, 'classe-proibida', `${name}: ${message}`)
      }
      // Em códigos (font-code: PIN, pareamento) caixa-alta espaçada é legibilidade, não rótulo.
      if (used.includes('uppercase') && used.some((u) => u.startsWith('tracking-')) && !used.includes('font-code'))
        add(start, 'classe-proibida', 'uppercase com tracking-* é proibido (DESIGN.md §3 e §9). Use sentence case, sem espaçamento extra.')
    }
  }

  for (const m of bare.matchAll(IMPORT)) {
    if (!code.startsWith(m[1] ?? 'import', m.index)) continue // a palavra estava num comentário ou string
    const spec = (m[4] ?? m[5])!
    const names = m[3] ?? ''
    if (spec === 'lucide-react' || spec.startsWith('lucide-react/'))
      add(m.index, 'icone-proibido', 'lucide-react é proibido (DESIGN.md §6). Use Phosphor, importado por ícone.')
    if (spec === '@phosphor-icons/react')
      add(m.index, 'icone-proibido', "Import do pacote raiz do Phosphor carrega todos os ícones. Use '@phosphor-icons/react/<Nome>' (DESIGN.md §6).")
    if (spec.startsWith('@phosphor-icons/react') && (/\/Sparkle$/.test(spec) || /\bSparkle(?:Icon)?\b/.test(names)))
      add(m.index, 'icone-proibido', 'O ícone Sparkle é proibido (DESIGN.md §6).')
    const bareSpec = !/^(?:\.|\/|node:)/.test(spec) && !isBuiltin(spec)
    if (runtime && options.runtimeDeps && bareSpec && !m[2]) {
      const pkg = spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/')
      if (!options.runtimeDeps.has(pkg))
        add(m.index, 'dependencia', `${pkg} não está em "dependencies": a imagem de produção (pnpm install --prod) não o instala. Mova para "dependencies" ou use import type.`)
    }
  }

  for (const m of code.matchAll(RAW_HTML)) {
    const line = lineOf(m.index)
    if (!SAFE_HTML.has(file))
      add(m.index, 'html-inseguro', 'Injeção de HTML fora da lista revisada (SAFE_HTML em scripts/lint.ts). Renderize como texto ou peça revisão de segurança.')
    else if (!marked(line, 'seguro'))
      add(m.index, 'html-inseguro', 'Injeção de HTML sem justificativa. Ponha "// seguro: <por que o conteúdo é confiável>" na linha de cima.')
  }

  for (const m of code.matchAll(/\beval\s*\(|\bnew\s+Function\s*\(/g))
    add(m.index, 'eval', 'eval e new Function executam texto como código. Use uma função ou JSON.parse.')

  if (tsx)
    for (const m of bare.matchAll(/\btarget\s*=\s*(?:\{\s*)?["'`]_blank["'`]/g)) {
      const from = bare.lastIndexOf('<', m.index)
      let depth = 0
      let to = m.index
      for (; to < bare.length; to++) {
        const ch = bare[to]
        if (ch === '{') depth++
        else if (ch === '}') depth--
        else if (ch === '>' && depth === 0) break
      }
      if (!/\brel\s*=\s*(?:\{\s*)?["'`][^"'`]*\bno(?:opener|referrer)\b/.test(bare.slice(from, to)))
        add(m.index, 'target-blank', 'target="_blank" sem rel="noopener": a página aberta controla esta aba. Acrescente rel="noopener noreferrer".')
    }
  for (const m of code.matchAll(/\bwindow\.open\s*\(/g)) {
    const open = m.index + m[0].length - 1
    if (!/\bno(?:opener|referrer)\b/.test(bare.slice(open, callEnd(code, open))))
      add(m.index, 'target-blank', "window.open sem 'noopener': a página aberta controla esta aba. Passe 'noopener,noreferrer' no terceiro argumento.")
  }

  if (server)
    for (const m of code.matchAll(/\bconsole\.(?:log|debug|trace)\s*\(/g))
      add(m.index, 'console-log', 'console.log no servidor. Para erros use console.error; para avisos de operação, console.info ou console.warn.')

  if (server)
    for (const m of code.matchAll(RESPONSE_CALL)) {
      const open = m.index + m[0].length - 1
      const args = code.slice(open, callEnd(code, open))
      for (const e of args.matchAll(/process\.env(?:\.\w+|\[[^\]]*\])?/g)) {
        const before = args.slice(0, e.index).trimEnd()
        const after = args.slice(e.index + e[0].length)
        if (before.endsWith('!') || /^\s*[!=]==?/.test(after)) continue // só um booleano sai na resposta
        add(open + e.index, 'env-na-resposta', 'Valor de process.env na resposta pode expor configuração ou segredo. Responda só o que o cliente precisa (ex.: um booleano).')
      }
    }

  return out.sort((a, b) => a.line - b.line)
}

// ---------- linha de comando ----------

if (import.meta.main) {
  const root = join(import.meta.dirname, '..')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
  const runtimeDeps = new Set(Object.keys(pkg.dependencies ?? {}))
  const files = ['src', 'server', 'shared']
    .flatMap((dir) => readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' }).map((f) => `${dir}/${f.split(sep).join('/')}`))
    .filter((f) => /\.tsx?$/.test(f) && !/\.(?:test|d)\.tsx?$/.test(f) && !f.startsWith('server/tests/'))
    .sort()
  const findings = files.flatMap((f) => {
    try {
      return lintSource(f, readFileSync(join(root, f), 'utf8'), { runtimeDeps })
    } catch {
      return [] // arquivo removido durante a leitura
    }
  })
  for (const f of findings) console.info(`${f.file}:${f.line}  ${f.rule}  ${f.message}`)
  const count = new Set(findings.map((f) => f.file)).size
  console.info(findings.length ? `\n${findings.length} problema(s) em ${count} arquivo(s).` : `lint: ${files.length} arquivos, nenhum problema.`)
  process.exitCode = findings.length ? 1 : 0
}
