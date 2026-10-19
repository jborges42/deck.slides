// Reações: rótulo pt-BR + emoji colorido do Twemoji. Os SVGs vêm no próprio app: o mesmo desenho em todo
// celular e no telão, sem depender da fonte de emoji do aparelho nem de internet. Um só mapa para celular,
// tela e ajustes. Twemoji: Twitter, Inc. e colaboradores, gráficos sob CC-BY 4.0 (github.com/jdecked/twemoji).
import type { CSSProperties } from 'react'
import { cx } from '../ui'
import adorei from '../assets/emoji/adorei.svg'
import aplaudir from '../assets/emoji/aplaudir.svg'
import boaIdeia from '../assets/emoji/boa-ideia.svg'
import curtir from '../assets/emoji/curtir.svg'
import duvida from '../assets/emoji/duvida.svg'
import engracado from '../assets/emoji/engracado.svg'
import type { ReactionKind } from '../../shared/types.ts'

export const REACTION: Record<ReactionKind, { label: string; src: string }> = {
  applause: { label: 'Aplaudir', src: aplaudir }, // palmas
  love: { label: 'Adorei', src: adorei }, // coração vermelho
  like: { label: 'Curtir', src: curtir }, // joinha
  insight: { label: 'Boa ideia', src: boaIdeia }, // lâmpada
  doubt: { label: 'Dúvida', src: duvida }, // rosto pensativo
  laugh: { label: 'Engraçado', src: engracado }, // rindo até chorar
}

/** Emoji da reação, do tamanho do texto (1em), como um ícone. `alt` vazio quando o rótulo já está ao lado. */
export function ReactionEmoji({ kind, alt = '', className, style }: { kind: ReactionKind; alt?: string; className?: string; style?: CSSProperties }) {
  return <img src={REACTION[kind].src} alt={alt} draggable={false} className={cx('inline-block size-[1em] shrink-0 select-none', className)} style={style} />
}
