import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  splitTarget, hostMatches, tokenMatches, isJsonType, checkApi, documentFetchAllowed, readBody, parseJsonBody,
  shellCsp, demoCsp, BODY_LIMIT, TOKEN_HEADER,
} from "../../server/guard.mjs";

const shellOrigin = "http://127.0.0.1:7450";
const token = "a".repeat(64);
const req = (headers) => ({ headers, method: "POST" });
const good = { origin: shellOrigin, [TOKEN_HEADER]: token, "content-type": "application/json", "sec-fetch-site": "same-origin" };
const write = (h) => checkApi(req(h), { shellOrigin, token, write: true });
const read = (h) => checkApi(req(h), { shellOrigin, token, write: false });

test("request target: origin-form only, '//' stays a path", () => {
  assert.deepEqual(splitTarget("/a/b?c=1"), { pathname: "/a/b", search: "?c=1" });
  assert.deepEqual(splitTarget("//evil.example/x"), { pathname: "//evil.example/x", search: "" });
  assert.equal(splitTarget("http://evil.example/"), null);
  assert.equal(splitTarget("*"), null);
  assert.equal(splitTarget(""), null);
  assert.equal(splitTarget(undefined), null);
});

test("host must match exactly", () => {
  const h = (host) => hostMatches({ headers: { host } }, "127.0.0.1:7450");
  assert.ok(h("127.0.0.1:7450"));
  assert.ok(!h("evil.example:7450"));
  assert.ok(!h("127.0.0.1:7451"));
  assert.ok(!h("127.0.0.1"));
  assert.ok(!h(undefined));
  assert.ok(!h("127.0.0.1:7450.evil.example"));
});

test("token comparison", () => {
  assert.ok(tokenMatches(token, token));
  assert.ok(!tokenMatches("b".repeat(64), token));
  assert.ok(!tokenMatches(token.slice(1), token));
  assert.ok(!tokenMatches("", token));
  assert.ok(!tokenMatches(undefined, token));
  assert.ok(!tokenMatches([token], token));
});

test("JSON content types", () => {
  assert.ok(isJsonType("application/json"));
  assert.ok(isJsonType("application/json; charset=utf-8"));
  assert.ok(isJsonType("Application/JSON;charset=UTF-8"));
  assert.ok(!isJsonType("text/plain"));
  assert.ok(!isJsonType("application/json-patch+json"));
  assert.ok(!isJsonType("application/x-www-form-urlencoded"));
  assert.ok(!isJsonType("multipart/form-data"));
  assert.ok(!isJsonType(undefined));
});

test("write gate matrix", () => {
  assert.equal(write(good), null);
  assert.equal(write({ ...good, origin: "http://evil.example" }).status, 403);
  assert.equal(write({ ...good, origin: undefined }).status, 403);
  assert.equal(write({ ...good, origin: "null" }).status, 403);
  assert.equal(write({ ...good, origin: "http://127.0.0.1:7451" }).status, 403);
  assert.equal(write({ ...good, origin: "http://localhost:7450" }).status, 403);
  assert.equal(write({ ...good, "content-type": "text/plain" }).status, 415);
  assert.equal(write({ ...good, [TOKEN_HEADER]: "b".repeat(64) }).status, 403);
  assert.equal(write({ ...good, [TOKEN_HEADER]: undefined }).status, 403);
  assert.equal(write({ ...good, "sec-fetch-site": "cross-site" }).status, 403);
  assert.equal(write({ ...good, "sec-fetch-site": "same-site" }).status, 403);
  assert.equal(write({ ...good, "sec-fetch-site": "none" }).status, 403);
  assert.equal(write({ ...good, "sec-fetch-site": undefined }), null);
});

test("read gate", () => {
  assert.equal(read({ [TOKEN_HEADER]: token }), null);
  assert.equal(read({ [TOKEN_HEADER]: token, origin: shellOrigin }), null);
  assert.equal(read({ [TOKEN_HEADER]: token, origin: "http://evil.example" }).status, 403);
  assert.equal(read({}).status, 403);
  assert.equal(read({ [TOKEN_HEADER]: token, "sec-fetch-site": "cross-site" }).status, 403);
});

test("documents: opened by the user or itself only", () => {
  assert.ok(documentFetchAllowed({ headers: {} }));
  assert.ok(documentFetchAllowed({ headers: { "sec-fetch-site": "none" } }));
  assert.ok(documentFetchAllowed({ headers: { "sec-fetch-site": "same-origin" } }));
  assert.ok(!documentFetchAllowed({ headers: { "sec-fetch-site": "cross-site" } }));
  assert.ok(!documentFetchAllowed({ headers: { "sec-fetch-site": "same-site" } }));
});

function fakeReq(chunks, headers = {}) {
  const r = Readable.from(chunks.map((c) => Buffer.from(c)));
  r.headers = headers;
  return r;
}

test("body reader counts bytes", async () => {
  const buf = await readBody(fakeReq(["ab", "cd"]));
  assert.equal(buf.toString(), "abcd");
  await assert.rejects(readBody(fakeReq([], { "content-length": String(BODY_LIMIT + 1) })), (e) => e.status === 413);
  await assert.rejects(readBody(fakeReq(["x".repeat(600 * 1024), "y".repeat(600 * 1024)])), (e) => e.status === 413);
  const multi = "é".repeat(BODY_LIMIT / 2) + "x";
  await assert.rejects(readBody(fakeReq([multi])), (e) => e.status === 413, "limit is in bytes, not characters");
});

test("JSON body parsing", () => {
  assert.deepEqual(parseJsonBody(Buffer.from('{"a":1}')), { a: 1 });
  assert.throws(() => parseJsonBody(Buffer.from([0xff, 0xfe])), (e) => e.status === 400);
  assert.throws(() => parseJsonBody(Buffer.from("{")), (e) => e.status === 400);
  assert.throws(() => parseJsonBody(Buffer.from('{"__proto__":{"polluted":1}}')), (e) => e.status === 400);
  assert.equal(({}).polluted, undefined);
});

test("content security policies", () => {
  const s = shellCsp("http://127.0.0.1:7451");
  for (const part of ["default-src 'none'", "script-src 'self'", "frame-src http://127.0.0.1:7451", "frame-ancestors 'none'", "require-trusted-types-for 'script'", "trusted-types 'none'", "base-uri 'none'", "form-action 'none'", "object-src 'none'", "connect-src 'self'"]) {
    assert.ok(s.includes(part), part);
  }
  assert.ok(!s.includes("unsafe"));
  const d = demoCsp(shellOrigin);
  assert.ok(d.includes(`frame-ancestors ${shellOrigin}`));
  assert.ok(d.includes("connect-src 'none'"));
  assert.ok(!d.includes("unsafe"));
});
