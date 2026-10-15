// Tipos de cena: rótulo e ícone, na ordem do menu "Nova cena".
import { BrowserIcon } from '@phosphor-icons/react/Browser'
import { ChatCircleTextIcon } from '@phosphor-icons/react/ChatCircleText'
import { FilmStripIcon } from '@phosphor-icons/react/FilmStrip'
import { ImageIcon } from '@phosphor-icons/react/Image'
import { TextTIcon } from '@phosphor-icons/react/TextT'
import { TimerIcon } from '@phosphor-icons/react/Timer'
import type { SceneType } from '../../../shared/types.ts'

export const KINDS: { type: SceneType; label: string; Icon: typeof TextTIcon }[] = [
  { type: 'title', label: 'Título', Icon: TextTIcon },
  { type: 'image', label: 'Imagem', Icon: ImageIcon },
  { type: 'video', label: 'Vídeo', Icon: FilmStripIcon },
  { type: 'embed', label: 'Página web', Icon: BrowserIcon },
  { type: 'questions', label: 'Perguntas', Icon: ChatCircleTextIcon },
  { type: 'timer', label: 'Cronômetro', Icon: TimerIcon },
]

export const KIND = Object.fromEntries(KINDS.map((k) => [k.type, k])) as Record<SceneType, (typeof KINDS)[number]>
