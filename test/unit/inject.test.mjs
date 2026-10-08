// Adding the layer's script to HTML that comes back through the proxy: where
// the tag goes, compressed pages, CSP nonces, size limits, charsets, and the
// --relax-csp switch. The pure helpers are tested directly too.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { startApp, request } from "../helpers.mjs";
import { startUpstream, page, BIG, NONCE, META_NONCE } from "../fixtures/upstream.mjs";
import {
  INJECT_LIMIT, findInsertPoint, injectLayer, layerTag, nonceFromPolicies, withoutFrameAncestors,
  parseEncodings, decodeBody, attributesOf, isHtmlType,
} from "../../server/inject.mjs";

const SRC = "http://127.0.0.1:7451/__dftp/overlay.js";

let up;
let app;
let relaxed;

before(async () => {
  up = await startUpstream();
  app = await startApp({ flags: { demo: false, target: up.origin } });
  relaxed = await startApp({ flags: { demo: false, target: up.origin, relaxCsp: true } });
});

after(async () => {
  await app.close();
  await relaxed.close();
  await up.close();
});

const get = (p, headers = {}, extra = {}) => request(app.framePort, { path: p, headers, ...extra });
const tagFor = (t, nonce) => `<script type="module" src="${t.frameOrigin}/__dftp/overlay.js"${nonce ? ` nonce="${nonce}"` : ""}></script>`;
const count = (s, sub) => s.split(sub).length - 1;

// Byte-exact copy of what the dev server sends for a path.
async function upstreamBody(p) {
  const r = await request(up.port, { path: p, headers: { "accept-encoding": "identity" } });
  return r.body;
}

// ---------------------------------------------------------------- through the proxy

test("the tag goes right after <head ...>, once, with a correct length", async () => {
  const r = await get("/page");
  assert.equal(r.status, 200);
  assert.ok(r.text.includes(`<head data-x="a > b">${tagFor(app)}<meta charset="utf-8">`));
  assert.equal(count(r.text, "/__dftp/overlay.js"), 1);
  assert.equal(Number(r.headers["content-length"]), r.body.length);
  const expected = Buffer.concat([await upstreamBody("/page")]).toString().replace('<head data-x="a > b">', `<head data-x="a > b">${tagFor(app)}`);
  assert.equal(r.text, expected, "nothing else in the page changes");
});

test("gzip, brotli and deflate pages are decoded, given the tag and sent uncompressed", async () => {
  for (const [p, title] of [["/gzip", "Gzip page"], ["/br", "Brotli page"], ["/deflate-raw", "Deflate page"]]) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers["content-encoding"], undefined, p);
    assert.equal(r.headers.etag, undefined, p);
    assert.equal(Number(r.headers["content-length"]), r.body.length, p);
    assert.equal(r.text, page(title).replace('<head data-x="a > b">', `<head data-x="a > b">${tagFor(app)}`), p);
  }
});

test("a compressed page that would decode past 8 MiB passes through still compressed, without the tag", async () => {
  const r = await get("/gzip-bomb");
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-encoding"], "gzip");
  assert.deepEqual(r.body, await upstreamBody("/gzip-bomb"));
  assert.ok(zlib.gunzipSync(r.body).length > INJECT_LIMIT);
});

test("non-HTML stays exactly as sent, compressed or not", async () => {
  const js = await get("/gzip-script");
  assert.equal(js.headers["content-encoding"], "gzip");
  assert.equal(zlib.gunzipSync(js.body).toString(), "console.log(1);\n");
  const json = await get("/json");
  assert.equal(json.text, "{\"ok\":true}");
});

test("an upstream CSP nonce is reused on the tag", async () => {
  const r = await get("/nonce");
  assert.ok(r.text.includes(tagFor(app, NONCE)), "header nonce");
  assert.equal(r.headers["content-security-policy"], `script-src 'nonce-${NONCE}' 'strict-dynamic'; object-src 'none', frame-ancestors ${app.shellOrigin}`);
  assert.ok((await get("/nonce-elem")).text.includes(tagFor(app, "fromelem")), "script-src-elem wins over script-src and default-src");
  assert.ok((await get("/meta-nonce")).text.includes(tagFor(app, META_NONCE)), "a <meta> policy's nonce");
  assert.ok((await get("/nonce-bad")).text.includes(tagFor(app)), "a nonce with odd characters is never copied");
  assert.ok((await get("/nonce-report-only")).text.includes(tagFor(app)), "report-only policies do not block, so no nonce");
});

test("pages over 8 MiB pass through untouched, with or without a length", async () => {
  for (const p of ["/big", "/big-chunked"]) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.ok(r.body.length > BIG - 1, p);
    assert.ok(!r.text.includes("/__dftp/overlay.js"), p);
    assert.deepEqual(r.body, await upstreamBody(p), p);
  }
});

test("bytes in other charsets are kept exactly; UTF-16 pages are left alone", async () => {
  const latin = await get("/latin1");
  const orig = await upstreamBody("/latin1");
  const at = orig.indexOf("<head>") + "<head>".length;
  assert.deepEqual(latin.body, Buffer.concat([orig.subarray(0, at), Buffer.from(tagFor(app)), orig.subarray(at)]));
  const wide = await get("/utf16");
  assert.deepEqual(wide.body, await upstreamBody("/utf16"));
});

test("only successful document loads get the tag", async () => {
  assert.ok(!(await get("/missing-html")).text.includes("__dftp"), "a 404 page");
  const head = await get("/page", {}, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers["content-length"], undefined, "HEAD gives no length the GET would not match");
  for (const dest of ["script", "empty", "style", "image"]) {
    assert.ok(!(await get("/page", { "sec-fetch-dest": dest })).text.includes("__dftp"), dest);
  }
  for (const dest of ["document", "iframe", "frame"]) {
    assert.ok((await get("/page", { "sec-fetch-dest": dest })).text.includes(tagFor(app)), dest);
  }
});

test("--relax-csp drops the page's policy (header and <meta>) but keeps our frame-ancestors", async () => {
  const r = await request(relaxed.framePort, { path: "/hash-only" });
  assert.equal(r.headers["content-security-policy"], `frame-ancestors ${relaxed.shellOrigin}`);
  assert.ok(r.text.includes(tagFor(relaxed)));
  assert.ok(r.text.includes("<meta data-dftp-http-equiv=\"content-security-policy\""));
  assert.ok(!/\shttp-equiv=/i.test(r.text), "no live http-equiv left");
  const n = await request(relaxed.framePort, { path: "/nonce" });
  assert.ok(n.text.includes(tagFor(relaxed)), "no nonce needed once the policy is gone");
  assert.equal(n.headers["content-security-policy"], `frame-ancestors ${relaxed.shellOrigin}`);
  const page1 = await request(relaxed.framePort, { path: "/page" });
  assert.equal(page1.headers["content-security-policy-report-only"], undefined);
});

// ---------------------------------------------------------------- helpers

test("insert point: after <head>, else after <html>, else after the doctype, else at the start", () => {
  const at = (s) => findInsertPoint(s).at;
  const head = "<!doctype html><!-- <head> --><html><head lang='a>b'><title>x</title>";
  assert.equal(at(head), head.indexOf("<title>"));
  assert.equal(at("<!DOCTYPE html><HTML><HEAD><meta>"), "<!DOCTYPE html><HTML><HEAD>".length);
  assert.equal(at("<!doctype html><html lang=en><meta charset=utf-8><body>"), "<!doctype html><html lang=en>".length);
  assert.equal(at("<!doctype html>\n<body><header>x</header>"), "<!doctype html>".length, "<header> is not <head>");
  assert.equal(at("<!doctype html><script>var s='<head>'</script><head>"), "<!doctype html>".length, "content before any head");
  assert.equal(at("<p>fragment</p>"), 0);
  assert.equal(at("  \n<!-- c --><p>x"), 0);
  assert.equal(at("ï»¿<p>x"), 3, "after a UTF-8 byte order mark");
  assert.equal(at("<html"), 0, "an unfinished tag is not used");
});

test("CSP meta tags are found only inside the head", () => {
  const html = "<html><head><meta http-equiv='Content-Security-Policy' content=\"script-src 'nonce-abc'\"><script>var x = '<meta http-equiv=content-security-policy content=x>'</script></head><body><meta http-equiv=content-security-policy content=\"script-src 'nonce-late'\">";
  const { metas } = findInsertPoint(html);
  assert.equal(metas.length, 1);
  assert.equal(metas[0].policy, "script-src 'nonce-abc'");
  assert.equal(html.slice(metas[0].renameStart, metas[0].renameEnd), "http-equiv");
  const entity = findInsertPoint("<head><meta http-equiv=\"content-security-policy\" content=\"script-src &#39;nonce-ent&#39;\">");
  assert.equal(nonceFromPolicies(entity.metas.map((m) => m.policy)), "ent");
});

test("injectLayer refuses wide encodings and oversized input", () => {
  assert.equal(injectLayer(Buffer.from([0xff, 0xfe, 0x3c, 0]), { scriptSrc: SRC }), null);
  assert.equal(injectLayer(Buffer.from([0xfe, 0xff, 0, 0x3c]), { scriptSrc: SRC }), null);
  assert.equal(injectLayer(Buffer.from("<head>"), { scriptSrc: SRC, contentType: "text/html; charset=UTF-16" }), null);
  assert.equal(injectLayer(Buffer.alloc(INJECT_LIMIT + 1, 0x20), { scriptSrc: SRC }), null);
  const ok = injectLayer(Buffer.from("<head></head>"), { scriptSrc: SRC, contentType: "text/html; charset=utf-8" });
  assert.equal(ok.toString(), `<head><script type="module" src="${SRC}"></script></head>`);
});

test("layerTag accepts only the layer's own loopback address and safe nonces", () => {
  assert.throws(() => layerTag("http://evil.example/__dftp/overlay.js"));
  assert.throws(() => layerTag(`${SRC}"><script>`));
  assert.throws(() => layerTag("/__dftp/overlay.js"));
  assert.equal(layerTag("http://[::1]:7451/__dftp/overlay.js"), "<script type=\"module\" src=\"http://[::1]:7451/__dftp/overlay.js\"></script>");
  assert.equal(layerTag(SRC, "a\"b"), `<script type="module" src="${SRC}"></script>`);
  assert.equal(layerTag(SRC, "ab+/_-=="), `<script type="module" src="${SRC}" nonce="ab+/_-=="></script>`);
});

test("CSP helpers", () => {
  assert.deepEqual(withoutFrameAncestors("default-src 'self'; FRAME-ANCESTORS 'none'"), ["default-src 'self'"]);
  assert.deepEqual(withoutFrameAncestors(["frame-ancestors 'none'", "img-src 'self', frame-ancestors x; script-src 'self'"]), ["img-src 'self'", "script-src 'self'"]);
  assert.deepEqual(withoutFrameAncestors(undefined), []);
  assert.equal(nonceFromPolicies("default-src 'nonce-d'"), "d");
  assert.equal(nonceFromPolicies("script-src 'self'; default-src 'nonce-d'"), null, "script-src without a nonce decides");
  assert.equal(nonceFromPolicies(["img-src 'self'", "script-src 'NONCE-x1'"]), "x1");
  assert.equal(nonceFromPolicies("script-src 'nonce-'"), null);
});

test("content codings", async () => {
  assert.deepEqual(parseEncodings("gzip, br"), ["gzip", "br"]);
  assert.deepEqual(parseEncodings("x-gzip"), ["gzip"]);
  assert.deepEqual(parseEncodings("identity"), []);
  assert.deepEqual(parseEncodings(undefined), []);
  assert.equal(parseEncodings("compress"), null);
  const twice = zlib.brotliCompressSync(zlib.gzipSync("<p>x</p>"));
  assert.equal((await decodeBody(twice, ["gzip", "br"])).toString(), "<p>x</p>");
  assert.equal((await decodeBody(zlib.deflateSync("<p>z</p>"), ["deflate"])).toString(), "<p>z</p>");
  assert.equal(await decodeBody(Buffer.from("not gzip"), ["gzip"]), null);
  assert.equal(await decodeBody(zlib.gzipSync(Buffer.alloc(2048)), ["gzip"], 1024), null);
});

test("small parsers", () => {
  const tag = "<meta a=1 b='two' c=\"th ree\" d e = 'f'>";
  const attrs = attributesOf(tag, 5, tag.length - 1).map((a) => [a.name, a.value]);
  assert.deepEqual(attrs, [["a", "1"], ["b", "two"], ["c", "th ree"], ["d", ""], ["e", "f"]]);
  assert.ok(isHtmlType("Text/HTML; charset=utf-8"));
  assert.ok(!isHtmlType("application/xhtml+xml"));
  assert.ok(!isHtmlType(undefined));
});
