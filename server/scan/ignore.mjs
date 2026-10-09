// .gitignore patterns, read simply: comments, "!" negation, a trailing "/"
// for folders only, a leading or inner "/" to anchor a pattern to its
// .gitignore's folder, and the wildcards *, ?, [...] and **. Patterns are
// matched by hand-written code, never turned into regular expressions, and
// their number and length are capped.

export const IGNORE_LIMITS = Object.freeze({ rules: 1000, line: 1000, file: 64 * 1024 });

// One path segment against one pattern segment (*, ?, [...], \x). Iterative,
// with one remembered star, so the cost is at most the product of the two
// lengths (both short).
export function globSegment(pat, str) {
  let p = 0;
  let s = 0;
  let starP = -1;
  let starS = 0;
  while (s < str.length) {
    if (p < pat.length) {
      const c = pat[p];
      if (c === "*") {
        starP = p++;
        starS = s;
        continue;
      }
      if (c === "?") {
        p++;
        s++;
        continue;
      }
      if (c === "[") {
        const r = matchClass(pat, p, str[s]);
        if (r.end !== -1) {
          if (r.ok) {
            p = r.end;
            s++;
            continue;
          }
        } else if (str[s] === "[") {
          p++;
          s++;
          continue;
        }
      } else if (c === "\\" && p + 1 < pat.length) {
        if (pat[p + 1] === str[s]) {
          p += 2;
          s++;
          continue;
        }
      } else if (c === str[s]) {
        p++;
        s++;
        continue;
      }
    }
    if (starP === -1) return false;
    p = starP + 1;
    s = ++starS;
  }
  while (p < pat.length && pat[p] === "*") p++;
  return p === pat.length;
}

// A [...] class at pat[p]: {ok, end} with end just past "]", or end -1 when
// the class is not closed (the "[" is then an ordinary character).
function matchClass(pat, p, ch) {
  let i = p + 1;
  let neg = false;
  if (pat[i] === "!" || pat[i] === "^") {
    neg = true;
    i++;
  }
  let ok = false;
  let first = true;
  while (i < pat.length && (pat[i] !== "]" || first)) {
    first = false;
    let lo = pat[i];
    if (lo === "\\" && i + 1 < pat.length) lo = pat[++i];
    if (pat[i + 1] === "-" && i + 2 < pat.length && pat[i + 2] !== "]") {
      const hi = pat[i + 2];
      if (ch >= lo && ch <= hi) ok = true;
      i += 3;
    } else {
      if (ch === lo) ok = true;
      i++;
    }
  }
  if (i >= pat.length) return { ok: false, end: -1 };
  return { ok: ok !== neg, end: i + 1 };
}

// Pattern segments against path segments, with "**" matching any number of
// segments. Memoised, so the cost is the product of the two counts.
function matchSegments(pats, segs) {
  const memo = new Map();
  const go = (i, j) => {
    const key = i * 1024 + j;
    if (memo.has(key)) return memo.get(key);
    let r;
    if (i === pats.length) r = j === segs.length;
    else if (pats[i] === "**") r = go(i + 1, j) || (j < segs.length && go(i, j + 1));
    else r = j < segs.length && globSegment(pats[i], segs[j]) && go(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

function parseLine(line, base) {
  let l = line.replace(/\r$/, "");
  if (!l || l.startsWith("#") || l.length > IGNORE_LIMITS.line) return null;
  // Trailing spaces are dropped unless escaped.
  while (l.endsWith(" ") && !l.endsWith("\\ ")) l = l.slice(0, -1);
  if (!l) return null;
  let neg = false;
  if (l.startsWith("!")) {
    neg = true;
    l = l.slice(1);
  } else if (l.startsWith("\\!") || l.startsWith("\\#")) l = l.slice(1);
  let dirOnly = false;
  if (l.endsWith("/")) {
    dirOnly = true;
    l = l.replace(/\/+$/, "");
  }
  if (!l) return null;
  const anchored = l.includes("/");
  const segs = l.replace(/^\/+/, "").split("/").filter((s) => s !== "");
  if (segs.length === 0 || segs.length > 64) return null;
  return { neg, dirOnly, anchored, segs, base };
}

export function createIgnore() {
  const rules = [];
  let capped = false;
  return {
    get capped() {
      return capped;
    },
    // text: one .gitignore; base: its folder relative to the root ("" for the root).
    add(text, base = "") {
      const lines = String(text).slice(0, IGNORE_LIMITS.file).split("\n");
      for (const line of lines) {
        const r = parseLine(line, base);
        if (!r) continue;
        if (rules.length >= IGNORE_LIMITS.rules) {
          capped = true;
          return;
        }
        rules.push(r);
      }
    },
    // relPath: "/"-separated, relative to the root.
    ignored(relPath, isDir) {
      let out = false;
      for (const r of rules) {
        if (r.neg === out) {
          // Only a rule that could change the answer needs checking.
          if (r.dirOnly && !isDir) continue;
          let rest = relPath;
          if (r.base) {
            if (!relPath.startsWith(`${r.base}/`)) continue;
            rest = relPath.slice(r.base.length + 1);
          }
          const segs = rest.split("/");
          const hit = r.anchored ? matchSegments(r.segs, segs) : globSegment(r.segs[0], segs[segs.length - 1]);
          if (hit) out = !r.neg;
        }
      }
      return out;
    },
  };
}
