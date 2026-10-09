// Object styles on pages built the way common kits and frameworks build
// them, through the live sample and on blank pages:
//   - a component kit's settings page (oklch() colors, switches, check
//     boxes, select triggers and tabs drawn on <button>, fully round
//     buttons, layered shadows, step numbers and icons (an icon font, an
//     SVG) in circles, a light and a dark theme): only real buttons are
//     buttons, initials avatars the only avatars, a light tinted fill
//     is a secondary one, the card keeps its shadow and its sections'
//     padding and is named by the kit's card color, and copies stay
//     readable in the dark theme; the same page with hex colors gives the
//     same looks;
//   - a framework-style landing page (cards padded by their body, an alert,
//     a status message, a rounded navigation bar, full-width accordion
//     headers, a rule drawn faint with opacity);
//   - a page whose heading and card change with the screen size: each
//     screen size of a blank page copies its own look;
//   - a copied button whose label wraps grows to hold it.

import { test } from "@playwright/test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  openDesigner, expect, tempRoot, removeRoot, TOOL_DIR, saves, waitSaved, readDoc, waitLoaded, setDevice, clickIn, waitEditor,
} from "./helpers.mjs";
import { startStaticSite } from "../fixtures/static-site.mjs";
import { parseColor } from "../../client/core/css-values.js";

const LONG_TEST_MS = 120000;
const PROJECTS = path.join(TOOL_DIR, "test", "fixtures", "projects");

// A copy of a fixture project, served by a static dev server, in the
// designer; edit(root) may change the copy first.
async function openProject(browser, name, flags = {}, edit = null) {
  const root = await tempRoot({ demo: false });
  await fsp.cp(path.join(PROJECTS, name), root, { recursive: true });
  if (edit) await edit(root);
  const site = await startStaticSite(root);
  let d;
  try {
    d = await openDesigner(browser, { root, flags: { demo: false, target: site.origin, blank: [null], ...flags } });
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
const liveObjects = (doc, kind) => (doc && doc.objects ? doc.objects.filter((o) => o.source === "live" && o.kind === kind) : []);
const liveObject = (doc, kind, variant) => liveObjects(doc, kind).find((o) => o.variant === variant) || null;
const lastSample = (d) => JSON.parse(d.samples[d.samples.length - 1].body);

// A bundle value: a token id read through the token, then px or a color.
function valueOf(doc, o, prop) {
  let v = o.style[prop];
  if (typeof v === "string") v = doc.tokens.find((t) => t.id === v).value;
  if (v && typeof v.hex === "string") return v.alpha < 1 ? `${v.hex}/${v.alpha}` : v.hex;
  if (v && Number.isFinite(v.px)) return v.px;
  return v;
}

const inserts = (d, device = "desktop") => {
  const x = readDoc(d.root, "blank", device);
  return x ? x.list.filter((c) => c.kind === "insert") : [];
};
const sel = (c) => `[data-dftp-ins="${c.id}"]`;

async function addFromPalette(d, kind, device = "desktop") {
  const n = await saves(d.page);
  await d.page.locator(`[data-insert="${kind}"]`).click();
  await waitSaved(d.page, n);
  return inserts(d, device).filter((c) => c.element === kind).pop();
}

const computed = (frame, selector, props) => frame.evaluate(([q, list]) => {
  const el = document.querySelector(q);
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const out = { width: r.width, height: r.height };
  for (const p of list) out[p] = cs.getPropertyValue(p);
  return out;
}, [selector, props]);

// The contrast ratio of an element's text on its fill (the fill laid over
// the page), with colors read back through a canvas so any syntax works.
const contrast = (frame, selector) => frame.evaluate((q) => {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const rgb = (c, over) => {
    ctx.clearRect(0, 0, 1, 1);
    if (over) {
      ctx.fillStyle = over;
      ctx.fillRect(0, 0, 1, 1);
    }
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
  };
  const lum = (c) => {
    const f = (v) => {
      const x = v / 255;
      return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const el = document.querySelector(q);
  const page = getComputedStyle(document.body).backgroundColor;
  const fill = rgb(getComputedStyle(el).backgroundColor, page);
  const ink = rgb(getComputedStyle(el).color, `rgb(${fill.join(", ")})`);
  const [a, b] = [lum(fill), lum(ink)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}, selector);

test.describe("object styles on kit and framework pages", () => {
  test.setTimeout(LONG_TEST_MS);

  test("a component kit's page: widgets drawn on buttons, oklch colors, round pills, layered shadows and icon circles are told apart; copies stay readable in dark", async ({ browser }) => {
    const d = await openProject(browser, "objects-kit");
    try {
      await d.page.locator("#page-select").selectOption("home");
      await waitLoaded(d.page);
      await expect.poll(() => liveObject(readTokens(d.root), "card", "default"), { timeout: 10000 }).not.toBeNull();
      const sent = lastSample(d);
      // Switches, check boxes, select triggers and tabs are not buttons.
      const buttons = sent.objects.filter((o) => o.kind === "button");
      for (const b of buttons) expect(parseFloat(b.style.height), JSON.stringify(b.style)).toBeGreaterThanOrEqual(24);
      const primary = buttons.find((b) => b.variant === "primary");
      expect(primary.count).toBe(2);
      // A fully round corner (calc(infinity * 1px)) arrives as a pill.
      expect(primary.style).toMatchObject({ height: "36px", "padding-block": "8px", "padding-inline": "16px", "border-radius": "9999px" });
      // A light tinted fill written in oklch() is a secondary button.
      const secondary = buttons.find((b) => b.variant === "secondary");
      expect(secondary.count).toBe(2);
      // Initials only (one of them wrapped in a span): no step numbers,
      // counters, or icons in circles, drawn by an icon font at any depth
      // or by an SVG with a title.
      expect(sent.objects.filter((o) => o.kind === "avatar")).toEqual([expect.objectContaining({ variant: "initials", count: 3 })]);
      // The card keeps its visible shadow layers and its sections' padding.
      const card = sent.objects.find((o) => o.kind === "card");
      expect(card.style["box-shadow"]).toBe("rgba(0, 0, 0, 0.1) 0px 1px 3px 0px, rgba(0, 0, 0, 0.1) 0px 1px 2px -1px");
      expect(card.style).toMatchObject({ "padding-block": "24px", "padding-inline": "24px" });

      await expect.poll(() => (readTokens(d.root)?.live || []).length, { timeout: 8000 }).toBe(1);
      const doc = readTokens(d.root);
      expect(valueOf(doc, liveObject(doc, "button", "primary"), "border-radius")).toBe(9999);
      expect(valueOf(doc, liveObject(doc, "button", "secondary"), "background")).toBe("#eef2ff");
      // The card's fill is the kit's card color (white like the page in the
      // light theme, its own color in the dark one).
      expect(liveObject(doc, "card", "default").style.background).toBe("color.card");
      expect(liveObject(doc, "input", "text").style["border-color"]).toBe("color.input");

      await d.page.locator("#page-select").selectOption("blank");
      await waitLoaded(d.page);
      await expect(d.page.locator("#palette-bar")).toBeVisible();
      const button = await addFromPalette(d, "button");
      const cardIns = await addFromPalette(d, "card");
      const input = await addFromPalette(d, "input");
      expect(button.object).toEqual({ kind: "button", variant: "primary", source: "live" });
      const b = await computed(d.frame, sel(button), ["border-top-left-radius", "padding-top", "padding-left"]);
      expect(parseFloat(b["border-top-left-radius"])).toBeGreaterThanOrEqual(9999);
      expect([Math.round(b.height), b["padding-top"], b["padding-left"]]).toEqual([36, "8px", "16px"]);
      const c = await computed(d.frame, sel(cardIns), ["box-shadow", "padding-top", "padding-left"]);
      expect(c["box-shadow"]).toContain("0px 1px 3px 0px");
      expect([c["padding-top"], c["padding-left"]]).toEqual(["24px", "24px"]);

      // Dark: the copied text box's light-only fill gives way to the dark
      // surface under its (dark-themed) text, and the card is not the page.
      const lightContrast = await contrast(d.frame, sel(input));
      expect(lightContrast).toBeGreaterThan(4.5);
      await d.page.locator("[data-set-theme=\"dark\"]").click();
      await expect.poll(() => d.frame.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe("rgb(255, 255, 255)");
      await expect.poll(() => contrast(d.frame, sel(input))).toBeGreaterThan(4.5);
      const fills = await d.frame.evaluate((q) => [getComputedStyle(document.querySelector(q)).backgroundColor, getComputedStyle(document.body).backgroundColor], sel(cardIns));
      expect(fills[0]).not.toBe(fills[1]);
    } finally {
      await d.close();
    }
  });

  test("the same page with its colors written in oklch() and in hex gives the same object styles", async ({ browser }) => {
    const looks = async (edit) => {
      const d = await openProject(browser, "objects-kit", {}, edit);
      try {
        await d.page.locator("#page-select").selectOption("home");
        await waitLoaded(d.page);
        await expect.poll(() => d.samples.length, { timeout: 10000 }).toBeGreaterThan(0);
        // Kind, variant, count and fill (in hex, whatever syntax the page
        // computes it in) of every look the page sent.
        const fill = (o) => (o.style.background && parseColor(o.style.background) ? parseColor(o.style.background).hex : "-");
        return lastSample(d).objects.map((o) => `${o.kind}.${o.variant} ${o.count} ${fill(o)}`).sort();
      } finally {
        await d.close();
      }
    };
    const hex = async (root) => {
      const file = path.join(root, "src", "styles", "theme.css");
      const text = await fsp.readFile(file, "utf8");
      await fsp.writeFile(file, text.replace(/oklch\([^)]*\)/g, (c) => (parseColor(c) ? parseColor(c).hex : c)));
    };
    const asOklch = await looks(null);
    expect(asOklch).toContain("button.secondary 2 #eef2ff");
    expect(await looks(hex)).toEqual(asOklch);
  });

  test("a framework-style page: cards padded by their body are cards; alerts, status messages, navigation bars and accordion headers are not; a faint rule stays faint", async ({ browser }) => {
    const d = await openProject(browser, "objects-panels");
    try {
      await d.page.locator("#page-select").selectOption("home");
      await waitLoaded(d.page);
      await expect.poll(() => liveObject(readTokens(d.root), "divider", "default"), { timeout: 10000 }).not.toBeNull();
      const sent = lastSample(d);
      const cards = sent.objects.filter((o) => o.kind === "card");
      // The three pricing cards and the call-to-action panel; nothing round
      // like the navigation bar, and no alert or status message.
      expect(cards.map((o) => o.count).sort()).toEqual([1, 3]);
      const card = cards.find((o) => o.count === 3);
      expect(card.style).toMatchObject({ "padding-block": "16px", "padding-inline": "16px", "border-radius": "8px", background: "rgb(255, 255, 255)" });
      for (const o of cards) expect(o.style["border-radius"]).not.toBe("9999px");
      expect(cards.some((o) => o.style.background === "rgb(207, 244, 252)")).toBe(false);
      // Full-width accordion headers are no buttons; a full-width button
      // with its label in the middle is one.
      const primary = sent.objects.find((o) => o.kind === "button" && o.variant === "primary");
      expect(primary).toMatchObject({ count: 3 });
      expect(primary.style.background).toBe("rgb(13, 110, 253)");
      // The rule's opacity is in its color.
      expect(sent.objects.find((o) => o.kind === "divider").style["border-color"]).toBe("rgba(33, 37, 41, 0.25)");
      await expect.poll(() => (readTokens(d.root)?.live || []).length, { timeout: 8000 }).toBe(1);
      expect(valueOf(readTokens(d.root), liveObject(readTokens(d.root), "divider", "default"), "border-color")).toBe("#212529/0.25");

      await d.page.locator("#page-select").selectOption("blank");
      await waitLoaded(d.page);
      const cardIns = await addFromPalette(d, "card");
      const divider = await addFromPalette(d, "divider");
      const c = await computed(d.frame, sel(cardIns), ["padding-top", "padding-left", "border-top-left-radius", "box-shadow"]);
      expect([c["padding-top"], c["padding-left"], c["border-top-left-radius"]]).toEqual(["16px", "16px", "8px"]);
      expect(c["box-shadow"]).toContain("0px 2px 4px 0px");
      const line = await computed(d.frame, sel(divider), ["border-top-color", "opacity"]);
      expect([line["border-top-color"], line.opacity]).toEqual(["rgba(33, 37, 41, 0.25)", "1"]);
    } finally {
      await d.close();
    }
  });

  test("each screen size of a blank page copies the look the app shows at that size", async ({ browser }) => {
    const d = await openProject(browser, "css-vars-dark");
    try {
      await d.page.locator("#page-select").selectOption("home");
      await waitLoaded(d.page);
      await expect.poll(() => liveObject(readTokens(d.root), "heading", "h1"), { timeout: 10000 }).not.toBeNull();
      await setDevice(d.page, "phone");
      await expect.poll(() => (readTokens(d.root)?.live || []).length, { timeout: 10000 }).toBe(2);
      await expect.poll(() => liveObject(readTokens(d.root), "heading", "h1")?.screens?.phone || null, { timeout: 8000 }).not.toBeNull();
      const doc = readTokens(d.root);
      const h1 = liveObject(doc, "heading", "h1");
      expect([h1.count, valueOf(doc, h1, "font-size")]).toEqual([1, 28]);
      expect(valueOf(doc, { style: h1.screens.phone }, "font-size")).toBe(22);
      const card = liveObject(doc, "card", "default");
      expect(valueOf(doc, card, "padding-block")).toBe(24);
      expect(valueOf(doc, { style: card.screens.phone }, "padding-block")).toBe(16);

      await setDevice(d.page, "desktop");
      await d.page.locator("#page-select").selectOption("blank");
      await waitLoaded(d.page);
      const heading = await addFromPalette(d, "heading");
      const cardIns = await addFromPalette(d, "card");
      const look = async () => [
        (await computed(d.frame, sel(heading), ["font-size"]))["font-size"],
        (await computed(d.frame, sel(cardIns), ["padding-top"]))["padding-top"],
      ];
      expect(await look()).toEqual(["28px", "24px"]);
      await setDevice(d.page, "phone");
      await expect.poll(look).toEqual(["22px", "16px"]);
    } finally {
      await d.close();
    }
  });

  test("a copied button whose label wraps grows to hold it on a phone", async ({ browser }) => {
    const d = await openProject(browser, "objects");
    try {
      await d.page.locator("#page-select").selectOption("home");
      await waitLoaded(d.page);
      await expect.poll(() => liveObject(readTokens(d.root), "button", "primary"), { timeout: 10000 }).not.toBeNull();
      await d.page.locator("#page-select").selectOption("blank");
      await waitLoaded(d.page);
      await setDevice(d.page, "phone");
      const button = await addFromPalette(d, "button", "phone");
      expect(button.object).toEqual({ kind: "button", variant: "primary", source: "live" });
      await clickIn(d.page, d.frame, sel(button), { fx: 0.5, fy: 0.5 });
      await d.page.keyboard.press("e");
      await waitEditor(() => d.frame);
      const n = await saves(d.page);
      await d.page.keyboard.press("ControlOrMeta+a");
      await d.page.keyboard.type("Save your changes and send the invitation to every member of this workspace today, then go back to the overview page");
      await d.page.keyboard.press("Enter");
      await waitSaved(d.page, n);
      const box = await d.frame.evaluate((q) => {
        const el = document.querySelector(q);
        const r = el.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(el);
        const t = range.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, textTop: t.top, textBottom: t.bottom, height: r.height, pad: getComputedStyle(el).paddingTop };
      }, sel(button));
      expect(box.height).toBeGreaterThan(42);
      expect(box.textTop).toBeGreaterThanOrEqual(box.top + 9);
      expect(box.textBottom).toBeLessThanOrEqual(box.bottom - 9);
      expect(box.pad).toBe("10px");
    } finally {
      await d.close();
    }
  });
});
