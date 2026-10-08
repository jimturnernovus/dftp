// Test preload (node --import ./test/no-net.mjs): any network connection to
// a host other than this computer's loopback throws, so a test can never
// reach the outside world by accident. Local pipes and Unix sockets are fine.

import net from "node:net";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "::ffff:127.0.0.1"]);

function isLoopback(host) {
  if (host === undefined || host === null || host === "") return true;
  const h = String(host).toLowerCase();
  return LOOPBACK.has(h) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function blocked(host) {
  const err = new Error(`network access to ${String(host).slice(0, 80)} is blocked in tests`);
  err.code = "E_TEST_NO_NET";
  return err;
}

function hostOf(args) {
  const a0 = args[0];
  if (Array.isArray(a0)) return hostOf(a0);
  if (a0 && typeof a0 === "object") {
    if (a0.path) return "localhost";
    return a0.host ?? a0.hostname ?? "localhost";
  }
  if (typeof a0 === "string" && !/^\d+$/.test(a0)) return "localhost";
  return typeof args[1] === "string" ? args[1] : "localhost";
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const host = hostOf(args);
  if (!isLoopback(host)) throw blocked(host);
  return connect.apply(this, args);
};

for (const name of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]) {
  const orig = dns[name];
  if (typeof orig !== "function") continue;
  dns[name] = function guardedDns(hostname, ...rest) {
    if (!isLoopback(hostname)) throw blocked(hostname);
    return orig.call(this, hostname, ...rest);
  };
}
const promiseLookup = dns.promises.lookup;
dns.promises.lookup = function guardedLookup(hostname, ...rest) {
  if (!isLoopback(hostname)) return Promise.reject(blocked(hostname));
  return promiseLookup.call(this, hostname, ...rest);
};

if (typeof globalThis.fetch === "function") {
  const fetch0 = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    let host;
    try {
      host = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url).hostname;
    } catch {
      host = "";
    }
    if (!isLoopback(host)) return Promise.reject(blocked(host));
    return fetch0.call(this, input, init);
  };
}

syncBuiltinESMExports();
globalThis.__dftpNoNet = true;
