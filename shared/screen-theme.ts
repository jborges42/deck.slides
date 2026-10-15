// Event screen theme: one brand color in, contrast-safe tokens out (WCAG 2.x).
// Zero dependencies; erasable TS only, so it runs as-is in Node 24 (type stripping) and in the Vite client.

export type ThemeInput = {
  brand: string; // '#RRGGBB'
  background?: string; // exact canvas color; kept unless fg cannot reach its target on it
  mode?: 'dark' | 'light'; // 'dark' = light text on a dark canvas; with a background, omit for auto
  contrast?: 'standard' | 'high';
  tint?: number; // OKLCH chroma of neutrals: 0 = pure greys, default 0.006 = barely tinted
};
export const TOKEN_NAMES = ['canvas', 'surface', 'raised', 'line', 'lineStrong', 'fg', 'fgMuted', 'accent', 'onAccent', 'accentFg', 'accentSoft', 'critical'] as const;
export type TokenName = (typeof TOKEN_NAMES)[number];
export type Theme = { mode: 'dark' | 'light'; tokens: Record<TokenName, string>; adjusted: ('background' | 'accent')[] };

// Minimum WCAG 2.x ratios. "high" mirrors M3's contrast levels (ContrastCurve medium/high).
export const TARGETS = {
  standard: { text: 7, muted: 4.5, ui: 3, onAccent: 4.5 },
  high: { text: 11, muted: 7, ui: 4.5, onAccent: 7 },
};
const MARGIN = 1.03; // keeps 8-bit rounding from dropping a pair below its target

// ---- WCAG 2.x relative luminance and contrast ratio ----
type RGB = [number, number, number]; // linear sRGB, 0..1
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const rgbOf = (hex: string): RGB => [1, 3, 5].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255)) as RGB;
const hexOf = (rgb: RGB) => '#' + rgb.map((v) => Math.round(255 * toGamma(Math.min(1, Math.max(0, v)))).toString(16).padStart(2, '0')).join('').toUpperCase();
const lum = ([r, g, b]: RGB) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
export const luminance = (hex: string) => lum(rgbOf(hex));
export const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// ---- OKLCH <-> linear sRGB (Ottosson), chroma-only gamut mapping ----
const toOklch = ([r, g, b]: RGB) => {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, C: Math.hypot(A, B), h: Math.atan2(B, A) };
};
const fromOklab = (L: number, a: number, b: number): RGB => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
};
const inGamut = (rgb: RGB) => rgb.every((v) => v >= -1e-7 && v <= 1 + 1e-7);
// OKLCH color, reducing chroma (never lightness or hue) until it fits sRGB
const oklch = (L: number, C: number, h: number): RGB => {
  L = Math.min(1, Math.max(0, L));
  const at = (c: number) => fromOklab(L, c * Math.cos(h), c * Math.sin(h));
  if (inGamut(at(C))) return at(C);
  let lo = 0, hi = C;
  for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (inGamut(at(mid))) lo = mid; else hi = mid; }
  return at(lo);
};
// least-moved color of (C, h) whose luminance is >= y (up) or <= y (down)
const atLuminance = (y: number, C: number, h: number, up: boolean): RGB => {
  let lo = 0, hi = 1;
  for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (lum(oklch(mid, C, h)) < y) lo = mid; else hi = mid; }
  return oklch(up ? hi : lo, C, h);
};
// luminance that reaches `ratio` against luminance `y`, on the lighter (up) or darker side
const needed = (y: number, ratio: number, up: boolean) => (up ? ratio * (y + 0.05) - 0.05 : (y + 0.05) / ratio - 0.05);

export function deriveTheme(input: ThemeInput): Theme {
  const t = TARGETS[input.contrast ?? 'standard'];
  const brand = toOklch(rgbOf(input.brand));
  const adjusted: Theme['adjusted'] = [];
  const bgIn = input.background ? toOklch(rgbOf(input.background)) : null;
  const tint = Math.min(input.tint ?? 0.006, brand.C); // ~HCT chroma 1-5; M3 tonal-spot neutrals use 6
  const nh = bgIn?.h ?? brand.h, nC = bgIn?.C ?? tint;

  // elevation by tone (M3 surface containers): raised surfaces step toward the text color.
  // If text misses its target on the raised surface, move the background (never relax the target).
  const fit = (dark: boolean) => {
    const text = hexOf(oklch(dark ? 0.985 : 0.18, Math.min(tint, 0.006), nh));
    const steps = dark ? [0, 0.04, 0.085] : [0, -0.025, -0.05];
    const at = (L: number) => steps.map((d) => hexOf(oklch(L + d, nC, nh)));
    const start = Math.min(1, Math.max(0, bgIn?.L ?? (dark ? 0.16 : 0.985)));
    let bgL = start, surfaces = at(start);
    while (contrast(text, surfaces[2]) < t.text * MARGIN && bgL >= 0 && bgL <= 1) surfaces = at((bgL += dark ? -0.005 : 0.005)); // ends passing: at L 0/1 fg is >= 16:1
    if (!bgIn || bgL === start) return { dark, text, surfaces: [input.background?.toUpperCase() ?? surfaces[0], surfaces[1], surfaces[2]], moved: 0 };
    const out = toOklch(rgbOf(surfaces[0])); // moved = OKLab distance from the requested background
    return { dark, text, surfaces, moved: Math.hypot(out.L - bgIn.L, out.C * Math.cos(out.h) - bgIn.C * Math.cos(bgIn.h), out.C * Math.sin(out.h) - bgIn.C * Math.sin(bgIn.h)) };
  };
  // mode set: honor it. Custom background without mode: the polarity that changes it least (OKLab distance; tie -> light text).
  const f = bgIn && !input.mode ? [fit(true), fit(false)].reduce((a, b) => (b.moved < a.moved ? b : a)) : fit(input.mode !== 'light');
  const { dark, text, surfaces } = f;
  if (f.moved > 0) adjusted.push('background');
  const up = dark; // direction from surfaces toward text
  const dir = up ? 1 : -1;
  const worstY = luminance(surfaces[2]);
  const reach = (ratio: number, C: number, h: number, fromL: number) => { // fromL if it already passes, else the minimum move
    const y = needed(worstY, ratio * MARGIN, up), start = oklch(fromL, C, h);
    return hexOf(up ? (lum(start) >= y ? start : atLuminance(y, C, h, true)) : (lum(start) <= y ? start : atLuminance(y, C, h, false)));
  };

  // accent = brand fill behind onAccent text (cards, bars, badges). Exact brand whenever white or near-black text
  // reaches the target; else the smallest luminance move that lets one of them. Graphics and icons use accentFg.
  const onDark = hexOf(oklch(0.13, tint, brand.h));
  const exactOn = ['#FFFFFF', onDark].find((on) => contrast(on, input.brand) >= t.onAccent); // white preferred
  let accent = input.brand.toUpperCase(), onAccent = exactOn ?? '#FFFFFF';
  if (exactOn === undefined) {
    const yBrand = luminance(input.brand);
    const yWhite = needed(1, t.onAccent * MARGIN, false), yBlack = needed(luminance(onDark), t.onAccent * MARGIN, true);
    const white = yBrand - yWhite <= yBlack - yBrand; // both distances are > 0 here
    onAccent = white ? '#FFFFFF' : onDark;
    accent = hexOf(atLuminance(white ? yWhite : yBlack, brand.C, brand.h, !white));
    adjusted.push('accent');
  }

  let softL = toOklch(rgbOf(surfaces[1])).L + dir * 0.03;
  let accentSoft = hexOf(oklch(softL, Math.min(brand.C, 0.07), brand.h));
  while (contrast(text, accentSoft) < t.text * MARGIN && softL > 0 && softL < 1) accentSoft = hexOf(oklch((softL -= dir * 0.005), Math.min(brand.C, 0.07), brand.h));

  return {
    mode: dark ? 'dark' : 'light',
    adjusted,
    tokens: {
      canvas: surfaces[0],
      surface: surfaces[1],
      raised: surfaces[2],
      line: hexOf(oklch(toOklch(rgbOf(surfaces[2])).L + dir * 0.08, nC, nh)), // decorative dividers, no minimum
      lineStrong: reach(t.ui, nC, nh, dark ? 0 : 1), // meaningful outlines, tracks, focus
      fg: text,
      fgMuted: reach(t.muted, nC, nh, dark ? 0 : 1), // exactly at the floor: muted but always legible
      accent,
      onAccent,
      accentFg: reach(t.muted, brand.C, brand.h, brand.L), // brand as text, icons, timer ring, reaction glyphs
      accentSoft,
      critical: reach(t.muted, 0.2, 0.48, dark ? 0.68 : 0.55), // fixed red (OKLCH h ~27deg): timer overtime, alerts
    },
  };
}

// Pairs that must hold; also usable server-side to validate manual overrides.
export function contrastReport(th: Theme, level: 'standard' | 'high' = 'standard') {
  const t = TARGETS[level], k = th.tokens;
  const rows: [string, string, string, number][] = [];
  for (const s of ['canvas', 'surface', 'raised'] as const) {
    rows.push([`fg/${s}`, k.fg, k[s], t.text], [`fgMuted/${s}`, k.fgMuted, k[s], t.muted], [`accentFg/${s}`, k.accentFg, k[s], t.muted],
      [`critical/${s}`, k.critical, k[s], t.muted], [`lineStrong/${s}`, k.lineStrong, k[s], t.ui]);
  }
  rows.push(['onAccent/accent', k.onAccent, k.accent, t.onAccent], ['fg/accentSoft', k.fg, k.accentSoft, t.text]);
  return rows.map(([pair, fg, bg, min]) => ({ pair, fg, bg, min, ratio: contrast(fg, bg), ok: contrast(fg, bg) >= min }));
}
