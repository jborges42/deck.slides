// Leitor de planilhas de participantes e arquivos de saída. Rodar com `pnpm test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { delimiter, parseRows, readPeople, toCSV, toTSV } from './csv.ts'

test('separador pela primeira linha com conteúdo: tabulação, depois ";", depois ","', () => {
  assert.equal(delimiter('Nome\tE-mail;x,y'), '\t')
  assert.equal(delimiter('\nNome;E-mail,x'), ';')
  assert.equal(delimiter('Nome,E-mail'), ',')
})

test('aspas, quebra de linha dentro do campo e número da linha de cada registro', () => {
  assert.deepEqual(parseRows('a;"b;c"\r\n"linha\r\nquebrada";"aspas ""dentro"""\n\n x ;y'), [
    { line: 1, cells: ['a', 'b;c'] },
    { line: 2, cells: ['linha\r\nquebrada', 'aspas "dentro"'] },
    { line: 5, cells: [' x ', 'y'] },
  ])
})

test('colado do Excel: cabeçalho com sinônimos, validação por linha e repetidos de fora', () => {
  const pasted = [
    'Turma\tNome completo\tMatrícula\tE-mail',
    'A\tAna  Souza\t1\tana@exemplo.com',
    'B\t\t2\tsem@nome.com',
    'B\tBruno\t3\tana@exemplo',
    'C\tCarla\t4\tANA@exemplo.com',
    'C\tDiego\t5\tdiego@exemplo.com',
    'C\tEva\t6\t',
  ].join('\n')
  const r = readPeople(pasted, ['diego@exemplo.com'])
  assert.equal(r.problem, null)
  assert.deepEqual(r.people, [
    { name: 'Ana Souza', email: 'ana@exemplo.com', group: 'A', line: 2 },
    { name: 'Eva', email: '', group: 'C', line: 7 },
  ])
  assert.deepEqual(r.issues, [
    { kind: 'error', text: 'Linha 3: nome vazio.' },
    { kind: 'error', text: 'Linha 4: e-mail inválido (“ana@exemplo”).' },
    { kind: 'repeated', text: 'Linha 5: e-mail repetido na linha 2 (ANA@exemplo.com).' },
    { kind: 'repeated', text: 'Linha 6: e-mail já cadastrado (diego@exemplo.com).' },
  ])
})

test('sem cabeçalho, as colunas valem na ordem nome, e-mail, grupo', () => {
  assert.deepEqual(
    readPeople('Ana;ana@x.com;T1\nBia', []).people.map((p) => [p.name, p.email, p.group]),
    [
      ['Ana', 'ana@x.com', 'T1'],
      ['Bia', '', ''],
    ],
  )
  assert.notEqual(readPeople('E-mail;Grupo\na@x.com;T1', []).problem, null, 'cabeçalho sem coluna de nome')
})

test('saída para planilha: BOM, ";" e CRLF no CSV; fórmulas neutralizadas', () => {
  assert.equal(toCSV([['Nome', 'Grupo'], ['=SOMA(1)', 'a;b "c"']]), '﻿Nome;Grupo\r\n\'=SOMA(1);"a;b ""c"""\r\n')
  assert.equal(toTSV([['Nome', 'Link'], ['Ana\tSouza', 'https://x/i/1'], ['@ana', 'y']]), "Nome\tLink\nAna Souza\thttps://x/i/1\n'@ana\ty")
})
