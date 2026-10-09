// Object styles through the live sample and on blank pages, against a
// fixture project with distinct buttons (primary and secondary), cards,
// text boxes, badges, avatars, headings, body text, a link and a divider,
// served by a tiny static dev server through the proxy:
//   - the page's sample records each kind's bundles with the right values,
//     variants and counts, named by tokens where tokens have the values,
//     and never any text, attribute value or typed value;
//   - the Styles tab lists them with previews drawn from those values;
//   - palette elements on a blank page copy them: their computed styles
//     match the fixture's own elements;
//   - a huge page is capped.

import { test } from "@playwright/test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { openDesigner, expect, tempRoot, removeRoot, TOOL_DIR, saves, waitSaved, readDoc, waitLoaded, setMode } from "./helpers.mjs";
import { startStaticSite } from "../fixtures/static-site.mjs";

const LONG_TEST_MS = 90000;
const PROJECTS = path.join(TOOL_DIR, "test", "fixtures", "projects");
const SECRETS = ["TEXTSECRET", "ATTRSECRET", "TYPEDSECRET", "Team overview", "Billing", "See plans", "example.test"];

async function project(files = {}) {
  const root = await tempRoot({ demo: false });
  await fsp.cp(path.join(PROJECTS, "objects"), root, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fsp.writeFile(path.join(root, rel), text);
  }
  return root;
}

async function openProject(browser, root, flags = {}) {
  const site = await startStaticSite(root);
  let d;
  try {
    d = await openDesigner(browser, { root, flags: { demo: false, target: site.origin, ...flags } });
  } catch (e) {
    await site.close();
    await removeRoot(root);
    throw e;
  }
  const close = d.close;
  d.close = async () => {
    await close();
    await site.close();
    await removeRoot(root);
  };
  return d;
}

const readTokens = (root) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, ".dftp", "tokens.json"), "utf8"));
  } catch {
    return null;
  }
};
const liveObject = (doc, kind, variant) => (doc && doc.objects ? doc.objects.find((o) => o.source === "live" && o.kind === kind && o.variant === variant) : null) || null;

// A bundle value in px or as a color hex, a token id read through the token.
function valueOf(doc, o, prop) {
  let v = o.style[prop];
  if (typeof v === "string") v = doc.tokens.find((t) => t.id === v).value;
  if (v && typeof v.hex === "string") return v.alpha < 1 ? `${v.hex}/${v.alpha}` : v.hex;
  if (v && v.style) return v.style;
  if (v && Number.isFinite(v.px)) return v.px;
  if (v && Number.isFinite(v.value)) return v.unit ? `${v.value}${v.unit}` : v.value;
  return v;
}

// The computed styles compared between the fixture's elements and the new
// elements that copy them.
const COMPARED = [
  "background-color", "background-image", "color", "border-top-width", "border-top-style", "border-top-color", "border-left-width",
  "border-left-style", "border-top-left-radius", "box-shadow", "padding-top", "padding-left", "padding-bottom", "padding-right",
  "font-family", "font-size", "font-weight", "line-height", "letter-spacing",
];
const looks = (frame, selector, props) => frame.evaluate(([sel, list]) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const out = { height: Math.round(el.getBoundingClientRect().height * 100) / 100 };
  for (const p of list) out[p] = cs.getPropertyValue(p);
  return out;
}, [selector, props]);

// Equal within half a pixel for lengths; font names without quotes.
function sameLook(want, got, props) {
  const diffs = [];
  for (const p of props) {
    const a = String(want[p]);
    const b = String(got[p]);
    if (p === "font-family") {
      if (a.replace(/["']/g, "") !== b.replace(/["']/g, "")) diffs.push(`${p}: ${a} vs ${b}`);
    } else if (/^-?[\d.]+px$/.test(a) && /^-?[\d.]+px$/.test(b)) {
      if (Math.abs(parseFloat(a) - parseFloat(b)) > 0.5) diffs.push(`${p}: ${a} vs ${b}`);
    } else if (p === "height") {
      if (Math.abs(Number(a) - Number(b)) > 0.5) diffs.push(`${p}: ${a} vs ${b}`);
    } else if (a !== b) diffs.push(`${p}: ${a} vs ${b}`);
  }
  return diffs;
}

test.describe("object styles", () => {
  test.setTimeout(LONG_TEST_MS);

  test("the live sample records each kind's look with variants, values and counts, and never text, attribute or typed values", async ({ browser }) => {
    const root = await project();
    const d = await openProject(browser, root);
    try {
      await expect.poll(() => liveObject(readTokens(root), "button", "primary"), { timeout: 10000 }).not.toBeNull();
      // A value typed into a text box, then a fresh sample.
      await setMode(d.page, "use");
      await d.frame.locator("input[type=text]").fill("TYPEDSECRET-9");
      await setMode(d.page, "design");
      await d.page.locator("#side-tab-styles").click();
      const n = d.samples.length;
      await d.page.locator("#styles-rescan").click();
      await expect.poll(() => d.samples.length, { timeout: 8000 }).toBeGreaterThan(n);

      // What the page sent: one bundle per kind and variant here, counted.
      const sent = JSON.parse(d.samples[d.samples.length - 1].body);
      const counts = Object.fromEntries(sent.objects.map((o) => [`${o.kind}.${o.variant}`, o.count]));
      expect(counts).toMatchObject({
        "button.primary": 3, "button.secondary": 2, "card.default": 2, "input.text": 2, "badge.pill": 4, "avatar.initials": 3,
        "heading.h1": 1, "heading.h2": 2, "link.default": 1, "divider.default": 1, "text.body": 2,
      });
      expect(sent.objects.filter((o) => o.kind === "button")).toHaveLength(2);
      const primarySent = sent.objects.find((o) => o.kind === "button" && o.variant === "primary").style;
      expect(primarySent).toMatchObject({ background: "rgb(37, 99, 235)", color: "rgb(255, 255, 255)", "border-radius": "8px", "padding-block": "10px", "padding-inline": "18px", height: "42px", "font-size": "14px", "font-weight": "600", "line-height": "20px" });

      // tokens.json: the same bundles, named by tokens where tokens have the values.
      await expect.poll(() => (readTokens(root)?.live || []).length, { timeout: 8000 }).toBe(1);
      const doc = readTokens(root);
      const primary = liveObject(doc, "button", "primary");
      expect(primary.count).toBe(3);
      expect(primary.style).toMatchObject({ background: "color.primary", color: "color.primary.foreground", "border-radius": "radius.md" });
      expect([valueOf(doc, primary, "padding-block"), valueOf(doc, primary, "padding-inline"), valueOf(doc, primary, "height")]).toEqual([10, 18, 42]);
      expect([valueOf(doc, primary, "border-width"), valueOf(doc, primary, "border-style"), valueOf(doc, primary, "border-color")]).toEqual([1, "solid", "#000000/0"]);
      // It looks like the .btn-primary rule, so it names that rule's file.
      expect(primary.sources).toContainEqual({ adapter: "live", page: "home", device: "desktop" });
      expect(primary.sources).toContainEqual(expect.objectContaining({ file: "src/styles/app.css", name: ".btn-primary" }));
      const secondary = liveObject(doc, "button", "secondary");
      expect(secondary.count).toBe(2);
      expect(secondary.style).toMatchObject({ background: "color.surface", color: "color.text", "border-color": "color.border" });
      expect(secondary.sources).toContainEqual(expect.objectContaining({ name: ".btn-secondary" }));
      expect(secondary.sources.some((s) => s.name === ".btn-primary")).toBe(false);
      const card = liveObject(doc, "card", "default");
      expect(card.count).toBe(2);
      expect(card.style).toMatchObject({ background: "color.surface", "border-color": "color.border", "border-radius": "radius.card.radius", "box-shadow": "shadow.card" });
      expect([valueOf(doc, card, "padding-block"), valueOf(doc, card, "padding-inline")]).toEqual([20, 24]);
      const input = liveObject(doc, "input", "text");
      expect(input.count).toBe(2);
      expect(input.style["border-color"]).toBe("color.border");
      expect([valueOf(doc, input, "background"), valueOf(doc, input, "border-radius"), valueOf(doc, input, "height"), valueOf(doc, input, "font-size")]).toEqual(["#f9fafb", 6, 40, 15]);
      const badge = liveObject(doc, "badge", "pill");
      expect(badge.count).toBe(4);
      expect([valueOf(doc, badge, "background"), valueOf(doc, badge, "color"), valueOf(doc, badge, "border-radius"), valueOf(doc, badge, "height"), valueOf(doc, badge, "font-weight")])
        .toEqual(["#dcfce7", "#166534", 9999, 20, 500]);
      // A height no height or size token has stays a plain size: the
      // badge's is no spacing token, the divider's no border width.
      for (const o of [badge, liveObject(doc, "divider", "default")]) expect(o.style.height, o.kind).toMatchObject({ unit: "px" });
      const avatar = liveObject(doc, "avatar", "initials");
      expect(avatar.count).toBe(3);
      expect([valueOf(doc, avatar, "background"), valueOf(doc, avatar, "border-radius"), valueOf(doc, avatar, "height")]).toEqual(["#e0e7ff", "50%", 40]);
      expect([valueOf(doc, liveObject(doc, "heading", "h1"), "font-size"), valueOf(doc, liveObject(doc, "heading", "h2"), "font-size")]).toEqual([32, 24]);
      expect(liveObject(doc, "link", "default").style.color).toBe("color.primary");
      expect(valueOf(doc, liveObject(doc, "divider", "default"), "border-color")).toBe("#d1d5db");
      // Static candidates from the files sit next to them.
      expect(doc.objects.find((o) => o.source === "static" && o.kind === "button" && o.variant === "primary").sources[0]).toMatchObject({ file: "src/styles/app.css", name: ".btn-primary" });

      // Privacy: no text, attribute value or typed value anywhere.
      const text = fs.readFileSync(path.join(root, ".dftp", "tokens.json"), "utf8");
      const bodies = d.samples.map((s) => s.body).join("\n");
      for (const s of [text, bodies]) for (const needle of SECRETS) expect(s, needle).not.toContain(needle);
      for (const o of doc.objects) expect(Object.keys(o).sort()).toEqual(["count", "kind", "source", "sources", "style", "variant"]);
      for (const b of d.samples) {
        for (const o of JSON.parse(b.body).objects || []) expect(Object.keys(o).sort()).toEqual(["count", "kind", "style", "variant"]);
      }

      // The Styles tab: an Objects section with a preview of each bundle.
      const row = (ref) => d.page.locator(`#styles-body li[data-object="${ref}"]`);
      await expect(row("live.button.primary").locator(".tk-name")).toHaveText("Button · primary");
      await expect(row("live.button.primary").locator(".tk-value")).toHaveText("3 on page");
      await expect(row("live.button.primary").locator(".tk-src")).toHaveText("src/styles/app.css:62 .btn-primary");
      await expect(row("live.button.primary").locator(".tk-obj-props")).toContainText("background color.primary");
      expect(await row("live.button.primary").locator(".tk-obj").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(37, 99, 235)");
      expect(await row("live.badge.pill").locator(".tk-obj").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(220, 252, 231)");
      expect(await row("live.card.default").locator(".tk-obj").evaluate((el) => getComputedStyle(el).borderTopColor)).toBe("rgb(209, 213, 219)");
      await expect(row("static.button.secondary").locator(".tk-value")).toHaveText("in files");
      // The previews hold DFTP's own words, never the page's.
      await expect(d.page.locator("#styles-body [data-group=\"objects\"]")).not.toContainText("Save");
    } finally {
      await d.close();
    }
  });

  test("palette elements on a blank page copy the project's objects: their computed styles match the fixture's", async ({ browser }) => {
    const root = await project();
    const d = await openProject(browser, root, { blank: [null] });
    try {
      // The app page first: its sample records the objects.
      await d.page.locator("#page-select").selectOption("home");
      await waitLoaded(d.page);
      await expect.poll(() => liveObject(readTokens(root), "divider", "default"), { timeout: 10000 }).not.toBeNull();
      const fixture = {
        button: await looks(d.frame, ".btn-primary", COMPARED),
        card: await looks(d.frame, ".card", COMPARED),
        input: await looks(d.frame, "input[type=text]", COMPARED.filter((p) => p !== "line-height")),
        heading: await looks(d.frame, "h2", COMPARED),
        text: await looks(d.frame, "p", COMPARED),
        divider: await looks(d.frame, "hr", ["border-top-width", "border-top-style", "border-top-color", "background-color"]),
      };

      await d.page.locator("#page-select").selectOption("blank");
      await waitLoaded(d.page);
      await expect(d.page.locator("#palette-bar")).toBeVisible();
      const kinds = ["button", "card", "input", "heading", "text", "divider"];
      for (const kind of kinds) {
        const n = await saves(d.page);
        await d.page.locator(`[data-insert="${kind}"]`).click();
        await waitSaved(d.page, n);
      }
      const list = readDoc(root, "blank", "desktop").list.filter((c) => c.kind === "insert");
      const byKind = Object.fromEntries(list.map((c) => [c.element, c]));
      expect(byKind.button.object).toEqual({ kind: "button", variant: "primary", source: "live" });
      expect(byKind.heading.object).toEqual({ kind: "heading", variant: "h2", source: "live" });
      expect(byKind.input.object).toEqual({ kind: "input", variant: "text", source: "live" });
      // Token-named values stay token ids; raw ones come from the object's rule.
      expect(byKind.button.styles).toMatchObject({ background: "color.primary", color: "color.primary.foreground", "border-radius": "radius.md" });
      expect(byKind.card.styles).toMatchObject({ "border-color": "color.border", "box-shadow": "shadow.card" });

      const sel = (c) => `[data-dftp-ins="${c.id}"]`;
      for (const kind of kinds) {
        const want = fixture[kind];
        const props = Object.keys(want);
        const got = await looks(d.frame, sel(byKind[kind]), props.filter((p) => p !== "height"));
        expect(sameLook(want, got, kind === "divider" || kind === "card" || kind === "text" || kind === "heading" ? props.filter((p) => p !== "height") : props), kind).toEqual([]);
      }
      expect(await d.frame.evaluate((q) => document.querySelector(q).getAttribute("data-dftp-obj"), sel(byKind.button))).toBe("live.button.primary");

      // A reload draws them the same way again.
      await d.page.locator("#reload-page").click();
      await waitLoaded(d.page);
      const again = await looks(d.frame, sel(byKind.button), Object.keys(fixture.button).filter((p) => p !== "height"));
      expect(sameLook(fixture.button, again, Object.keys(fixture.button))).toEqual([]);

      // CHANGES.md says which object each copies and where the project defines it.
      const md = fs.readFileSync(path.join(root, ".dftp", "CHANGES.md"), "utf8");
      expect(md).toContain("object style: copies the project's button look \"primary\" (live), as the running app shows it (on 3 elements)");
      expect(md).toContain("found in: \".btn-primary\" in src/styles/app.css:62");
      expect(md).toContain("object style: copies the project's card look \"default\" (live)");
      expect(md).toMatch(/look: background color\.primary · color color\.primary\.foreground · border-color "#00000000" · border-width \S+ · border-style "solid" · border-radius radius\.md · box-shadow "none" · padding-block \S+ · padding-inline \S+ · height "42px"/);
      for (const needle of SECRETS) expect(md, needle).not.toContain(needle);
    } finally {
      await d.close();
    }
  });

  test("a huge page is capped: at most three looks per kind and variant, and the sample is still accepted", async ({ browser }) => {
    const script = [
      "const main = document.createElement(\"div\");",
      "main.style.cssText = \"display: flex; flex-wrap: wrap; gap: 4px;\";",
      "document.querySelector(\"main\").appendChild(main);",
      "for (let i = 0; i < 3000; i++) {",
      "  const b = document.createElement(\"button\");",
      "  b.className = \"btn\";",
      "  b.style.background = `rgb(${i % 250}, ${(i * 7) % 250}, 120)`;",
      "  b.style.color = \"#fff\";",
      "  b.textContent = \"B\";",
      "  main.appendChild(b);",
      "}",
      "",
    ].join("\n");
    const root = await project({ "many.js": script });
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8").replace("</head>", "  <script src=\"many.js\" defer></script>\n  </head>");
    fs.writeFileSync(path.join(root, "index.html"), html);
    const d = await openProject(browser, root);
    try {
      await expect.poll(() => d.samples.length, { timeout: 15000 }).toBeGreaterThan(0);
      const sent = JSON.parse(d.samples[0].body);
      expect(sent.elements).toBeLessThanOrEqual(1500);
      expect(sent.objects.length).toBeLessThanOrEqual(60);
      const per = new Map();
      for (const o of sent.objects) per.set(`${o.kind}.${o.variant}`, (per.get(`${o.kind}.${o.variant}`) || 0) + 1);
      expect(Math.max(...per.values())).toBeLessThanOrEqual(3);
      expect(per.get("button.primary")).toBe(3);
      await expect.poll(() => (readTokens(root)?.live || []).length, { timeout: 10000 }).toBe(1);
      const doc = readTokens(root);
      expect(doc.objects.length).toBeLessThanOrEqual(64);
      expect(doc.objects.filter((o) => o.source === "live" && o.kind === "button").length).toBeLessThanOrEqual(3);
    } finally {
      await d.close();
    }
  });
});
