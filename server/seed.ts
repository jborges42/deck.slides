// Dados de demonstração para testar o sistema sem montar tudo à mão.
// Uso: `pnpm seed` (com ou sem o `pnpm dev` rodando). Cria a conta demo se não houver nenhuma conta.
import { DEFAULT_SETTINGS, DEFAULT_THEME, defaultLive, type SceneBody } from '../shared/types.ts'
import { batch, get, newCode, newId, newPin, run, type Statement } from './db.ts'
import { hashPassword } from './auth.ts'

const DEMO = { name: 'Moderação demo', email: 'demo@deck.local', password: 'demo-deck-2026' }

let moderator = await get<{ email: string }>('SELECT email FROM moderators LIMIT 1')
if (!moderator) {
  await run(
    'INSERT INTO moderators (id, name, email, password, created_at) VALUES (?, ?, ?, ?, ?)',
    newId(),
    DEMO.name,
    DEMO.email,
    await hashPassword(DEMO.password),
    Date.now(),
  )
  moderator = { email: DEMO.email }
}

const scenes: [string, SceneBody][] = [
  ['Abertura', { type: 'title', content: { kicker: 'Semana de Engenharia 2026', title: 'Arquitetura de software para sistemas ao vivo', body: 'Auditório principal\nTransmissão para os polos' } }],
  ['Agenda', { type: 'title', content: { kicker: 'Programação', title: 'O que vamos ver hoje', body: '19:00 Abertura\n19:15 Palestra principal\n20:15 Perguntas da plateia\n20:45 Encerramento' } }],
  ['Perguntas em destaque', { type: 'questions', content: { title: 'Perguntas', layout: 'spotlight', max: 1, showAuthor: true, showLikes: false } }],
  ['Mural de perguntas', { type: 'questions', content: { title: 'Perguntas da plateia', layout: 'list', max: 3, showAuthor: true, showLikes: true } }],
  ['Intervalo', { type: 'timer', content: { title: 'Intervalo', mode: 'countdown', durationSec: 600, warnSec: 120, criticalSec: 30, onEnd: 'message', endText: 'Retomando' } }],
  ['Tempo de fala', { type: 'timer', content: { title: 'Tempo de fala', mode: 'countdown', durationSec: 300, warnSec: 60, criticalSec: 15, onEnd: 'overtime', endText: 'Tempo encerrado' } }],
]

const people = [
  'Ana Souza', 'Bruno Lima', 'Carla Mendes', 'Diego Rocha', 'Eduarda Alves', 'Felipe Castro', 'Gabriela Nunes', 'Henrique Prado',
  'Isabela Teixeira', 'João Pedro Martins', 'Karina Duarte', 'Lucas Ferreira', 'Marina Lopes', 'Nicolas Barbosa', 'Olívia Cardoso',
  'Paulo Henrique Dias', 'Rafaela Moreira', 'Samuel Ribeiro', 'Tatiane Gomes', 'Vinícius Araújo',
]

const questions: [number, string, 'pending' | 'approved' | 'answered' | 'rejected', boolean][] = [
  [0, 'Como vocês lidam com a reconexão quando a rede do auditório cai no meio da apresentação?', 'pending', false],
  [3, 'Server-Sent Events escala bem para milhares de celulares ao mesmo tempo?', 'pending', false],
  [5, 'Qual foi a decisão de arquitetura que vocês mais se arrependem de ter tomado?', 'pending', true],
  [7, 'Vale a pena usar SQLite em produção para esse tipo de sistema?', 'approved', false],
  [9, 'Como garantir que o cronômetro do telão fique sincronizado com o do console?', 'approved', false],
  [11, 'Que cuidados de acessibilidade são necessários numa tela vista a 30 metros?', 'approved', true],
  [13, 'Vocês testam a interface em projetores com pouco contraste?', 'answered', false],
  [15, 'Qual a diferença entre prévia e no ar na prática?', 'answered', false],
  [17, 'Isso aqui não tem nada a ver com a palestra.', 'rejected', false],
]

const id = await (async () => {
  let code: string
  do code = newCode()
  while (await get('SELECT 1 FROM events WHERE id = ?', code))
  return code
})()
const now = Date.now()
const pin = newPin()
const tokens: string[] = []

// Tudo numa ida só ao banco (que pode ser o Turso, do outro lado da rede).
const stmts: Statement[] = []
const add = (sql: string, ...args: Statement['args']) => void stmts.push({ sql, args })
{
  add(
    'INSERT INTO events (id, name, pin, settings, theme, live, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    'Aula magna de arquitetura de software',
    pin,
    JSON.stringify({ ...DEFAULT_SETTINGS, openJoin: true, flagWords: ['arrependem'] }),
    JSON.stringify({ ...DEFAULT_THEME, footer: '#semanadeengenharia' }),
    JSON.stringify(defaultLive()),
    now,
  )
  const sceneIds = scenes.map(([name, s], i) => {
    const sid = newId()
    add('INSERT INTO scenes (id, event_id, position, type, name, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', sid, id, i, s.type, name, JSON.stringify(s.content), now)
    return sid
  })
  const pids = people.map((name, i) => {
    const pid = newId()
    const token = newId(18)
    tokens.push(token)
    add(
      'INSERT INTO participants (id, event_id, name, email, grp, token, joined_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      pid,
      id,
      name,
      `${name.split(' ')[0]!.toLowerCase()}@exemplo.com`.normalize('NFD').replace(/\p{M}/gu, ''),
      i % 2 ? 'Turma B' : 'Turma A',
      token,
      i < 12 ? now - (20 - i) * 60_000 : null,
      now,
    )
    return pid
  })
  questions.forEach(([who, text, status, flagged], i) => {
    const qid = newId()
    add(
      `INSERT INTO questions (id, event_id, participant_id, author, anonymous, original, text, status, screen, flagged, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      qid,
      id,
      pids[who]!,
      people[who]!,
      i === 4 ? 1 : 0,
      text,
      text,
      status,
      status === 'approved' && i === 3 ? 0 : null,
      flagged ? 1 : 0,
      now - (questions.length - i) * 90_000,
    )
    if (status === 'approved' || status === 'answered')
      pids.slice(0, 3 + i).forEach((pid) => add('INSERT INTO likes (question_id, participant_id) VALUES (?, ?) ON CONFLICT DO NOTHING', qid, pid))
  })
  add(`INSERT INTO reactions (event_id, scene_id, kind, count) VALUES (?, ?, 'applause', 48), (?, ?, 'love', 21)`, id, sceneIds[0]!, id, sceneIds[0]!)
}
await batch(stmts)

const base = process.env.PUBLIC_URL ?? 'http://localhost:5173'
console.info(`
Evento de demonstração criado.

  Console:           ${base}/eventos/${id}
  Conta:             ${moderator.email}${moderator.email === DEMO.email ? `  (senha: ${DEMO.password})` : ''}
  PIN do evento:     ${pin}
  Tela (pareamento): ${base}/tela
  Entrada aberta:    ${base}/e/${id}
  Convite (Ana):     ${base}/convite/${tokens[0]}
  Convite (Bruno):   ${base}/convite/${tokens[1]}
`)
