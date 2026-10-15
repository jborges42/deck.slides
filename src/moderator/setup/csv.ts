// Planilhas de participantes: leitura do que foi colado ou enviado (CSV/TSV) e geração dos arquivos de saída.
// Sem DOM: roda também no `node --test` (csv.test.ts).
import { normalize } from '../../../shared/types.ts'

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Separador pela primeira linha: tabulação (colado do Excel/Planilhas), ';' (Excel em pt-BR) e por fim ','. */
export function delimiter(text: string): string {
  const first = text.split(/\r\n|\r|\n/).find((l) => l.trim()) ?? ''
  return first.includes('\t') ? '\t' : first.includes(';') ? ';' : ','
}

/** Registros com a linha onde começam. Campo entre aspas aceita separador, quebra de linha e "" (aspas escapadas). */
export function parseRows(text: string, sep = delimiter(text)): { line: number; cells: string[] }[] {
  const rows: { line: number; cells: string[] }[] = []
  let cells: string[] = []
  let cell = ''
  let quoted = false
  let line = 1
  let start = 1
  const end = () => {
    cells.push(cell)
    if (cells.some((c) => c.trim())) rows.push({ line: start, cells })
    cells = []
    cell = ''
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') cell += text[i++]
      else if (ch === '"') quoted = false
      else {
        if (ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) line++
        cell += ch
      }
    } else if (ch === '"' && !cell) quoted = true
    else if (ch === sep) {
      cells.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      end()
      start = ++line
    } else cell += ch
  }
  if (cell || cells.length) end()
  return rows
}

type Column = 'name' | 'email' | 'group'
const ALIASES: Record<string, Column> = {
  nome: 'name',
  name: 'name',
  nomecompleto: 'name',
  participante: 'name',
  email: 'email',
  mail: 'email',
  grupo: 'group',
  turma: 'group',
  group: 'group',
  equipe: 'group',
}
const alias = (cell: string) => ALIASES[normalize(cell).replace(/[^a-z]/g, '')]

export interface Person {
  name: string
  email: string
  group: string
}

export interface Reading {
  people: (Person & { line: number })[]
  /** Uma mensagem por linha deixada de fora: erro de validação ou e-mail repetido. */
  issues: { kind: 'error' | 'repeated'; text: string }[]
  /** Problema que impede a importação inteira. */
  problem: string | null
}

export const MAX_IMPORT = 5000

/**
 * Lê a lista colada ou enviada. Com cabeçalho (nome/name, email/e-mail, grupo/turma/group), as colunas são achadas
 * pelo nome; sem cabeçalho, valem na ordem nome, e-mail, grupo. E-mails já cadastrados (`known`) ou repetidos
 * na própria lista ficam de fora.
 */
export function readPeople(text: string, known: string[]): Reading {
  const rows = parseRows(text)
  const out: Reading = { people: [], issues: [], problem: null }
  if (!rows.length) return out
  const named = rows[0].cells.map(alias)
  const header = named.some(Boolean)
  const cols: (Column | undefined)[] = header ? named : ['name', 'email', 'group']
  if (!cols.includes('name')) {
    out.problem = 'Nenhuma coluna de nome encontrada. Use “Nome” no cabeçalho ou deixe o nome na primeira coluna.'
    return out
  }
  const seen = new Map<string, number>(known.filter(Boolean).map((e) => [e.toLowerCase(), 0])) // 0 = já cadastrado
  for (const { line, cells } of header ? rows.slice(1) : rows) {
    const value = (c: Column) => (cells[cols.indexOf(c)] ?? '').replace(/\s+/g, ' ').trim()
    const p = { name: value('name'), email: value('email'), group: value('group') }
    const error = !p.name
      ? 'nome vazio'
      : p.email && !EMAIL.test(p.email)
        ? `e-mail inválido (“${p.email}”)`
        : p.name.length > 120
          ? 'nome com mais de 120 caracteres'
          : p.email.length > 200
            ? 'e-mail com mais de 200 caracteres'
            : p.group.length > 120
              ? 'grupo com mais de 120 caracteres'
              : null
    if (error) {
      out.issues.push({ kind: 'error', text: `Linha ${line}: ${error}.` })
      continue
    }
    const key = p.email.toLowerCase()
    const first = key ? seen.get(key) : undefined
    if (first !== undefined) {
      out.issues.push({
        kind: 'repeated',
        text: first ? `Linha ${line}: e-mail repetido na linha ${first} (${p.email}).` : `Linha ${line}: e-mail já cadastrado (${p.email}).`,
      })
      continue
    }
    if (key) seen.set(key, line)
    out.people.push({ ...p, line })
  }
  if (out.people.length > MAX_IMPORT)
    out.problem = `A lista tem ${out.people.length.toLocaleString('pt-BR')} participantes. Importe no máximo ${MAX_IMPORT.toLocaleString('pt-BR')} por vez.`
  return out
}

/** Valor que uma planilha leria como fórmula (=, +, -, @) ganha um apóstrofo: nomes vêm do público na entrada aberta. */
const inert = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v)

/** CSV para o Excel em pt-BR: separador ';', BOM de UTF-8 (acentos) e quebras CRLF. */
export function toCSV(rows: string[][]): string {
  const cell = (v: string) => {
    const s = inert(v)
    return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return `﻿${rows.map((r) => r.map(cell).join(';')).join('\r\n')}\r\n`
}

/** Linhas separadas por tabulação, prontas para colar numa planilha. */
export const toTSV = (rows: string[][]) => rows.map((r) => r.map((v) => inert(v.replace(/[\t\r\n]+/g, ' '))).join('\t')).join('\n')

/** Texto de um arquivo enviado: UTF-8; se não for, Windows-1252 (o "CSV" padrão do Excel em pt-BR). */
export async function readText(file: Blob): Promise<string> {
  const buf = await file.arrayBuffer()
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return new TextDecoder('windows-1252').decode(buf)
  }
}
