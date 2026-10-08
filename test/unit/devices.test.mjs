import test from "node:test";
import assert from "node:assert/strict";
import { BUILT_IN_DEVICES, deviceById, pageIdentity, pageIdFromPath, validateDevice, normalPath } from "../../client/core/devices.js";

test("built-in devices", () => {
  assert.deepEqual(BUILT_IN_DEVICES.map((d) => [d.id, d.width, d.height]), [
    ["desktop", 1440, 900],
    ["tablet", 820, 1180],
    ["phone", 390, 844],
  ]);
  assert.equal(deviceById(BUILT_IN_DEVICES, "phone").width, 390);
  assert.equal(deviceById(BUILT_IN_DEVICES, "watch"), null);
  assert.ok(Object.isFrozen(BUILT_IN_DEVICES[0]));
});

test("page identity keeps only the listed query parameters", () => {
  assert.equal(pageIdentity("/clients", "?id=7&tab=notes", ["id"]), "/clients?id=7");
  assert.equal(pageIdentity("/clients", "id=7&tab=notes", []), "/clients");
  assert.equal(pageIdentity("/clients/", "", ["id"]), "/clients");
  assert.equal(pageIdentity("/", "?a=1&b=2", ["b", "a"]), "/?b=2&a=1");
  assert.equal(pageIdentity("/x", new URLSearchParams("id=a b&id=2"), ["id"]), "/x?id=a%20b");
  assert.equal(pageIdentity("x", "", []), "/x");
  assert.equal(normalPath("/a///"), "/a");
  assert.equal(normalPath(""), "/");
});

test("page ids from paths", () => {
  assert.equal(pageIdFromPath("/"), "home");
  assert.equal(pageIdFromPath("/Clients/List"), "clients-list");
  assert.equal(pageIdFromPath("/a?id=4"), "a");
  assert.equal(pageIdFromPath("/con"), "page-con");
  assert.match(pageIdFromPath(`/${"x".repeat(80)}`), /^[a-z0-9][a-z0-9-]{0,47}$/);
});

test("custom devices are range-checked", () => {
  assert.ok(validateDevice({ id: "wide", label: "Wide", width: 1920, height: 1080 }).ok);
  assert.equal(validateDevice({ id: "wide", width: 1920, height: 1080 }).value.label, "wide");
  for (const bad of [
    { id: "w", width: 239, height: 500 },
    { id: "w", width: 3841, height: 500 },
    { id: "w", width: 500, height: 319 },
    { id: "w", width: 500, height: 4001 },
    { id: "W", width: 500, height: 500 },
    { id: "w", width: 500.5, height: 500 },
    { id: "w", width: 500, height: 500, extra: 1 },
    { id: "w", label: "x".repeat(41), width: 500, height: 500 },
  ]) {
    assert.ok(!validateDevice(bad).ok, JSON.stringify(bad));
  }
});
