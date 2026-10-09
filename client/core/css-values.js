// CSS value normalisers for style tokens: every color syntax to a hex value
// and an alpha, lengths to a number and a unit, and the composite values
// (shadow, border, gradient, font family, easing, duration) to small plain
// objects. Browser and Node: standard JavaScript only.
//
// Every parser takes one value as written in a style sheet, a token file or
// a computed style, and returns a fresh normalised object or null. None of
// them throws, and none uses a pattern that can take more than linear time:
// values are split by hand-written scanners, and the few regular expressions
// are anchored with no nested repetition.

export const MAX_VALUE = 2000;

const round = (n, d = 4) => {
  const f = 10 ** d;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// The largest length kept, in px (and as written): bigger values are not
// style values anyone means, and the token file refuses them.
const MAX_PX = 1e7;
const MAX_NUMBER = 1e6;

// A value without a trailing "!important". Done by hand: a pattern such as
// /\s*!important$/ takes quadratic time on a long run of white space.
export function stripImportant(str) {
  let v = String(str).trimEnd();
  if (v.length >= 10 && v.slice(-10).toLowerCase() === "!important") v = v.slice(0, -10).trimEnd();
  return v;
}

// ---------------------------------------------------------------- splitting

// Split at top-level separators: "," (sep ",") or runs of white space
// (sep " "). Parentheses and quoted strings are kept whole. A "/" in white
// space mode is its own item, so "1 2 3 / 50%" gives ["1","2","3","/","50%"].
export function splitTop(str, sep) {
  const s = String(str);
  const out = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  const push = (end) => {
    const part = s.slice(start, end).trim();
    if (part) out.push(part);
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "\"" || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (sep === "," && ch === ",") {
        push(i);
        start = i + 1;
      } else if (sep === " " && (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f")) {
        push(i);
        start = i + 1;
      } else if (sep === " " && ch === "/") {
        push(i);
        out.push("/");
        start = i + 1;
      }
    }
  }
  push(s.length);
  return out;
}

// "name(args)" as a whole value -> {name (lower case), args}; else null.
export function fnCall(str) {
  const s = String(str).trim();
  const open = s.indexOf("(");
  if (open <= 0 || !s.endsWith(")")) return null;
  const name = s.slice(0, open).toLowerCase();
  if (!/^-?[a-z][a-z0-9-]{0,40}$/.test(name)) return null;
  // The parenthesis that closes the first one must be the last character.
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0 && i !== s.length - 1) return null;
    }
  }
  return depth === 0 ? { name, args: s.slice(open + 1, -1) } : null;
}

// ---------------------------------------------------------------- numbers

const NUM_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const DIM_RE = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)([a-z%]{0,6})$/i;

export function parseNumber(str) {
  const s = String(str).trim();
  if (s.length > 40 || !NUM_RE.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export const LENGTH_UNITS = Object.freeze([
  "px", "rem", "em", "%", "vw", "vh", "vmin", "vmax", "dvh", "dvw", "svh", "svw", "lvh", "lvw",
  "ch", "ex", "cap", "ic", "lh", "rlh", "pt", "pc", "in", "cm", "mm", "q", "cqw", "cqh", "cqi", "cqb", "fr",
]);
const UNIT_SET = new Set(LENGTH_UNITS);
const PX_PER = { px: 1, rem: 16, em: 16, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 };

// A length, percentage or plain number: {value, unit, px?}. unit is "" for a
// plain number. px is given where it can be worked out (rem and em counted
// at 16 px). With unitless:false a plain number other than 0 is refused.
export function parseDimension(str, { unitless = true } = {}) {
  const s = String(str).trim();
  if (s.length > 40) return null;
  const m = DIM_RE.exec(s);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || Math.abs(value) > MAX_NUMBER) return null;
  const unit = m[2].toLowerCase();
  if (unit === "") {
    if (!unitless && value !== 0) return null;
    return value === 0 && !unitless ? { value: 0, unit: "px", px: 0 } : { value: round(value), unit: "" };
  }
  if (!UNIT_SET.has(unit)) return null;
  const out = { value: round(value), unit };
  if (PX_PER[unit] !== undefined) {
    out.px = round(value * PX_PER[unit], 2);
    if (Math.abs(out.px) > MAX_PX) return null;
  }
  return out;
}

// ---------------------------------------------------------------- calc()

const CALC_LIMITS = Object.freeze({ length: 400, tokens: 200, depth: 16 });
const CALC_NUM_RE = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?[a-z%]{0,6}/y;

// The tokens of a calc() expression: numbers (with their unit, in px when it
// is a length), operators and parentheses. null for anything else.
function calcTokens(s) {
  const out = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f") {
      i++;
      continue;
    }
    if (out.length >= CALC_LIMITS.tokens) return null;
    const prev = out[out.length - 1];
    const afterValue = !!prev && (prev.num !== undefined || prev.op === ")");
    if (c === "(" || c === ")" || c === "*" || c === "/" || ((c === "+" || c === "-") && afterValue)) {
      out.push({ op: c });
      i++;
      continue;
    }
    if (s.startsWith("calc(", i)) {
      out.push({ op: "(" });
      i += 5;
      continue;
    }
    CALC_NUM_RE.lastIndex = i;
    const m = CALC_NUM_RE.exec(s);
    if (!m) return null;
    const d = parseDimension(m[0]);
    if (!d) return null;
    if (d.unit === "") out.push({ num: d.value, len: false });
    else if (d.px !== undefined) out.push({ num: d.px, len: true });
    else return null;
    i += m[0].length;
  }
  return out;
}

// A calc() of lengths and plain numbers: + and - between two lengths or two
// numbers, * and / by a plain number. Lengths are counted in px (a rem or an
// em as 16 px). Returns {px} for a length, {value} for a plain number, or
// null (a percentage, a viewport unit, a variable, anything else).
export function evalCalc(str) {
  const s = String(str).trim().toLowerCase();
  if (s.length > CALC_LIMITS.length || !s.startsWith("calc(")) return null;
  const toks = calcTokens(s);
  if (!toks) return null;
  let i = 0;
  const peek = () => toks[i];
  function factor(depth) {
    if (depth > CALC_LIMITS.depth) return null;
    const t = toks[i++];
    if (!t) return null;
    if (t.num !== undefined) return { n: t.num, len: t.len };
    if (t.op === "(") {
      const v = sum(depth + 1);
      const close = toks[i++];
      return v && close && close.op === ")" ? v : null;
    }
    return null;
  }
  function product(depth) {
    let a = factor(depth);
    while (a && peek() && (peek().op === "*" || peek().op === "/")) {
      const op = toks[i++].op;
      const b = factor(depth);
      if (!b) return null;
      if (op === "*") {
        if (a.len && b.len) return null;
        a = { n: a.n * b.n, len: a.len || b.len };
      } else {
        if (b.len || b.n === 0) return null;
        a = { n: a.n / b.n, len: a.len };
      }
    }
    return a;
  }
  function sum(depth) {
    let a = product(depth);
    while (a && peek() && (peek().op === "+" || peek().op === "-")) {
      const op = toks[i++].op;
      const b = product(depth);
      if (!b || b.len !== a.len) return null;
      a = { n: op === "+" ? a.n + b.n : a.n - b.n, len: a.len };
    }
    return a;
  }
  const v = factor(0);
  if (!v || i !== toks.length || !Number.isFinite(v.n)) return null;
  if (v.len) return Math.abs(v.n) > MAX_PX ? null : { px: round(v.n, 2) };
  return Math.abs(v.n) > MAX_NUMBER ? null : { value: round(v.n) };
}

// A length written as a dimension or as a calc() of lengths, in the shape
// parseDimension gives (a calc() length is in px).
export function parseLength(str, { unitless = true } = {}) {
  const d = parseDimension(str, { unitless });
  if (d) return d;
  const c = evalCalc(str);
  if (!c) return null;
  if (c.px !== undefined) return { value: c.px, unit: "px", px: c.px };
  if (!unitless && c.value !== 0) return null;
  return unitless ? { value: c.value, unit: "" } : { value: 0, unit: "px", px: 0 };
}

function parseAngle(str) {
  const s = String(str).trim().toLowerCase();
  if (s === "none") return 0;
  const m = DIM_RE.exec(s);
  if (!m) return null;
  const v = Number(m[1]);
  switch (m[2].toLowerCase()) {
    case "":
    case "deg": return v;
    case "rad": return (v * 180) / Math.PI;
    case "grad": return v * 0.9;
    case "turn": return v * 360;
    default: return null;
  }
}

// A color component: a number, a percentage scaled so 100% = pct, or "none".
function comp(str, pct) {
  const s = String(str).trim().toLowerCase();
  if (s === "none") return 0;
  if (s.endsWith("%")) {
    const n = parseNumber(s.slice(0, -1));
    return n === null ? null : (n / 100) * pct;
  }
  return parseNumber(s);
}

function alphaOf(str) {
  if (str === undefined) return 1;
  const a = comp(str, 1);
  return a === null ? null : clamp(a, 0, 1);
}

// ---------------------------------------------------------------- color spaces

const mul = (m, v) => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];

const XYZ65_TO_LSRGB = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
];
const D50_TO_D65 = [
  [0.955473421488075, -0.02309845494876471, 0.06325924320057072],
  [-0.0283697093338637, 1.0099953980813041, 0.021041441191917323],
  [0.012314014864481998, -0.020507649298898964, 1.330365926242124],
];
const LP3_TO_XYZ65 = [
  [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
  [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
  [0, 0.04511338185890264, 1.043944368900976],
];
const LA98_TO_XYZ65 = [
  [0.5766690429101305, 0.1855582379065463, 0.1882286462349947],
  [0.29734497525053605, 0.6273635662554661, 0.07529145849399788],
  [0.02703136138641234, 0.07068885253582723, 0.9913375368376388],
];
const LPROPHOTO_TO_XYZ50 = [
  [0.7977604896723027, 0.13518583717574031, 0.0313493495815248],
  [0.2880711282292934, 0.7118432178101014, 0.00008565396060525902],
  [0, 0, 0.8251046025104601],
];
const L2020_TO_XYZ65 = [
  [0.6369580483012914, 0.14461690358620832, 0.1688809751641721],
  [0.2627002120112671, 0.6779980715188708, 0.05930171646986196],
  [0, 0.028072693049087428, 1.060985057710791],
];
const D50_WHITE = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];

const signPow = (c, p) => Math.sign(c) * Math.abs(c) ** p;
const srgbToLinear = (c) => (Math.abs(c) <= 0.04045 ? c / 12.92 : Math.sign(c) * ((Math.abs(c) + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => (Math.abs(c) <= 0.0031308 ? c * 12.92 : Math.sign(c) * (1.055 * Math.abs(c) ** (1 / 2.4) - 0.055));

function labToXyz50(L, a, b) {
  const k = 24389 / 27;
  const e = 216 / 24389;
  const f1 = (L + 16) / 116;
  const f0 = a / 500 + f1;
  const f2 = f1 - b / 200;
  const x = f0 ** 3 > e ? f0 ** 3 : (116 * f0 - 16) / k;
  const y = L > k * e ? ((L + 16) / 116) ** 3 : L / k;
  const z = f2 ** 3 > e ? f2 ** 3 : (116 * f2 - 16) / k;
  return [x * D50_WHITE[0], y * D50_WHITE[1], z * D50_WHITE[2]];
}

function oklabToLinear(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const f = (n) => {
    const k = (n + hue / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

const hex2 = (c) => Math.round(clamp(c, 0, 1) * 255).toString(16).padStart(2, "0");

// Gamma-encoded sRGB channels (0-1, possibly out of range) -> {hex, alpha, clipped?}.
function fromSrgb(rgb, alpha) {
  if (!rgb.every(Number.isFinite) || !Number.isFinite(alpha)) return null;
  const out = { hex: `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}`, alpha: round(clamp(alpha, 0, 1), 3) };
  if (rgb.some((c) => c < -0.002 || c > 1.002)) out.clipped = true;
  return out;
}
const fromLinear = (lin, alpha) => fromSrgb(lin.map(linearToSrgb), alpha);
const fromXyz65 = (xyz, alpha) => fromLinear(mul(XYZ65_TO_LSRGB, xyz), alpha);

// HWB -> gamma-encoded sRGB; w and b in percent.
function hwbToSrgb(h, w0, b0) {
  const w = clamp(w0, 0, 100) / 100;
  const b = clamp(b0, 0, 100) / 100;
  if (w + b >= 1) {
    const g = w / (w + b);
    return [g, g, g];
  }
  return hslToRgb(h, 1, 0.5).map((c) => c * (1 - w - b) + w);
}

// ---------------------------------------------------------------- color-mix() and relative colors

const LSRGB_TO_XYZ65 = [
  [0.41239079926595934, 0.357584339383878, 0.1804807884018343],
  [0.21263900587151027, 0.715168678767756, 0.07219231536073371],
  [0.01933081871559182, 0.11919477979462598, 0.9505321522496607],
];
const D65_TO_D50 = [
  [1.0479298208405488, 0.022946793341019088, -0.05019222954313557],
  [0.029627815688159344, 0.990434484573249, -0.01707382502938514],
  [-0.009243058152591178, 0.015055144896577895, 0.7518742899580008],
];

function linearToOklab(rgb) {
  const l = Math.cbrt(0.4122214708 * rgb[0] + 0.5363325363 * rgb[1] + 0.0514459929 * rgb[2]);
  const m = Math.cbrt(0.2119034982 * rgb[0] + 0.6806995451 * rgb[1] + 0.1073969566 * rgb[2]);
  const s = Math.cbrt(0.0883024619 * rgb[0] + 0.2817188376 * rgb[1] + 0.6299787005 * rgb[2]);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function xyz50ToLab(xyz) {
  const e = 216 / 24389;
  const k = 24389 / 27;
  const f = (t) => (t > e ? Math.cbrt(t) : (k * t + 16) / 116);
  const fx = f(xyz[0] / D50_WHITE[0]);
  const fy = f(xyz[1] / D50_WHITE[1]);
  const fz = f(xyz[2] / D50_WHITE[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// Hue in degrees; NaN when the color has none (a grey).
function rgbToHsl(rgb) {
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-9) return [NaN, 0, l * 100];
  const s = l <= 0 || l >= 1 ? 0 : (max - l) / Math.min(l, 1 - l);
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return [h < 0 ? h + 360 : h, s * 100, l * 100];
}

const toPolar = (v, eps) => {
  const C = Math.hypot(v[1], v[2]);
  if (C < eps) return [v[0], C, NaN];
  const H = (Math.atan2(v[2], v[1]) * 180) / Math.PI;
  return [v[0], C, H < 0 ? H + 360 : H];
};
const toCartesian = (v) => {
  const H = Number.isNaN(v[2]) ? 0 : v[2];
  const C = Math.max(0, v[1]);
  return [v[0], C * Math.cos((H * Math.PI) / 180), C * Math.sin((H * Math.PI) / 180)];
};
const rgbOf = (c) => [1, 3, 5].map((i) => parseInt(c.hex.slice(i, i + 2), 16) / 255);

// The components of a parsed color in `space`, as CSS writes them there
// (rgb 0-255, hsl and hwb percentages as 0-100, lab L 0-100, oklab L 0-1).
// A hue the color does not have is NaN.
function toSpace(space, c) {
  const rgb = rgbOf(c);
  const lin = () => rgb.map(srgbToLinear);
  switch (space) {
    case "rgb": return rgb.map((v) => v * 255);
    case "srgb": return rgb;
    case "srgb-linear": return lin();
    case "xyz":
    case "xyz-d65": return mul(LSRGB_TO_XYZ65, lin());
    case "xyz-d50": return mul(D65_TO_D50, mul(LSRGB_TO_XYZ65, lin()));
    case "lab": return xyz50ToLab(toSpace("xyz-d50", c));
    case "lch": return toPolar(toSpace("lab", c), 0.02);
    case "oklab": return linearToOklab(lin());
    case "oklch": return toPolar(toSpace("oklab", c), 0.0002);
    case "hsl": return rgbToHsl(rgb);
    case "hwb": {
      const h = rgbToHsl(rgb)[0];
      return [h, Math.min(...rgb) * 100, (1 - Math.max(...rgb)) * 100];
    }
    default: return null;
  }
}

function fromSpace(space, v, alpha) {
  const hue = (h) => (Number.isNaN(h) ? 0 : h);
  switch (space) {
    case "rgb": return fromSrgb(v.map((x) => clamp(x, 0, 255) / 255), alpha);
    case "srgb": return fromSrgb(v, alpha);
    case "srgb-linear": return fromLinear(v, alpha);
    case "xyz":
    case "xyz-d65": return fromXyz65(v, alpha);
    case "xyz-d50": return fromXyz65(mul(D50_TO_D65, v), alpha);
    case "lab": return fromXyz65(mul(D50_TO_D65, labToXyz50(clamp(v[0], 0, 100), v[1], v[2])), alpha);
    case "lch": return fromSpace("lab", toCartesian(v), alpha);
    case "oklab": return fromLinear(oklabToLinear(clamp(v[0], 0, 1), v[1], v[2]), alpha);
    case "oklch": return fromSpace("oklab", toCartesian(v), alpha);
    case "hsl": return fromSrgb(hslToRgb(hue(v[0]), clamp(v[1], 0, 100) / 100, clamp(v[2], 0, 100) / 100), alpha);
    case "hwb": return fromSrgb(hwbToSrgb(hue(v[0]), v[1], v[2]), alpha);
    default: return null;
  }
}

const HUE_AT = { hsl: 0, hwb: 0, lch: 2, oklch: 2 };
const MIX_SPACES = new Set(["srgb", "srgb-linear", "xyz", "xyz-d65", "xyz-d50", "lab", "lch", "oklab", "oklch", "hsl", "hwb"]);
const HUE_METHODS = new Set(["shorter", "longer", "increasing", "decreasing"]);

// "<color> <percentage>?" in either order.
function mixPart(part) {
  const words = splitTop(part, " ");
  if (words.length === 0 || words.length > 2) return null;
  let color = null;
  let pct = null;
  for (const w of words) {
    if (w.endsWith("%") && pct === null) {
      const n = parseNumber(w.slice(0, -1));
      if (n === null || n < 0 || n > 100) return null;
      pct = n;
    } else if (!color) {
      color = parseColor(w);
      if (!color) return null;
    } else return null;
  }
  return color ? { color, pct } : null;
}

// color-mix(in <space> [<hue method> hue], <color> [p], <color> [p]),
// interpolated with premultiplied alpha as CSS Color 5 describes.
function parseColorMix(args) {
  const parts = splitTop(args, ",");
  if (parts.length !== 3) return null;
  const head = splitTop(parts[0], " ").map((w) => w.toLowerCase());
  if (head[0] !== "in" || !MIX_SPACES.has(head[1])) return null;
  const space = head[1];
  const hi = HUE_AT[space];
  let method = "shorter";
  if (head.length === 4 && hi !== undefined && HUE_METHODS.has(head[2]) && head[3] === "hue") method = head[2];
  else if (head.length !== 2) return null;
  const a = mixPart(parts[1]);
  const b = mixPart(parts[2]);
  if (!a || !b) return null;
  let p1 = a.pct;
  let p2 = b.pct;
  if (p1 === null && p2 === null) [p1, p2] = [50, 50];
  else if (p1 === null) p1 = 100 - p2;
  else if (p2 === null) p2 = 100 - p1;
  const sum = p1 + p2;
  if (!(sum > 0)) return null;
  const t = p2 / sum;
  const ca = toSpace(space, a.color);
  const cb = toSpace(space, b.color);
  if (hi !== undefined) {
    // A missing hue takes the other color's.
    if (Number.isNaN(ca[hi])) ca[hi] = cb[hi];
    if (Number.isNaN(cb[hi])) cb[hi] = ca[hi];
    if (Number.isNaN(ca[hi])) ca[hi] = cb[hi] = 0;
    const d = cb[hi] - ca[hi];
    if (method === "shorter") {
      if (d > 180) ca[hi] += 360;
      else if (d < -180) cb[hi] += 360;
    } else if (method === "longer") {
      if (d > 0 && d < 180) ca[hi] += 360;
      else if (d > -180 && d <= 0) cb[hi] += 360;
    } else if (method === "increasing") {
      if (d < 0) cb[hi] += 360;
    } else if (d > 0) ca[hi] += 360;
  }
  const aa = a.color.alpha;
  const ab = b.color.alpha;
  const alpha = aa * (1 - t) + ab * t;
  const out = ca.map((v, i) => {
    if (i === hi) return (v * (1 - t) + cb[i] * t) % 360;
    return alpha === 0 ? 0 : (v * aa * (1 - t) + cb[i] * ab * t) / alpha;
  });
  return fromSpace(space, out, alpha * (sum < 100 ? sum / 100 : 1));
}

// Relative colors, "rgb(from <color> r g b / alpha)": each channel is the
// origin's channel by name, a number or a percentage, or "none". Channel
// arithmetic (calc()) is not worked out.
const RELATIVE = {
  rgb: [["r", "g", "b"], "rgb", [255, 255, 255]],
  rgba: [["r", "g", "b"], "rgb", [255, 255, 255]],
  hsl: [["h", "s", "l"], "hsl", [null, 100, 100]],
  hsla: [["h", "s", "l"], "hsl", [null, 100, 100]],
  hwb: [["h", "w", "b"], "hwb", [null, 100, 100]],
  lab: [["l", "a", "b"], "lab", [100, 125, 125]],
  lch: [["l", "c", "h"], "lch", [100, 150, null]],
  oklab: [["l", "a", "b"], "oklab", [1, 0.4, 0.4]],
  oklch: [["l", "c", "h"], "oklch", [1, 0.4, null]],
};
const isRelative = (args) => /^\s*from\s/i.test(String(args).slice(0, 12));

function parseRelative(name, args) {
  if (!Object.prototype.hasOwnProperty.call(RELATIVE, name)) return null;
  const [names, space, refs] = RELATIVE[name];
  const words = splitTop(args, " ");
  if (words.length !== 5 && words.length !== 7) return null;
  if (words[0].toLowerCase() !== "from") return null;
  const origin = parseColor(words[1]);
  if (!origin) return null;
  if (words.length === 7 && words[5] !== "/") return null;
  const base = toSpace(space, origin);
  const channel = (w, i) => {
    const lw = w.toLowerCase();
    const k = names.indexOf(lw);
    if (k !== -1) return Number.isNaN(base[k]) ? 0 : base[k];
    if (lw === "none") return 0;
    if (refs[i] === null) return parseAngle(lw);
    if (lw.endsWith("%")) {
      const n = parseNumber(lw.slice(0, -1));
      return n === null ? null : (n / 100) * refs[i];
    }
    return parseNumber(lw);
  };
  const v = words.slice(2, 5).map(channel);
  if (v.some((x) => x === null || !Number.isFinite(x))) return null;
  let alpha = origin.alpha;
  if (words.length === 7 && words[6].toLowerCase() !== "alpha") {
    alpha = alphaOf(words[6]);
    if (alpha === null) return null;
  }
  return fromSpace(space, v, alpha);
}

// ---------------------------------------------------------------- named colors

const NAMED_TEXT =
  "aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,bisque:ffe4c4," +
  "black:000000,blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0," +
  "chartreuse:7fff00,chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff," +
  "darkblue:00008b,darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9," +
  "darkkhaki:bdb76b,darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000," +
  "darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f," +
  "darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,dimgray:696969,dimgrey:696969," +
  "dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc," +
  "ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,grey:808080," +
  "honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa," +
  "lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff," +
  "lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1," +
  "lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899," +
  "lightsteelblue:b0c4de,lightyellow:ffffe0,lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff,maroon:800000," +
  "mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371," +
  "mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585," +
  "midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead,navy:000080," +
  "oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa," +
  "palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f," +
  "pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f," +
  "royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee," +
  "sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa," +
  "springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,tomato:ff6347,turquoise:40e0d0," +
  "violet:ee82ee,wheat:f5deb3,white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32";

const NAMED = new Map(NAMED_TEXT.split(",").map((pair) => {
  const [name, hex] = pair.split(":");
  return [name, `#${hex}`];
}));

export const NAMED_COLOR_COUNT = NAMED.size;

// ---------------------------------------------------------------- color

const HEX_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function parseHex(s) {
  const m = HEX_RE.exec(s);
  if (!m) return null;
  let h = m[1].toLowerCase();
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const alpha = h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1;
  return { hex: `#${h.slice(0, 6)}`, alpha: round(alpha, 3) };
}

// The components of a color function: [c1, c2, c3, alpha?] as strings, from
// either the comma form or the space form with "/ alpha".
function colorArgs(args) {
  const commas = splitTop(args, ",");
  if (commas.length >= 3) {
    if (commas.length > 4) return null;
    if (commas.some((c) => splitTop(c, " ").length !== 1)) return null;
    return commas;
  }
  if (commas.length !== 1) return null;
  const parts = splitTop(args, " ");
  const slash = parts.indexOf("/");
  if (slash === -1) return parts.length === 3 ? parts : null;
  if (slash !== 3 || parts.length !== 5) return null;
  return [parts[0], parts[1], parts[2], parts[4]];
}

const SPACES = {
  srgb: (c) => c,
  "srgb-linear": (c) => c.map(linearToSrgb),
  "display-p3": (c) => mul(XYZ65_TO_LSRGB, mul(LP3_TO_XYZ65, c.map(srgbToLinear))).map(linearToSrgb),
  "a98-rgb": (c) => mul(XYZ65_TO_LSRGB, mul(LA98_TO_XYZ65, c.map((v) => signPow(v, 563 / 256)))).map(linearToSrgb),
  "prophoto-rgb": (c) => {
    const lin = c.map((v) => (Math.abs(v) <= 16 / 512 ? v / 16 : signPow(v, 1.8)));
    return mul(XYZ65_TO_LSRGB, mul(D50_TO_D65, mul(LPROPHOTO_TO_XYZ50, lin))).map(linearToSrgb);
  },
  rec2020: (c) => {
    const a = 1.09929682680944;
    const b = 0.018053968510807;
    const lin = c.map((v) => (Math.abs(v) < b * 4.5 ? v / 4.5 : signPow((Math.abs(v) + a - 1) / a, 1 / 0.45) * Math.sign(v)));
    return mul(XYZ65_TO_LSRGB, mul(L2020_TO_XYZ65, lin)).map(linearToSrgb);
  },
  xyz: (c) => mul(XYZ65_TO_LSRGB, c).map(linearToSrgb),
  "xyz-d65": (c) => mul(XYZ65_TO_LSRGB, c).map(linearToSrgb),
  "xyz-d50": (c) => mul(XYZ65_TO_LSRGB, mul(D50_TO_D65, c)).map(linearToSrgb),
};

function parseColorFn(name, args) {
  if (name === "color") {
    const parts = splitTop(args, " ");
    if (parts.length < 4) return null;
    const space = parts[0].toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(SPACES, space)) return null;
    const rest = colorArgs(parts.slice(1).join(" "));
    if (!rest || rest.length < 3) return null;
    const c = rest.slice(0, 3).map((v) => comp(v, 1));
    const a = alphaOf(rest[3]);
    if (c.some((v) => v === null) || a === null) return null;
    return fromSrgb(SPACES[space](c), a);
  }
  const p = colorArgs(args);
  if (!p) return null;
  const alpha = alphaOf(p[3]);
  if (alpha === null) return null;
  switch (name) {
    case "rgb":
    case "rgba": {
      const c = p.slice(0, 3).map((v) => comp(v, 255));
      if (c.some((v) => v === null)) return null;
      return fromSrgb(c.map((v) => clamp(v, 0, 255) / 255), alpha);
    }
    case "hsl":
    case "hsla": {
      const h = parseAngle(p[0]);
      const s = comp(p[1], 100);
      const l = comp(p[2], 100);
      if (h === null || s === null || l === null) return null;
      return fromSrgb(hslToRgb(h, clamp(s, 0, 100) / 100, clamp(l, 0, 100) / 100), alpha);
    }
    case "hwb": {
      const h = parseAngle(p[0]);
      const w = comp(p[1], 100);
      const b = comp(p[2], 100);
      if (h === null || w === null || b === null) return null;
      return fromSrgb(hwbToSrgb(h, w, b), alpha);
    }
    case "lab":
    case "lch": {
      const L = comp(p[0], 100);
      if (L === null) return null;
      let a;
      let b;
      if (name === "lab") {
        a = comp(p[1], 125);
        b = comp(p[2], 125);
      } else {
        const C = comp(p[1], 150);
        const H = parseAngle(p[2]);
        if (C === null || H === null) return null;
        a = Math.max(0, C) * Math.cos((H * Math.PI) / 180);
        b = Math.max(0, C) * Math.sin((H * Math.PI) / 180);
      }
      if (a === null || b === null) return null;
      return fromXyz65(mul(D50_TO_D65, labToXyz50(clamp(L, 0, 100), a, b)), alpha);
    }
    case "oklab":
    case "oklch": {
      const L = comp(p[0], 1);
      if (L === null) return null;
      let a;
      let b;
      if (name === "oklab") {
        a = comp(p[1], 0.4);
        b = comp(p[2], 0.4);
      } else {
        const C = comp(p[1], 0.4);
        const H = parseAngle(p[2]);
        if (C === null || H === null) return null;
        a = Math.max(0, C) * Math.cos((H * Math.PI) / 180);
        b = Math.max(0, C) * Math.sin((H * Math.PI) / 180);
      }
      if (a === null || b === null) return null;
      return fromLinear(oklabToLinear(clamp(L, 0, 1), a, b), alpha);
    }
    default:
      return null;
  }
}

// Any CSS color -> {hex: "#rrggbb", alpha: 0-1, clipped?: true}, or null.
// clipped marks a color outside sRGB that was brought into range. Keywords
// that depend on context (currentColor, inherit, system colors) give null.
export function parseColor(str) {
  if (typeof str !== "string") return null;
  const s = str.trim();
  if (!s || s.length > 400) return null;
  if (s[0] === "#") return parseHex(s);
  const lower = s.toLowerCase();
  if (lower === "transparent") return { hex: "#000000", alpha: 0 };
  const named = NAMED.get(lower);
  if (named) return { hex: named, alpha: 1 };
  const fn = fnCall(s);
  if (!fn) return null;
  if (fn.name === "color-mix") return parseColorMix(fn.args);
  if (isRelative(fn.args)) return parseRelative(fn.name, fn.args);
  return parseColorFn(fn.name, fn.args);
}

// A color that DFTP may not be able to work out: color-mix() or a relative
// color (rgb(from ...)). Used to keep such a token, with a null value and a
// diagnostic, rather than lose it.
export function isComputedColor(str) {
  const fn = fnCall(String(str));
  if (!fn) return false;
  return fn.name === "color-mix" || ((fn.name === "color" || Object.prototype.hasOwnProperty.call(RELATIVE, fn.name)) && isRelative(fn.args));
}

// light-dark(a, b) -> {light, dark} (each a parsed color); else null.
export function parseLightDark(str) {
  const fn = fnCall(String(str));
  if (!fn || fn.name !== "light-dark") return null;
  const parts = splitTop(fn.args, ",");
  if (parts.length !== 2) return null;
  const light = parseColor(parts[0]);
  const dark = parseColor(parts[1]);
  return light && dark ? { light, dark } : null;
}

// Bare hue / saturation / lightness channels, as some projects keep them in
// custom properties to use as hsl(var(--x)): "222 47% 11%" or "222 47% 11% / 0.5".
const HSL_CHANNELS_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:deg)?\s+[+-]?(?:\d+(?:\.\d*)?|\.\d+)%\s+[+-]?(?:\d+(?:\.\d*)?|\.\d+)%(?:\s*\/\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)%?)?$/i;

export function parseHslChannels(str) {
  const s = String(str).trim();
  if (s.length > 80 || !HSL_CHANNELS_RE.test(s)) return null;
  return parseColor(`hsl(${s})`);
}

// ---------------------------------------------------------------- composites

const STOP_RE = /^(?:repeating-)?(linear|radial|conic)-gradient$/;

// The words a gradient's first argument may hold: CSS keywords for a
// direction, a shape and size, a position and a color space to interpolate
// in, and numbers with a unit. Nothing else is kept, so a stored gradient
// never carries other words to where it is shown or written out later.
export const GRADIENT_HEAD_WORDS = Object.freeze([
  "to", "top", "bottom", "left", "right", "center", "at", "from", "in",
  "circle", "ellipse", "closest-side", "closest-corner", "farthest-side", "farthest-corner",
  "srgb", "srgb-linear", "display-p3", "a98-rgb", "prophoto-rgb", "rec2020", "lab", "oklab", "xyz", "xyz-d50", "xyz-d65",
  "hsl", "hwb", "lch", "oklch", "shorter", "longer", "increasing", "decreasing", "hue",
]);
const HEAD_WORD_SET = new Set(GRADIENT_HEAD_WORDS);
const HEAD_NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:deg|grad|rad|turn|px|em|rem|ex|ch|vw|vh|vmin|vmax|cm|mm|in|pt|pc|q|%)?$/;

// Whether `s` (lower case, single spaces, at most 12 words and 80
// characters) is a gradient's first argument made of those words only.
export function isGradientHead(s) {
  if (typeof s !== "string" || s.length === 0 || s.length > 80) return false;
  const words = s.split(" ");
  return words.length <= 12 && words.every((w) => HEAD_WORD_SET.has(w) || HEAD_NUMBER_RE.test(w));
}

// The first argument of a gradient when it is not a color stop: an angle or
// "to <side>", a radial shape, size and "at" position, a conic "from" angle,
// a color space to interpolate in. Lower case, single spaces; "" when the
// gradient starts with a stop; null when it is something else.
function gradientHead(part) {
  const words = splitTop(part, " ").map((w) => w.toLowerCase());
  if (words.length === 0 || words.length > 12 || words.some((w) => parseColor(w))) return "";
  const head = words.join(" ");
  return isGradientHead(head) ? head : null;
}

// A gradient -> {kind, repeating, head?, stops: [{color, at}]}: head is the
// direction, shape or position written before the stops (gradientHead), at
// a stop's position in percent or null.
export function parseGradient(str) {
  const fn = fnCall(String(str));
  if (!fn) return null;
  const m = STOP_RE.exec(fn.name);
  if (!m) return null;
  const parts = splitTop(fn.args, ",");
  const head = parts.length ? gradientHead(parts[0]) : "";
  if (head === null) return null;
  const stops = [];
  for (const part of head ? parts.slice(1) : parts) {
    const words = splitTop(part, " ");
    let color = null;
    let at = null;
    for (const w of words) {
      const c = color ? null : parseColor(w);
      if (c) color = c;
      else if (color && at === null && w.endsWith("%")) {
        const n = parseNumber(w.slice(0, -1));
        if (n !== null) {
          if (Math.abs(n) > 1e4) return null;
          at = round(n, 2);
        }
      }
    }
    if (color) stops.push({ color, at });
    if (stops.length >= 16) break;
  }
  if (stops.length < 2) return null;
  const out = { kind: m[1], repeating: fn.name.startsWith("repeating-") };
  if (head) out.head = head;
  out.stops = stops;
  return out;
}

// box-shadow -> [{x, y, blur, spread, color, inset}]; "none" and invalid
// layers give null.
export function parseShadow(str) {
  const layers = splitTop(String(str), ",");
  if (layers.length === 0 || layers.length > 8) return null;
  const out = [];
  for (const layer of layers) {
    let inset = false;
    let color = null;
    const lengths = [];
    for (const w of splitTop(layer, " ")) {
      if (w.toLowerCase() === "inset") {
        if (inset) return null;
        inset = true;
        continue;
      }
      const d = parseDimension(w, { unitless: false });
      if (d) {
        lengths.push({ value: d.value, unit: d.unit });
        continue;
      }
      const c = color ? null : parseColor(w);
      if (!c) return null;
      color = c;
    }
    if (lengths.length < 2 || lengths.length > 4) return null;
    const zero = { value: 0, unit: "px" };
    out.push({ x: lengths[0], y: lengths[1], blur: lengths[2] || zero, spread: lengths[3] || zero, color, inset });
  }
  return out;
}

export const BORDER_STYLES = Object.freeze(["none", "hidden", "dotted", "dashed", "solid", "double", "groove", "ridge", "inset", "outset"]);
const BORDER_STYLE_SET = new Set(BORDER_STYLES);
const BORDER_WIDTHS = { thin: 1, medium: 3, thick: 5 };

// border shorthand -> {width, style, color} (each may be null); a border of
// style none, or nothing recognised, gives null.
export function parseBorder(str) {
  const words = splitTop(String(str), " ");
  if (words.length === 0 || words.length > 3) return null;
  let width = null;
  let style = null;
  let color = null;
  for (const w of words) {
    const lw = w.toLowerCase();
    if (!style && BORDER_STYLE_SET.has(lw)) {
      style = lw;
      continue;
    }
    if (!width && BORDER_WIDTHS[lw] !== undefined) {
      width = { value: BORDER_WIDTHS[lw], unit: "px", px: BORDER_WIDTHS[lw] };
      continue;
    }
    const d = !width ? parseDimension(w, { unitless: false }) : null;
    if (d) {
      width = d;
      continue;
    }
    const c = !color ? parseColor(w) : null;
    if (!c) return null;
    color = c;
  }
  if (style === "none" || style === "hidden") return null;
  return { width, style, color };
}

export const GENERIC_FAMILIES = Object.freeze([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif",
  "ui-monospace", "ui-rounded", "math", "emoji", "fangsong",
]);
const GENERIC_SET = new Set(GENERIC_FAMILIES);
const FAMILY_RE = /^[\p{L}\p{N} _.&+-]{1,80}$/u;
// One word of an unquoted family name: a CSS identifier (no leading digit,
// so no number or length).
const IDENT_RE = /^(?:--|-?[\p{L}_])[\p{L}\p{N}_-]*$/u;
// Keywords that mean something else wherever a value is expected.
const CSS_WIDE = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);
const MAX_FAMILY_PARTS = 32;

// font-family -> {families: [...]}, at most 10 (the first ones of a longer
// stack). Names keep their case; quotes are removed; a name holding anything
// but letters, digits, spaces and . _ & + - is dropped, and so is an
// unquoted name that is not made of CSS identifiers ("700", "1.125rem") or
// is a CSS-wide keyword ("inherit").
export function parseFontFamily(str, { requireHint = false } = {}) {
  const parts = splitTop(String(str), ",");
  if (parts.length === 0 || parts.length > MAX_FAMILY_PARTS) return null;
  const families = [];
  let hint = false;
  for (const p of parts) {
    let name = p.trim();
    const q = name[0];
    if ((q === "\"" || q === "'") && name.length >= 2 && name.endsWith(q)) {
      name = name.slice(1, -1).trim();
      hint = true;
    } else {
      name = name.replace(/\s+/g, " ");
      if (GENERIC_SET.has(name.toLowerCase())) {
        name = name.toLowerCase();
        hint = true;
      } else if (CSS_WIDE.has(name.toLowerCase()) || !name.split(" ").every((w) => IDENT_RE.test(w))) continue;
    }
    if (FAMILY_RE.test(name) && !families.includes(name)) families.push(name);
  }
  if (families.length === 0 || (requireHint && !hint)) return null;
  return { families: families.slice(0, 10) };
}

// A var( call that is not the end of a longer function name.
const VAR_CALL_RE = /(?:^|[^A-Za-z0-9_-])var\(/i;
const FONT_SYSTEM = new Set(["caption", "icon", "menu", "message-box", "small-caption", "status-bar"]);
const FONT_SIZE_WORDS = new Set(["xx-small", "x-small", "small", "medium", "large", "x-large", "xx-large", "xxx-large", "smaller", "larger", "math"]);
const FONT_PREFIX_WORDS = new Set([
  "normal", "italic", "oblique", "small-caps", "bolder", "lighter", "ultra-condensed", "extra-condensed", "condensed",
  "semi-condensed", "semi-expanded", "expanded", "extra-expanded", "ultra-expanded",
]);

// The font shorthand -> {size, lineHeight, weight, family}, each a
// normalised value or null: "[style] [variant] [weight] [stretch] size[/line-height] family".
// System fonts (font: menu) and anything else give null. A family given by
// a custom property ("16px/1.5 var(--font-sans)") gives family null, the
// size and line height before it still count; a var() anywhere before the
// family gives null, as its words cannot be placed.
export function parseFontShorthand(str) {
  const words = splitTop(String(str), " ");
  if (words.length < 2 || words.length > 48) return null;
  let weight = null;
  let i = 0;
  for (; i < words.length && i < 5; i++) {
    const w = words[i].toLowerCase();
    if (FONT_PREFIX_WORDS.has(w)) continue;
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:deg|rad|grad|turn)$/.test(w) && i > 0 && words[i - 1].toLowerCase() === "oblique") continue;
    if (w === "bold" || /^\d+(?:\.\d+)?$/.test(w)) {
      const fw = parseFontWeight(w);
      if (!fw || weight) return null;
      weight = fw;
      continue;
    }
    break;
  }
  if (i >= words.length || FONT_SYSTEM.has(words[i].toLowerCase())) return null;
  const sizeWord = words[i].toLowerCase();
  let size = null;
  if (!FONT_SIZE_WORDS.has(sizeWord)) {
    size = parseLength(sizeWord, { unitless: false });
    if (!size || size.unit === "" || size.value < 0) return null;
  }
  i++;
  let lineHeight = null;
  if (words[i] === "/") {
    const lh = words[i + 1];
    if (lh === undefined) return null;
    if (lh.toLowerCase() !== "normal") {
      lineHeight = parseLength(lh);
      if (!lineHeight || lineHeight.value < 0) return null;
    }
    i += 2;
  }
  const rest = words.slice(i).join(" ");
  if (!rest) return null;
  const viaVar = VAR_CALL_RE.test(rest);
  const family = viaVar ? null : parseFontFamily(rest);
  if (!family && !viaVar) return null;
  return { size, lineHeight, weight, family };
}

const WEIGHT_WORDS = {
  thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300, normal: 400, regular: 400, book: 400,
  medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900,
  extrablack: 950, ultrablack: 950,
};

export function parseFontWeight(str) {
  const s = String(str).trim();
  const n = parseNumber(s);
  if (n !== null) return n >= 1 && n <= 1000 ? { value: round(n, 2) } : null;
  const w = WEIGHT_WORDS[s.toLowerCase().replace(/[\s_-]/g, "")];
  return w ? { value: w } : null;
}

export function parseDuration(str) {
  const s = String(str).trim().toLowerCase();
  if (s === "0") return { ms: 0 };
  const m = DIM_RE.exec(s);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v) || v < 0 || v > 3.6e6) return null;
  if (m[2] === "ms") return { ms: round(v, 2) };
  if (m[2] === "s") return { ms: round(v * 1000, 2) };
  return null;
}

const EASINGS = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
};

export function parseEasing(str) {
  const s = String(str).trim().toLowerCase();
  if (EASINGS[s]) return { bezier: [...EASINGS[s]] };
  const fn = fnCall(s);
  if (!fn || fn.name !== "cubic-bezier") return null;
  const p = splitTop(fn.args, ",").map(parseNumber);
  if (p.length !== 4 || p.some((v) => v === null)) return null;
  if (p[0] < 0 || p[0] > 1 || p[2] < 0 || p[2] > 1 || Math.abs(p[1]) > 1e3 || Math.abs(p[3]) > 1e3) return null;
  return { bezier: p.map((v) => round(v, 4)) };
}

export function parseOpacity(str) {
  const s = String(str).trim();
  if (s.endsWith("%")) {
    const n = parseNumber(s.slice(0, -1));
    return n === null || n < 0 || n > 100 ? null : { value: round(n / 100, 4) };
  }
  const n = parseNumber(s);
  return n === null || n < 0 || n > 1 ? null : { value: round(n, 4) };
}

export function parseZIndex(str) {
  const n = parseNumber(String(str).trim());
  return n !== null && Number.isInteger(n) && Math.abs(n) <= 2147483647 ? { value: n } : null;
}

// ---------------------------------------------------------------- by type

export const TYPE_ORDER = Object.freeze([
  "color", "gradient", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing",
  "dimension", "radius", "shadow", "border", "opacity", "zIndex", "duration", "easing", "breakpoint",
]);

const firstWord = (s) => splitTop(s, " ")[0] || "";

// The normalised value of `raw` read as a token of `type`, or null.
export function normalizeValue(type, raw) {
  if (typeof raw !== "string") return null;
  if (raw.length > MAX_VALUE * 2) return null;
  const s = stripImportant(raw.trim());
  if (!s || s.length > MAX_VALUE) return null;
  switch (type) {
    case "color": return parseColor(s) || parseHslChannels(s);
    case "gradient": return parseGradient(s);
    case "fontFamily": return parseFontFamily(s);
    case "fontWeight": return parseFontWeight(s);
    case "fontSize":
    case "letterSpacing":
    case "dimension": {
      const d = parseLength(s, { unitless: type !== "fontSize" });
      return d && (type !== "fontSize" || d.value >= 0) ? d : null;
    }
    case "radius": {
      const d = parseLength(firstWord(s), { unitless: false });
      return d && d.value >= 0 ? d : null;
    }
    case "lineHeight": {
      const d = parseLength(s);
      return d && d.value >= 0 ? d : null;
    }
    case "breakpoint": {
      const d = parseLength(s, { unitless: false });
      return d && d.px !== undefined && d.px >= 0 ? d : null;
    }
    case "shadow": return parseShadow(s);
    case "border": return parseBorder(s);
    case "opacity": return parseOpacity(s);
    case "zIndex": return parseZIndex(s);
    case "duration": return parseDuration(s);
    case "easing": return parseEasing(s);
    default: return null;
  }
}

// A string that is the same for equal normalised values (key order fixed).
export function valueKey(type, v) {
  const walk = (x) => {
    if (x === null || typeof x !== "object") return JSON.stringify(x);
    if (Array.isArray(x)) return `[${x.map(walk).join(",")}]`;
    return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${walk(x[k])}`).join(",")}}`;
  };
  return `${type}|${walk(v)}`;
}

// The color part of a value as "#rrggbb" or "#rrggbbaa".
export function colorText(c) {
  if (!c) return "currentColor";
  if (c.alpha >= 1) return c.hex;
  return `${c.hex}${Math.round(c.alpha * 255).toString(16).padStart(2, "0")}`;
}

const dimText = (d) => (d ? `${d.value}${d.unit}` : "0");
const famText = (f) => (GENERIC_SET.has(f) ? f : `"${f}"`);

// CSS text for a normalised value, built only from its validated parts.
// Returns "" for a value it cannot write.
export function formatValue(type, v) {
  if (v === null || typeof v !== "object") return "";
  switch (type) {
    case "color": return colorText(v);
    case "gradient": {
      const stops = v.stops.map((s) => (s.at === null ? colorText(s.color) : `${colorText(s.color)} ${s.at}%`));
      return `${v.repeating ? "repeating-" : ""}${v.kind}-gradient(${v.head ? `${v.head}, ` : ""}${stops.join(", ")})`;
    }
    case "fontFamily": return v.families.map(famText).join(", ");
    case "fontWeight":
    case "opacity":
    case "zIndex": return String(v.value);
    case "duration": return `${v.ms}ms`;
    case "easing": return `cubic-bezier(${v.bezier.join(", ")})`;
    case "shadow": return v.map((l) => `${l.inset ? "inset " : ""}${dimText(l.x)} ${dimText(l.y)} ${dimText(l.blur)} ${dimText(l.spread)} ${colorText(l.color)}`).join(", ");
    case "border": return [v.width ? dimText(v.width) : "", v.style || "", v.color ? colorText(v.color) : ""].filter(Boolean).join(" ");
    default: return dimText(v);
  }
}

// CSS text for one normalised value of an object style's property (the
// shapes tokens.js checkObjectValue accepts): a color or a gradient for a
// background, {style} for a border style, [] for "no shadow", and the token
// types otherwise. Built only from validated parts; "" when it cannot be
// written. A token id is not a value: callers write its variable instead.
export function formatObjectValue(prop, v) {
  if (v === null || typeof v !== "object") return "";
  switch (prop) {
    case "background":
      if (typeof v.hex === "string") return formatValue("color", v);
      return Array.isArray(v.stops) ? formatValue("gradient", v) : "";
    case "color":
    case "border-color": return formatValue("color", v);
    case "border-style": return typeof v.style === "string" ? v.style : "";
    case "box-shadow": return Array.isArray(v) && v.length === 0 ? "none" : formatValue("shadow", v);
    case "font-family": return formatValue("fontFamily", v);
    case "font-weight": return formatValue("fontWeight", v);
    default: return formatValue("dimension", v);
  }
}
