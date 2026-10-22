// Contrato compartilhado entre servidor e cliente. Só tipos e funções puras.
import type { TokenName } from './screen-theme.ts'

export const REACTIONS = ['applause', 'love', 'like', 'insight', 'doubt', 'laugh'] as const
export type ReactionKind = (typeof REACTIONS)[number]

export type QuestionStatus = 'pending' | 'approved' | 'rejected' | 'answered'

export interface EventSettings {
  questionsOpen: boolean
  reactionsOpen: boolean
  openJoin: boolean // permite entrar sem convite (nome + PIN)
  identity: 'name' | 'choice' | 'anonymous' // nome sempre | participante escolhe | sempre anônimo
  screenName: 'first-initial' | 'full' | 'first' // como o nome aparece na tela
  maxLength: number // 100–500
  reactions: ReactionKind[]
  autoAnswer: boolean // ao destacar outra pergunta, a anterior vira "respondida"
  flagWords: string[] // termos sensíveis: marcam a pergunta, nunca rejeitam sozinhos
}

export interface FontChoice {
  family: string
  url?: string // fonte enviada pela organização; sem url = catálogo (pacote local ou Google Fonts)
}

export type Aspect = '16:9' | '16:10' | '4:3' | '21:9' | '32:9'

export interface Theme {
  preset: string
  // Cores: entradas do gerador de paleta (shared/screen-theme.ts) + ajustes manuais por token.
  brand: string
  background: string | null
  mode: 'auto' | 'dark' | 'light'
  contrast: 'standard' | 'high'
  overrides: Partial<Record<TokenName, string>>
  fonts: { heading: FontChoice; body: FontChoice; numbers: FontChoice; headingWeight: number }
  logo: string | null
  logoPosition: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'none'
  logoSize: number // altura em px no canvas de 1080
  backgroundImage: string | null
  backgroundDim: number // 0–0.95, véu da cor de fundo sobre a imagem
  aspect: Aspect
  align: 'left' | 'center'
  safe: number // margem de segurança, % da altura (0–10)
  scale: number // escala do texto (0.8–1.6)
  radius: number // px no canvas de 1080
  cardStyle: 'solid' | 'outline' | 'plain'
  transition: 'cut' | 'fade'
  transitionMs: number // duração da fusão (100–2000)
  standby: 'brand' | 'black' // tela de espera
  reactionsStyle: 'animated' | 'counter'
  footer: string // texto fixo no rodapé; vazio = sem rodapé
}

export interface TimerState {
  sceneId: string | null // cena de cronômetro que configurou este relógio; null = manual
  mode: 'countdown' | 'stopwatch'
  durationMs: number
  running: boolean
  startedAt: number // relógio do servidor quando iniciou (válido se running)
  elapsedMs: number // acumulado antes de startedAt
  label: string
  warnMs: number // aviso (âmbar) quando faltar isto
  criticalMs: number // crítico (vermelho) quando faltar isto
  onEnd: 'overtime' | 'stop' | 'message'
  endText: string
}

export interface PlaybackState {
  sceneId: string | null
  playing: boolean
  startedAt: number // relógio do servidor quando começou a tocar
  positionMs: number // posição em startedAt (ou posição pausada)
}

export interface LiveState {
  program: string | null // cena no ar
  preview: string | null // cena na prévia
  standby: boolean // tela de espera (tecla B)
  transition: 'cut' | 'fade' // transição usada no último corte
  takenAt: number // relógio do servidor do último corte
  overlays: { join: boolean; reactions: boolean }
  timer: TimerState
  playback: PlaybackState
  slides: Record<string, number> // slide atual de cada apresentação (id da cena -> índice); ausente = primeiro
}

export type SceneBody =
  | { type: 'title'; content: { kicker: string; title: string; body: string } }
  | { type: 'image'; content: { src: string; fit: 'contain' | 'cover'; caption: string } }
  | { type: 'video'; content: { src: string; fit: 'contain' | 'cover'; loop: boolean; autoplay: boolean } }
  // display "link": o site não abre dentro de outra página, então a tela mostra o endereço e um QR code.
  // Cenas antigas não têm o campo: valem como "page".
  | { type: 'embed'; content: { url: string; display?: 'page' | 'link' } }
  | {
      type: 'questions'
      content: { title: string; layout: 'spotlight' | 'list' | 'grid'; max: number; showAuthor: boolean; showLikes: boolean }
    }
  | {
      type: 'timer'
      content: {
        title: string
        mode: 'countdown' | 'stopwatch'
        durationSec: number
        warnSec: number
        criticalSec: number
        onEnd: TimerState['onEnd']
        endText: string
      }
    }
  // Apresentação: imagens dos slides (o PDF vira imagens no console). O slide atual fica em live.slides.
  | { type: 'slides'; content: { slides: string[] } }
  // Entrada em tela cheia: QR code da página do evento, endereço e PIN (o que a faixa de entrada mostra, em grande).
  | { type: 'join'; content: { title: string } }
  // Pasta do roteiro: título que agrupa as cenas seguintes até a próxima pasta. Nunca vai para a tela.
  | { type: 'section'; content: Record<string, never> }

/**
 * Resposta de POST /events/:id/embed-check: o site aceita aparecer dentro da tela? null = não deu para saber.
 * `url`: endereço final do mesmo site (com www ou https), quando o pedido redireciona para ele.
 */
export type EmbedCheck =
  | { embeddable: true; url?: string }
  | { embeddable: false; reason: 'blocked' | 'refused'; status?: number; url?: string }
  | { embeddable: null }

export type SceneType = SceneBody['type']
export type Scene = { id: string; name: string; position: number } & SceneBody
export type SceneContent<T extends SceneType> = Extract<SceneBody, { type: T }>['content']

export interface Question {
  id: string
  participantId: string | null
  author: string
  anonymous: boolean
  text: string
  original: string
  status: QuestionStatus
  screen: number | null // posição na tela; null = fora da tela
  flagged: boolean // contém termo sensível
  likes: number
  createdAt: number
}

export interface Participant {
  id: string
  name: string
  email: string
  group: string
  token: string
  source: 'invite' | 'open'
  blocked: boolean
  joinedAt: number | null
  online: boolean
  createdAt: number
}

export interface Media {
  id: string
  kind: 'image' | 'video' | 'font'
  name: string
  url: string
  mime: string
  size: number
  createdAt: number
}

export interface EventInfo {
  id: string // código curto do evento (ex.: "K7QX2M"), usado nas URLs
  name: string
  pin: string
  settings: EventSettings
  theme: Theme
  live: LiveState
  createdAt: number
}

export interface EventSummary {
  id: string
  name: string
  createdAt: number
  participants: number
  questions: number
  live: boolean // tem cena no ar
}

/** Pergunta como aparece na tela e no celular (autor null = anônima). */
export interface PublicQuestion {
  id: string
  text: string
  author: string | null
  likes: number
}

/** Tela pareada ao evento (computador da projeção). */
export interface ScreenInfo {
  id: string
  name: string
  online: boolean
  createdAt: number
  lastSeen: number | null
}

export interface ModeratorSnapshot {
  serverNow: number
  publicUrl: string | null // base pública para links; null = origem do navegador
  event: EventInfo
  scenes: Scene[]
  questions: Question[]
  participants: Participant[]
  media: Media[]
  screens: ScreenInfo[]
  presence: { participants: number; screens: number; moderators: number }
}

export interface ScreenSnapshot {
  serverNow: number
  publicUrl: string | null
  event: Pick<EventInfo, 'id' | 'name' | 'pin' | 'theme' | 'live'> & { reactions: ReactionKind[]; openJoin: boolean }
  program: Scene | null
  questions: PublicQuestion[]
}

export interface ParticipantSnapshot {
  serverNow: number
  event: {
    id: string
    name: string
    theme: Pick<Theme, 'brand' | 'contrast' | 'logo' | 'fonts'>
    settings: Pick<EventSettings, 'questionsOpen' | 'reactionsOpen' | 'identity' | 'maxLength' | 'reactions'>
  }
  me: { id: string; name: string }
  now: null | {
    sceneId: string
    type: SceneType
    label: string
    questions: (PublicQuestion & { liked: boolean })[]
  }
  mine: { id: string; text: string; status: QuestionStatus; onScreen: boolean; edited: boolean; createdAt: number }[]
}

/** Totais acumulados, enviados em mensagens `counts` (alta frequência). */
export interface Counts {
  reactions: Record<string, Partial<Record<ReactionKind, number>>> // por cena
  likes: Record<string, number> // por pergunta
}

export type LiveCommand =
  | { op: 'preview'; sceneId: string | null }
  | { op: 'take'; transition?: 'cut' | 'fade' }
  | { op: 'standby'; on: boolean }
  | { op: 'overlays'; join?: boolean; reactions?: boolean }
  | { op: 'timer'; action: 'start' | 'pause' | 'reset' }
  | { op: 'timer'; action: 'add'; ms: number }
  | { op: 'timer'; action: 'set'; mode: TimerState['mode']; durationMs: number; label: string }
  | { op: 'playback'; action: 'play' | 'pause' | 'restart' }
  | { op: 'slide'; sceneId?: string; to: 'next' | 'prev' | number } // sem sceneId: a apresentação no ar

export const DEFAULT_SETTINGS: EventSettings = {
  questionsOpen: true,
  reactionsOpen: true,
  openJoin: false,
  identity: 'name',
  screenName: 'first-initial',
  maxLength: 200,
  reactions: ['applause', 'love', 'insight', 'doubt'],
  autoAnswer: true,
  flagWords: [],
}

// Identidade do Conexão Profissional 2026, versão negativa do manual: fundo no Azul SENAI exato.
// O gerador escureceria o fundo para o texto passar 7:1 nos cartões; com cartões num azul pouco mais claro
// (texto branco a 7,95:1) o fundo fica na cor oficial. Títulos em Poppins; texto e números em Arial.
export const DEFAULT_THEME: Theme = {
  preset: 'conexao',
  brand: '#004098',
  background: '#004098',
  mode: 'dark',
  contrast: 'standard',
  overrides: { canvas: '#004098', surface: '#0C4DA8', raised: '#0C4DA8' },
  fonts: {
    heading: { family: 'Poppins' },
    body: { family: 'Arial' },
    numbers: { family: 'Arial' },
    headingWeight: 700,
  },
  logo: null,
  logoPosition: 'top-left',
  logoSize: 80, // logo horizontal da marca (3:1) legível no canto
  backgroundImage: null,
  backgroundDim: 0.6,
  aspect: '16:9',
  align: 'left',
  safe: 5,
  scale: 1,
  radius: 12,
  cardStyle: 'solid',
  transition: 'fade',
  transitionMs: 500,
  standby: 'brand',
  reactionsStyle: 'animated',
  footer: '',
}

export function defaultLive(): LiveState {
  return {
    program: null,
    preview: null,
    standby: false,
    transition: 'fade',
    takenAt: 0,
    overlays: { join: false, reactions: true },
    timer: {
      sceneId: null,
      mode: 'countdown',
      durationMs: 5 * 60_000,
      running: false,
      startedAt: 0,
      elapsedMs: 0,
      label: '',
      warnMs: 5 * 60_000,
      criticalMs: 60_000,
      onEnd: 'overtime',
      endText: 'Tempo encerrado',
    },
    playback: { sceneId: null, playing: false, startedAt: 0, positionMs: 0 },
    slides: {},
  }
}

/** Tempo decorrido do cronômetro no instante `now` (relógio do servidor). */
export function timerElapsed(t: TimerState, now: number): number {
  return t.elapsedMs + (t.running ? Math.max(0, now - t.startedAt) : 0)
}

/** Slide atual da apresentação, dentro da lista (slides removidos não deixam o índice para fora). */
export function slideIndex(live: Pick<LiveState, 'slides'>, s: { id: string; content: { slides: string[] } }): number {
  return Math.max(0, Math.min(live.slides[s.id] ?? 0, s.content.slides.length - 1))
}

/** Posição do vídeo no instante `now` (relógio do servidor). */
export function playbackPosition(p: PlaybackState, now: number): number {
  return p.positionMs + (p.playing ? Math.max(0, now - p.startedAt) : 0)
}

/** Nome exibido na tela conforme a configuração do evento ("Ana Souza" -> "Ana S."). */
export function publicAuthor(name: string, anonymous: boolean, format: EventSettings['screenName']): string | null {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (anonymous || !parts.length) return null
  if (format === 'full') return parts.join(' ')
  if (format === 'first' || parts.length === 1) return parts[0]
  return `${parts[0]} ${[...parts[parts.length - 1]][0].toUpperCase()}.` // por caractere: emoji não vira meio caractere
}

/** Perguntas que a cena de perguntas mostra: marcadas para a tela, aprovadas, na ordem de exibição. */
export function onScreen(questions: Question[], max: number, format: EventSettings['screenName']): PublicQuestion[] {
  return questions
    .filter((q) => q.screen !== null && (q.status === 'approved' || q.status === 'answered'))
    .sort((a, b) => a.screen! - b.screen!)
    .slice(0, max)
    .map((q) => ({ id: q.id, text: q.text, author: publicAuthor(q.author, q.anonymous, format), likes: q.likes }))
}

/** Normaliza para comparar textos e termos: minúsculas, sem acentos, sem letras repetidas, espaços simples. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/(\p{L})\1{2,}/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A pergunta contém algum termo sensível (palavra inteira)? */
export function hasFlagWord(text: string, words: string[]): boolean {
  // Pontuação vira espaço no texto e no termo: "anti-vacina" na lista casa com "anti-vacina" na pergunta.
  const clean = (s: string) => normalize(s.replace(/[^\p{L}\p{N}\p{M}]+/gu, ' '))
  const t = ` ${clean(text)} `
  return words.some((w) => clean(w) && t.includes(` ${clean(w)} `))
}
