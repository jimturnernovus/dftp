// Screen sizes the designer can show a page at, and how a page address is
// reduced to the identity used to file its changes. Browser and Node.

import { isId } from "./schema.js";

export const DEVICE_LIMITS = Object.freeze({ minWidth: 240, maxWidth: 3840, minHeight: 320, maxHeight: 4000, maxCount: 6, label: 40 });

export const BUILT_IN_DEVICES = Object.freeze([
  Object.freeze({ id: "desktop", label: "Desktop", width: 1440, height: 900 }),
  Object.freeze({ id: "tablet", label: "Tablet", width: 820, height: 1180 }),
  Object.freeze({ id: "phone", label: "Phone", width: 390, height: 844 }),
]);

export function deviceById(devices, id) {
  for (const d of devices) if (d.id === id) return d;
  return null;
}

// One device entry from a config file. Returns {ok, value} or {ok:false, error}.
export function validateDevice(d) {
  if (d === null || typeof d !== "object" || Array.isArray(d)) return { ok: false, error: "device: must be an object" };
  const allowed = new Set(["id", "label", "width", "height"]);
  for (const k of Object.keys(d)) if (!allowed.has(k)) return { ok: false, error: `device: unknown key "${k}"` };
  if (!isId(d.id)) return { ok: false, error: "device.id: must be a lower-case slug" };
  const label = d.label === undefined ? d.id : d.label;
  if (typeof label !== "string" || label.length === 0 || label.length > DEVICE_LIMITS.label || /[\u0000-\u001F\u007F]/.test(label)) { // eslint-disable-line no-control-regex
    return { ok: false, error: "device.label: 1-40 printable characters" };
  }
  const { minWidth, maxWidth, minHeight, maxHeight } = DEVICE_LIMITS;
  if (!Number.isInteger(d.width) || d.width < minWidth || d.width > maxWidth) {
    return { ok: false, error: `device.width: whole number ${minWidth}-${maxWidth}` };
  }
  if (!Number.isInteger(d.height) || d.height < minHeight || d.height > maxHeight) {
    return { ok: false, error: `device.height: whole number ${minHeight}-${maxHeight}` };
  }
  return { ok: true, value: { id: d.id, label, width: d.width, height: d.height } };
}

// Normalise a pathname: always a leading slash, no trailing slash (except "/").
export function normalPath(pathname) {
  let p = String(pathname || "/");
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1 && p.endsWith("/")) p = p.replace(/\/+$/, "") || "/";
  return p;
}

// The identity of a page address: its path plus only the query parameters
// listed in `keep` (in that order, first value of each). Everything else in
// the query (a tab, a filter, a cache-buster) does not make it another page.
export function pageIdentity(pathname, query, keep = []) {
  const p = normalPath(pathname);
  if (!Array.isArray(keep) || keep.length === 0) return p;
  let params;
  if (query instanceof URLSearchParams) params = query;
  else params = new URLSearchParams(String(query || "").replace(/^\?/, ""));
  const parts = [];
  for (const name of keep) {
    const v = params.get(name);
    if (v !== null) parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(v)}`);
  }
  return parts.length ? `${p}?${parts.join("&")}` : p;
}

// A page id made from a path: "/clients/list" -> "clients-list", "/" -> "home".
export function pageIdFromPath(path) {
  const slug = String(path || "")
    .split("?")[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  const id = slug || "home";
  return isId(id) ? id : `page-${id}`.slice(0, 48);
}
