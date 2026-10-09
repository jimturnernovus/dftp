// The designer's copy of the style scan: one scan when the designer starts
// (in the background), another on request, and live samples from the page
// merged in. The scan's own result is kept in memory so samples can be
// merged into it again at any time; every new result is written to
// .dftp/tokens.json through the store.

import { scanProject } from "./scan/scanner.mjs";
import { applyLive, mergeSamples } from "./scan/live.mjs";
import { stamp } from "./scan/build.mjs";

const FIRST_SCAN_WAIT_MS = 12000;
// How long closing waits for a scan that is still running.
export const CLOSE_WAIT_MS = 1500;

// cfg: the frozen settings (root, mode, libraryPrefixes, devices). store:
// openStore().
export function createTokens({ cfg, store, scan = scanProject }) {
  const controller = new AbortController();
  const only = cfg.mode === "demo" ? ["demo/"] : null;
  let scanned = null;
  let current = null;
  let samples = null;
  let running = null;
  let closed = false;

  async function loadSamples() {
    if (samples !== null) return;
    const old = await store.readTokens().catch(() => null);
    samples = old && Array.isArray(old.live) ? old.live : [];
  }

  // Merge `nextSamples` into the scan and write the result. Only what the
  // store accepted (validated) becomes the current document, and the
  // samples are kept only then: a document that fails leaves the last good
  // one in place, and a sample that made it fail is not kept.
  async function publish(nextSamples = samples) {
    const next = nextSamples.length ? applyLive(scanned, nextSamples, { devices: cfg.devices }) : scanned;
    if (closed) return current;
    current = await store.writeTokens(next);
    samples = nextSamples;
    return current;
  }

  function rescan() {
    if (closed) return Promise.reject(new Error("closed"));
    if (running) return running;
    running = (async () => {
      try {
        await loadSamples();
        const doc = await scan({ root: cfg.root, libraryPrefixes: cfg.libraryPrefixes, only, signal: controller.signal });
        if (closed) return current;
        const before = scanned;
        scanned = doc;
        try {
          return await publish();
        } catch (e) {
          scanned = before;
          throw e;
        }
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    // Starts the first scan without waiting for it.
    start() {
      rescan().catch(() => {});
    },

    // {doc, scanning}. While the first scan runs and nothing is known yet,
    // waits for it (up to 12 s).
    async get() {
      if (!current && running) {
        let timer;
        await Promise.race([
          running.catch(() => {}),
          new Promise((r) => {
            timer = setTimeout(r, FIRST_SCAN_WAIT_MS);
          }),
        ]);
        clearTimeout(timer);
      }
      return { doc: current, scanning: !!running };
    },

    rescan,

    // sample: a validated live sample. Resolves to the merged document.
    async addSample(sample) {
      await loadSamples();
      if (running) await running.catch(() => {});
      if (!scanned) await rescan();
      return publish(mergeSamples(samples, sample, stamp()));
    },

    // Stops the scan; waits for it at most CLOSE_WAIT_MS, so a scan that
    // never ends cannot hold up shutting down.
    async close() {
      closed = true;
      controller.abort();
      if (!running) return;
      let timer;
      await Promise.race([
        running.catch(() => {}),
        new Promise((r) => {
          timer = setTimeout(r, CLOSE_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
    },
  };
}
