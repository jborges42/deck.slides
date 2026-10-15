// Verificação do gerador de paleta: todos os pares exigidos passam no contraste WCAG. Roda em `pnpm test`.
import assert from 'node:assert/strict';
import { deriveTheme, contrastReport, contrast } from './screen-theme.ts';

let s = 7;
const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
const hex = () => '#' + Array.from({ length: 3 }, () => Math.floor(rnd() * 256).toString(16).padStart(2, '0')).join('').toUpperCase();
const hard = ['#FFD400', '#0033FF', '#E10600', '#00A86B', '#7B2CBF', '#2277D3', '#808080', '#111111', '#F5F5F5', '#FF00AA', '#00B5E2', '#FFFFFF', '#000000', '#FFFF00', '#0000FF'];

let n = 0, kept = 0, themes = 0, bgMoved = 0, plain = 0, plainKept = 0;
for (const background of ['#000000', '#FFFFFF']) for (const mode of ['dark', 'light'] as const) for (const level of ['standard', 'high'] as const) {
  const th = deriveTheme({ brand: '#2277D3', background, mode, contrast: level }); // forced polarity against the extremes
  for (const r of contrastReport(th, level)) assert.ok(r.ok, `${background} ${mode} ${level} ${r.pair} ${r.ratio.toFixed(2)}`);
}
for (const brand of [...hard, ...Array.from({ length: 300 }, hex)]) {
  for (const level of ['standard', 'high'] as const) {
    const inputs = [{ brand, mode: 'dark' as const }, { brand, mode: 'light' as const }, { brand, background: hex() }, { brand, background: brand }, { brand, background: hex(), mode: 'dark' as const }, { brand, background: hex(), mode: 'light' as const }];
    for (const input of inputs) {
      const th = deriveTheme({ ...input, contrast: level });
      for (const r of contrastReport(th, level)) { n++; assert.ok(r.ok, `${JSON.stringify(input)} ${level} ${r.pair} ${r.fg} on ${r.bg} = ${r.ratio.toFixed(2)} < ${r.min}`); }
      themes++; if (!th.adjusted.includes('accent')) kept++; if (th.adjusted.includes('background')) bgMoved++;
      if (!('background' in input) && level === 'standard') { plain++; if (!th.adjusted.includes('accent')) plainKept++; }
    }
  }
}
assert.equal(deriveTheme({ brand: '#FFD400', background: '#1a1446' }).tokens.canvas, '#1A1446'); // a passing custom background is kept exactly
assert.equal(contrast('#FFFFFF', '#000000').toFixed(2), '21.00');
assert.equal(contrast('#777777', '#FFFFFF').toFixed(2), '4.48'); // classic just-below-AA grey
console.log(`ok: ${n} pairs across ${themes} themes; brand fill kept exactly in ${((100 * kept) / themes).toFixed(1)}%; custom background moved in ${bgMoved} themes; default bg + standard: brand kept in ${((100 * plainKept) / plain).toFixed(1)}%`);

