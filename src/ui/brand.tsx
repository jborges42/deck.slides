// Marca Conexão Profissional 2026 (SENAI Fraiburgo), desenhada a partir dos arquivos oficiais do manual.
// Cores fixas da marca, nunca tokens: o logo não muda com o tema. Proporção travada pelo viewBox (o manual
// proíbe distorcer, inclinar, espelhar ou girar o ícone).
import type { CSSProperties } from 'react'
import { cx } from './controls.tsx'

export const BRAND = { blue: '#004098', orange: '#E8490F', graphite: '#221F1F' }

// Arco aberto + ponto laranja no topo + ponto no fim do arco (geometria de icone-conexao-profissional.svg).
const ARC = 'M 87.85 168.94 A 70 70 0 1 1 165.78 123.94'

function Glyph({ negative }: { negative?: boolean }) {
  return (
    <>
      <path d={ARC} fill="none" stroke={negative ? '#FFFFFF' : BRAND.blue} strokeWidth="20" strokeLinecap="round" />
      <circle cx="135" cy="160.62" r="15" fill={negative ? '#FFFFFF' : BRAND.graphite} fillOpacity={negative ? 0.35 : 1} />
      <circle cx="100" cy="30" r="15" fill={BRAND.orange} />
    </>
  )
}

/** Ícone isolado: abaixo de 160 px de largura, o manual pede o ícone no lugar do logo completo. `negative` = sobre o azul. */
export function BrandIcon({ size = 24, negative, className }: { size?: number | string; negative?: boolean; className?: string }) {
  return (
    <svg viewBox="12 8 176 176" width={size} height={size} aria-hidden className={cx('shrink-0', className)}>
      <Glyph negative={negative} />
    </svg>
  )
}

/** Ícone + nome em uma linha, como no cabeçalho do manual. Para barras e cabeçalhos. */
export function BrandMark({ negative, className }: { negative?: boolean; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-2 font-brand text-read font-semibold whitespace-nowrap', className)}>
      <BrandIcon size={22} negative={negative} />
      Conexão Profissional
    </span>
  )
}

/** Logo completo (uso geral ou versão negativa). Mínimo de 160 px de largura. */
export function BrandLogo({ negative, width = 300, className }: { negative?: boolean; width?: number; className?: string }) {
  const support = negative ? 'rgba(255,255,255,0.85)' : '#5B5754'
  return (
    <svg
      viewBox="60 112 820 248"
      width={Math.max(width, 160)}
      role="img"
      aria-label="Conexão Profissional 2026. Finanças, Carreira e Mercado na Prática. SENAI Fraiburgo."
      className={cx('block h-auto shrink-0', className)}
    >
      <g transform="translate(50,110)">
        <Glyph negative={negative} />
      </g>
      <g fontFamily="Poppins, 'Century Gothic', Futura, Arial, sans-serif" fontWeight="800">
        <text x="300" y="185" fontSize="62" letterSpacing="1" fill={negative ? '#FFFFFF' : BRAND.blue}>
          CONEXÃO
        </text>
        <text x="300" y="250" fontSize="62" letterSpacing="1" fill={negative ? 'rgba(255,255,255,0.8)' : BRAND.graphite}>
          PROFISSIONAL
        </text>
        <rect x="300" y="278" width="86" height="36" rx="18" fill={BRAND.orange} />
        <text x="343" y="302" fontSize="22" fill="#FFFFFF" textAnchor="middle">
          2026
        </text>
        <text x="400" y="304" fontSize="26" fontWeight="400" fontFamily="'Helvetica Neue', Helvetica, Arial, sans-serif" fill={support}>
          Finanças, Carreira e Mercado na Prática
        </text>
        <text x="300" y="350" fontSize="17" fontWeight="700" letterSpacing="3" fill={BRAND.orange}>
          SENAI FRAIBURGO
        </text>
      </g>
    </svg>
  )
}

/**
 * Faixa da marca para rodapés: os elementos do logo numa linha, com texto de verdade. O logo completo encolhido
 * a altura de rodapé deixa a frase e o "SENAI FRAIBURGO" com 3 a 5 px. Os dois grupos quebram em duas linhas
 * quando falta largura (celular); `stacked` = sempre em duas linhas alinhadas à direita (telão).
 * Medidas em em: quem usa define o font-size. Sobre o azul, "SENAI FRAIBURGO" vai em branco: o laranja ali fica a 2,5:1.
 */
export function BrandStrip({ negative, stacked, className, style }: { negative?: boolean; stacked?: boolean; className?: string; style?: CSSProperties }) {
  return (
    <div
      role="img"
      aria-label="Conexão Profissional 2026. Finanças, Carreira e Mercado na Prática. SENAI Fraiburgo."
      className={cx(
        'flex gap-y-[0.4em] leading-none whitespace-nowrap',
        stacked ? 'flex-col items-end' : 'flex-wrap items-center justify-center gap-x-[1.1em]',
        className,
      )}
      style={style}
    >
      <span className="flex items-center gap-[0.6em]">
        <BrandIcon size="2.2em" negative={negative} />
        <span className="font-brand" style={{ fontSize: '1.25em', fontWeight: 800, letterSpacing: '0.02em' }}>
          <span style={{ color: negative ? '#FFFFFF' : BRAND.blue }}>CONEXÃO</span>{' '}
          <span style={{ color: negative ? 'rgba(255,255,255,0.8)' : BRAND.graphite }}>PROFISSIONAL</span>
        </span>
        <span className="rounded-full font-brand text-white" style={{ background: BRAND.orange, fontSize: '0.9em', fontWeight: 800, padding: '0.3em 0.65em' }}>
          2026
        </span>
      </span>
      <span className="flex items-center gap-[0.9em]">
        <span style={{ color: negative ? 'rgba(255,255,255,0.85)' : '#5B5754' }}>Finanças, Carreira e Mercado na Prática</span>
        <span className="font-brand" style={{ color: negative ? '#FFFFFF' : BRAND.orange, fontSize: '0.92em', fontWeight: 700, letterSpacing: '0.14em' }}>
          SENAI FRAIBURGO
        </span>
      </span>
    </div>
  )
}

/**
 * Rodapé fixo com a faixa da marca. Fica na base da janela nas páginas que rolam (`sticky` + `mt-auto` num pai
 * `flex-col`) e como última linha nos layouts de altura fixa. 12 px no celular (cabe em duas linhas), 14 px no resto.
 * `negative` sobre azul ou fundo escuro; `plain` = sem fundo nem borda (herda o azul de `on-brand`).
 */
export function BrandFooter({ negative, plain, className }: { negative?: boolean; plain?: boolean; className?: string }) {
  return (
    <footer
      className={cx(
        'sticky bottom-0 mt-auto shrink-0 px-4 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] text-[12px] sm:text-[14px]',
        !plain && 'border-t border-line bg-canvas',
        className,
      )}
    >
      <BrandStrip negative={negative} />
    </footer>
  )
}
