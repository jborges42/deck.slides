// Reações: rótulo pt-BR + ícone Phosphor (nunca emoji). Um só mapa para celular, tela e ajustes.
import type { Icon } from '@phosphor-icons/react/dist/lib/types'
import { HandsClappingIcon } from '@phosphor-icons/react/HandsClapping'
import { HeartIcon } from '@phosphor-icons/react/Heart'
import { LightbulbIcon } from '@phosphor-icons/react/Lightbulb'
import { QuestionIcon } from '@phosphor-icons/react/Question'
import { SmileyIcon } from '@phosphor-icons/react/Smiley'
import { ThumbsUpIcon } from '@phosphor-icons/react/ThumbsUp'
import type { ReactionKind } from '../../shared/types.ts'

export const REACTION: Record<ReactionKind, { label: string; Icon: Icon }> = {
  applause: { label: 'Aplaudir', Icon: HandsClappingIcon },
  love: { label: 'Adorei', Icon: HeartIcon },
  like: { label: 'Curtir', Icon: ThumbsUpIcon },
  insight: { label: 'Boa ideia', Icon: LightbulbIcon },
  doubt: { label: 'Dúvida', Icon: QuestionIcon },
  laugh: { label: 'Engraçado', Icon: SmileyIcon },
}
