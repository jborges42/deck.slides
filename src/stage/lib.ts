// Regras puras do palco (sem DOM): unidades do canvas, códigos agrupados, cartões do tema e o mostrador
// do cronômetro. Testadas em lib.test.ts.
import type { CSSProperties } from 'react'
import { contrast } from '../../shared/screen-theme.ts'
import { clock } from '../lib/format.ts'
import type { Theme, TimerState } from '../../shared/types.ts'

/** Medida em pixels do canvas lógico (altura 1080) convertida para CSS: escala junto com o palco. */
export const u = (n: number) => `calc(var(--u) * ${Math.round(n * 100) / 100})`

/** Margem de segurança em unidades do canvas (o tema guarda em % da altura). */
export const safeOf = (theme: Pick<Theme, 'safe'>) => theme.safe * 10.8

/** PIN e códigos em duas metades: "482913" -> "482 913", "K7QX2M" -> "K7Q X2M". */
export const group = (code: string) =>
  code.length >= 6 && code.length % 2 === 0 ? `${code.slice(0, code.length / 2)} ${code.slice(code.length / 2)}` : code

/** Cartão no estilo do tema: sólido (surface), contorno (line-strong) ou sem moldura. */
export function card(theme: Pick<Theme, 'cardStyle' | 'radius'>, pad: [number, number]): { className: string; style: CSSProperties } {
  const plain = theme.cardStyle === 'plain'
  return {
    className: theme.cardStyle === 'solid' ? 'bg-surface' : theme.cardStyle === 'outline' ? 'border-line-strong' : '',
    style: {
      borderRadius: u(theme.radius),
      padding: plain ? 0 : `${u(pad[0])} ${u(pad[1])}`,
      ...(theme.cardStyle === 'outline' && { borderStyle: 'solid', borderWidth: `max(1px, ${u(3)})` }),
    },
  }
}

export type TimerSpec = Pick<TimerState, 'mode' | 'durationMs' | 'warnMs' | 'criticalMs' | 'onEnd' | 'endText'>

export interface TimerFace {
  text: string
  tone: 'normal' | 'warn' | 'critical'
  /** true = `text` é a mensagem final (fonte de título), não algarismos. */
  message: boolean
}

/** O que o cronômetro mostra depois de `elapsed` ms. */
export function timerFace(t: TimerSpec, elapsed: number): TimerFace {
  if (t.mode === 'stopwatch') return { text: clock(elapsed), tone: 'normal', message: false }
  const left = t.durationMs - elapsed
  if (left <= 0) {
    if (t.onEnd === 'message' && t.endText.trim()) return { text: t.endText.trim(), tone: 'normal', message: true }
    // Tempo extra em m:ss ("+0:12"), sem o zero à esquerda dos minutos.
    if (t.onEnd === 'overtime') return { text: `+${clock(-left).replace(/^0(?=\d:)/, '')}`, tone: 'critical', message: false }
    return { text: clock(0), tone: 'critical', message: false }
  }
  // Limite igual ou maior que a duração não vale: a contagem já começaria em aviso.
  const critical = t.criticalMs < t.durationMs && left <= t.criticalMs
  const warn = t.warnMs < t.durationMs && left <= t.warnMs
  return { text: clock(left, true), tone: critical ? 'critical' : warn ? 'warn' : 'normal', message: false }
}

const AMBER = [0xf5, 0xa5, 0x24] // #F5A524

/**
 * Âmbar do aviso do cronômetro com contraste garantido sobre o fundo do evento (WCAG `min`: 4,5:1; 7:1 em alto contraste).
 * Parte de #F5A524 e clareia (paleta escura) ou escurece (paleta clara) até atingir o mínimo. No fundo escuro padrão
 * fica o próprio #F5A524 (9,5:1); no claro vira um ocre escuro (#936316, 5:1; #6E4A10 em alto contraste), porque
 * âmbar puro sobre fundo claro não passa de 2:1. Fundos personalizados também passam: no limite vira preto ou branco.
 */
export function amberOn(canvas: string, dark: boolean, min = 4.5): string {
  for (let i = 0; i <= 20; i++) {
    const hex = `#${AMBER.map((c) => Math.round(c + ((dark ? 255 : 0) - c) * (i / 20)).toString(16).padStart(2, '0')).join('')}`
    if (contrast(hex, canvas) >= min) return hex
  }
  return dark ? '#ffffff' : '#000000'
}
