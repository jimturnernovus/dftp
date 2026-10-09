// The designer's copy of the scan: one scan at a time, samples merged into
// the latest scan, a waiting first read, and a clean stop.

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { createTokens } from "../../server/tokens.mjs";
import { buildDoc } from "../../server/scan/build.mjs";
import { openStore, StoreError } from "../../server/store.mjs";
import { BUILT_IN_DEVICES } from "../../client/core/devices.js";
import { tempRoot, removeRoot, sleep } from "../helpers.mjs";

const pages = [{ id: "home", label: "Home", path: "/", keep: [] }];
const empty = () => buildDoc({ results: [] });
const sample = { page: "home", device: "desktop", theme: "light", elements: 3, values: [{ prop: "color", value: "rgb(1, 2, 3)", count: 3 }] };

async function withStore(fn) {
  const root = await tempRoot({ demo: false });
  try {
    const store = await openStore({ root, pages, devices: BUILT_IN_DEVICES, noFingerprint: true });
    await fn(store, root);
  } finally {
    await removeRoot(root);
  }
}

test("scans run one at a time; a first read waits for the first scan", () => withStore(async (store, root) => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const scan = async (opts) => {
    calls++;
    assert.equal(opts.root, root);
    assert.deepEqual(opts.only, ["demo/"]);
    await gate;
    return empty();
  };
  const tokens = createTokens({ cfg: { root, mode: "demo", libraryPrefixes: [] }, store, scan });
  tokens.start();
  const a = tokens.rescan();
  const reading = tokens.get();
  await sleep(20);
  assert.equal(calls, 1, "a rescan while one runs joins it");
  release();
  assert.equal(await a, (await reading).doc);
  assert.equal((await reading).scanning, false);
  assert.deepEqual(await store.readTokens(), (await tokens.get()).doc);
  await tokens.close();
  await assert.rejects(tokens.rescan());
}));

test("samples are merged into the latest scan and written; close stops a running scan", () => withStore(async (store, root) => {
  let signal;
  const tokens = createTokens({ cfg: { root, mode: "proxy", libraryPrefixes: [] }, store, scan: async () => empty() });
  const doc = await tokens.addSample(sample);
  assert.equal(doc.live.length, 1);
  assert.ok(doc.tokens.some((t) => t.id === "color.auto.010203"));
  assert.equal((await store.readTokens()).live.length, 1);
  const slow = createTokens({
    cfg: { root, mode: "proxy", libraryPrefixes: [] },
    store,
    scan: (opts) => new Promise((resolve) => {
      signal = opts.signal;
      opts.signal.addEventListener("abort", () => resolve(empty()));
    }),
  });
  slow.start();
  await sleep(10);
  await slow.close();
  assert.equal(signal.aborted, true);
  assert.equal((await store.readTokens()).live.length, 1, "a scan stopped by close writes nothing");
}));

test("the store writes only valid token documents, and reads back only valid ones", () => withStore(async (store, root) => {
  await assert.rejects(store.writeTokens({ format: "dftp.tokens" }), (e) => e instanceof StoreError && e.code === "invalid");
  assert.equal(await store.readTokens(), null);
  const written = await store.writeTokens({ ...empty(), extra: "dropped" });
  assert.equal(written.extra, undefined);
  const file = path.join(root, ".dftp", "tokens.json");
  assert.equal(JSON.parse(await fsp.readFile(file, "utf8")).extra, undefined);
  await fsp.writeFile(file, "{\"format\": \"dftp.tokens\", \"version\": 9}");
  assert.equal(await store.readTokens(), null);
  await assert.rejects(fsp.stat(path.join(root, ".dftp", "fingerprint.key")), "noFingerprint makes no key");
}));
