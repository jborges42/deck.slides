// Relógio do servidor no cliente. Fora de stream.ts para o teste rodar sem DOM.

/**
 * Offset do relógio: cada amostra (serverNow - Date.now()) é o offset real menos o atraso da mensagem, que nunca
 * é negativo, então vale a maior desde que a conexão abriu (null = recém-aberta). Copiar cada amostra fazia o
 * offset oscilar com o Wi-Fi, e telas lado a lado viravam o segundo do cronômetro em instantes diferentes.
 */
export const bestOffset = (best: number | null, sample: number) => (best === null ? sample : Math.max(best, sample))
