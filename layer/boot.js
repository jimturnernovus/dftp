// Decides whether the design layer starts in this page.
//
// It starts only inside a frame whose parent is the designer window, and only
// with the per-load nonce the designer put in the frame's name. The name is
// cleared at once so the page cannot read it later. A page opened on its own
// (not in a frame) runs exactly as it would without the designer.
//
// A frame with no nonce is a page that loaded again by itself (a reload, a
// link to another page, hot reload). It says "hello" with its address and
// does nothing else; the designer then opens it again with a fresh nonce.

const NONCE_RE = /^[0-9a-f]{32}$/;
let booted = false;

export function boot(startLayer, config) {
  if (booted) return;
  booted = true;
  try {
    if (!config || typeof config !== "object" || typeof config.ns !== "string" || typeof config.shellOrigin !== "string") return;
    if (window.top === window) return;
    // Framed by someone other than the designer: stay out of the way. Some
    // browsers report "null" here when the frame hides its referrer; the
    // origin and source checks on every message still apply.
    const ao = location.ancestorOrigins;
    if (ao && ao.length > 0 && ao[0] !== config.shellOrigin && ao[0] !== "null") return;
    const prefix = `${config.ns}:`;
    const name = typeof window.name === "string" ? window.name : "";
    let nonce = null;
    if (name.startsWith(prefix)) {
      const n = name.slice(prefix.length);
      if (NONCE_RE.test(n)) nonce = n;
      window.name = "";
    }
    if (!nonce) {
      const path = `${location.pathname}${location.search}`.slice(0, 2000);
      window.parent.postMessage({ [config.ns]: 1, type: "hello", path }, config.shellOrigin);
      return;
    }
    startLayer({ ...config, nonce });
  } catch {
    // The layer must never break the page it runs in.
  }
}
