// A JSON reader that keeps where each value starts, so a token read from a
// token file can name its line. It builds plain node records rather than
// objects, so no key can reach an object prototype, and it stops at a fixed
// depth and node count. Time is linear in the input.
//
//   {t: "obj", off, entries: [{k, off, v}]}   (off: offset of the key)
//   {t: "arr", off, items: [node]}
//   {t: "str" | "num" | "bool", off, v}
//   {t: "null", off}

export const JSON_LIMITS = Object.freeze({ depth: 64, nodes: 200000, string: 100000 });

export class JsonError extends Error {
  // code: "json-invalid" or "json-too-deep"; offset: where reading stopped.
  constructor(code, offset) {
    super(code);
    this.code = code;
    this.offset = offset;
  }
}

const NUM_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const ESC = { "\"": "\"", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function parseJsonTree(text) {
  const s = String(text);
  let i = s.charCodeAt(0) === 0xfeff ? 1 : 0;
  let nodes = 0;

  const bad = (code = "json-invalid") => new JsonError(code, i);
  const ws = () => {
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else break;
    }
  };
  const count = () => {
    if (++nodes > JSON_LIMITS.nodes) throw bad("json-too-deep");
  };

  function str() {
    // at the opening quote
    i++;
    let out = "";
    let from = i;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === 34) {
        out += s.slice(from, i);
        i++;
        if (out.length > JSON_LIMITS.string) throw bad();
        return out;
      }
      if (c < 32) throw bad();
      if (c === 92) {
        out += s.slice(from, i);
        const e = s[i + 1];
        if (e === "u") {
          const hex = s.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw bad();
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else if (ESC[e] !== undefined) {
          out += ESC[e];
          i += 2;
        } else throw bad();
        from = i;
        if (out.length > JSON_LIMITS.string) throw bad();
        continue;
      }
      i++;
    }
    throw bad();
  }

  function value(depth) {
    if (depth > JSON_LIMITS.depth) throw bad("json-too-deep");
    ws();
    count();
    const off = i;
    const c = s[i];
    if (c === "{") {
      i++;
      const entries = [];
      ws();
      if (s[i] === "}") {
        i++;
        return { t: "obj", off, entries };
      }
      for (;;) {
        ws();
        if (s[i] !== "\"") throw bad();
        const koff = i;
        const k = str();
        ws();
        if (s[i] !== ":") throw bad();
        i++;
        const v = value(depth + 1);
        if (!FORBIDDEN_KEYS.has(k)) entries.push({ k, off: koff, v });
        ws();
        if (s[i] === ",") {
          i++;
          continue;
        }
        if (s[i] === "}") {
          i++;
          return { t: "obj", off, entries };
        }
        throw bad();
      }
    }
    if (c === "[") {
      i++;
      const items = [];
      ws();
      if (s[i] === "]") {
        i++;
        return { t: "arr", off, items };
      }
      for (;;) {
        items.push(value(depth + 1));
        ws();
        if (s[i] === ",") {
          i++;
          continue;
        }
        if (s[i] === "]") {
          i++;
          return { t: "arr", off, items };
        }
        throw bad();
      }
    }
    if (c === "\"") return { t: "str", off, v: str() };
    if (s.startsWith("true", i)) {
      i += 4;
      return { t: "bool", off, v: true };
    }
    if (s.startsWith("false", i)) {
      i += 5;
      return { t: "bool", off, v: false };
    }
    if (s.startsWith("null", i)) {
      i += 4;
      return { t: "null", off };
    }
    NUM_RE.lastIndex = i;
    const m = NUM_RE.exec(s);
    if (m && m[0].length) {
      i += m[0].length;
      const v = Number(m[0]);
      if (!Number.isFinite(v)) throw bad();
      return { t: "num", off, v };
    }
    throw bad();
  }

  const root = value(0);
  ws();
  if (i !== s.length) throw bad();
  return root;
}

// The child of an object node under key k, or undefined.
export function getKey(node, k) {
  if (!node || node.t !== "obj") return undefined;
  for (const e of node.entries) if (e.k === k) return e.v;
  return undefined;
}

// A node as a plain value (objects become null-prototype objects). Used for
// small composite token values only.
export function plain(node, depth = 0) {
  if (!node || depth > 16) return null;
  switch (node.t) {
    case "obj": {
      const o = Object.create(null);
      for (const e of node.entries) o[e.k] = plain(e.v, depth + 1);
      return o;
    }
    case "arr": return node.items.map((x) => plain(x, depth + 1));
    case "null": return null;
    default: return node.v;
  }
}
