// Blank pages together with the style scan and the live sample: the Styles
// tab works on a blank page, Rescan restyles the page's new elements in
// place (the token style sheet is loaded again, no reload) and the palette
// picks from the new scan, and nothing a blank page shows is ever counted
// as the project's own styles, whether the session has only blank pages or
// an app page next to them.

import { test } from "@playwright/test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { openDesigner, expect, tempRoot, removeRoot, TOOL_DIR, saves, waitSaved, readDoc, waitLoaded, postToLayer, syncLayer } from "./helpers.mjs";
import { startStaticSite } from "../fixtures/static-site.mjs";

const LONG_TEST_MS = 90000;
const PROJECTS = path.join(TOOL_DIR, "test", "fixtures", "projects");

async function copyOf(name) {
  const root = await tempRoot({ demo: false });
  await fsp.cp(path.join(PROJECTS, name), root, { recursive: true });
  return root;
}

const readTokens = (root) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, ".dftp", "tokens.json"), "utf8"));
  } catch {
    return null;
  }
};
const inserts = (root) => {
  const x = readDoc(root, "blank", "desktop");
  return x ? x.list.filter((c) => c.kind === "insert") : [];
};
const sel = (c) => `[data-dftp-ins="${c.id}"]`;
const row = (d, id) => d.page.locator(`#styles-body li[data-token="${id}"]`);
const cssOf = (d, c, prop) => d.frame.evaluate(([q, p]) => {
  const el = document.querySelector(q);
  return el ? getComputedStyle(el).getPropertyValue(p) : null;
}, [sel(c), prop]);

async function clickPalette(d, kind) {
  const n = await saves(d.page);
  await d.page.locator(`[data-insert="${kind}"]`).click();
  await waitSaved(d.page, n);
}

async function openStyles(d) {
  await d.page.locator("#side-tab-styles").click();
  await expect(d.page.locator("#styles-panel")).toBeVisible();
}

test.describe("blank pages and the style scan", () => {
  test.setTimeout(LONG_TEST_MS);

  test("the Styles tab works on a blank page; Rescan restyles its new elements in place, and the palette uses the new scan", async ({ browser }) => {
    const root = await copyOf("tailwind-v4");
    const d = await openDesigner(browser, { root, flags: { demo: false, blank: [null], debug: true } });
    try {
      await clickPalette(d, "button");
      await clickPalette(d, "card");
      let [button, card] = inserts(root);
      expect(button.styles.background).toBe("color.primary");
      // No border token yet: the card has no token for its border color.
      expect(card.styles["border-color"]).toBeUndefined();
      const before = await cssOf(d, button, "background-color");

      await openStyles(d);
      await expect(row(d, "color.primary").locator(".tk-role")).toHaveText("primary");
      await expect(row(d, "color.border")).toHaveCount(0);

      // The project changes its primary color and gains a border color.
      const file = path.join(root, "src", "index.css");
      const text = fs.readFileSync(file, "utf8");
      expect(text).toContain("--primary: oklch(0.205 0 0);");
      fs.writeFileSync(file, text.replace("--primary: oklch(0.205 0 0);", "--primary: #ff7a00;").replace("@theme {\n", "@theme {\n  --color-border: #d4d4d8;\n"));
      await d.frame.evaluate(() => {
        window.keepMark = 1;
      });
      await d.page.locator("#styles-rescan").click();
      await expect(row(d, "color.border").locator(".tk-role")).toHaveText("border");
      await expect(row(d, "color.primary").locator(".tk-value")).toHaveText("#ff7a00");
      // The button on the page shows the new value, without a reload, and
      // its record still names the token, not the value.
      await expect.poll(() => cssOf(d, button, "background-color")).toBe("rgb(255, 122, 0)");
      expect(before).not.toBe("rgb(255, 122, 0)");
      expect(await d.frame.evaluate(() => window.keepMark)).toBe(1);
      expect(await d.frame.evaluate(() => document.querySelectorAll("link[rel=\"stylesheet\"][href*=\"/__dftp/tokens.css\"]").length)).toBe(1);
      button = inserts(root).find((c) => c.id === button.id);
      expect(button.styles.background).toBe("color.primary");

      // The next card picks from the new scan: it has a border token.
      await clickPalette(d, "card");
      const second = inserts(root).find((c) => c.element === "card" && c.id !== card.id);
      expect(second.styles["border-color"]).toBe("color.border");
      expect(await cssOf(d, second, "border-top-color")).toBe("rgb(212, 212, 216)");
      card = inserts(root).find((c) => c.id === card.id);
      expect(card.styles["border-color"]).toBeUndefined();

      // Before shows no new elements; a rescan there still reaches the
      // page when After comes back.
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("--primary: #ff7a00;", "--primary: #00a86b;"));
      await d.page.locator("[data-set-view=\"before\"]").click();
      await d.page.locator("#styles-rescan").click();
      await expect(row(d, "color.primary").locator(".tk-value")).toHaveText("#00a86b");
      await d.page.locator("[data-set-view=\"after\"]").click();
      await expect.poll(() => cssOf(d, button, "background-color")).toBe("rgb(0, 168, 107)");
      expect(await d.frame.evaluate(() => window.keepMark)).toBe(1);

      // Nothing on the blank page is counted: not after it settled, not on
      // Rescan, not on a theme switch, not when asked directly.
      await d.page.locator("[data-set-theme=\"dark\"]").click();
      await postToLayer(d.page, d.app.frameOrigin, [{ type: "sample-styles" }]);
      await syncLayer(d.page);
      await d.page.waitForTimeout(1500);
      expect(d.samples).toEqual([]);
      expect(await d.frame.evaluate(() => window.__dftp.sample())).toEqual({ elements: 0, values: [] });
      expect(await d.frame.evaluate(() => document.querySelectorAll("[data-dftp-ins]").length)).toBe(3);
      const doc = readTokens(root);
      expect(doc.live || []).toEqual([]);
      expect(doc.tokens.some((t) => t.usage.seenLive)).toBe(false);
    } finally {
      await d.close();
      await removeRoot(root);
    }
  });

  test("next to an app page: the app page is counted, the blank page and its new elements never are", async ({ browser }) => {
    const root = await copyOf("css-vars-dark");
    const site = await startStaticSite(root);
    const d = await openDesigner(browser, { root, flags: { demo: false, target: site.origin, blank: [null] } });
    try {
      await expect(d.page.locator("#page-select option")).toHaveText(["Home", "Blank page"]);
      // --blank opens on the blank page: nothing is counted there.
      await expect(d.page.locator("#page-select")).toHaveValue("blank");
      await expect(d.page.locator("#palette-bar")).toBeVisible();
      await clickPalette(d, "heading");
      await d.page.waitForTimeout(1500);
      expect(d.samples).toHaveLength(0);
      await d.page.locator("#page-select").selectOption("home");
      await waitLoaded(d.page);
      await expect.poll(() => d.samples.length, { timeout: 10000 }).toBe(1);
      expect(JSON.parse(d.samples[0].body).page).toBe("home");
      // The title's line height is 1.2 in the CSS; the page shows it in px,
      // and the sample's ratio of it marks the unitless token as seen.
      const sent = JSON.parse(d.samples[0].body);
      expect(sent.values).toContainEqual(expect.objectContaining({ prop: "line-height", value: "1.2" }));
      await expect.poll(() => {
        const t = (readTokens(root)?.tokens || []).find((x) => x.type === "lineHeight" && x.value && x.value.unit === "" && x.value.value === 1.2);
        return t ? t.usage.seenLive : null;
      }, { timeout: 8000 }).toBe(true);
      expect((readTokens(root)?.tokens || []).filter((t) => t.type === "lineHeight" && t.sources.every((s) => s.adapter === "live"))).toEqual([]);

      await d.page.locator("#page-select").selectOption("blank");
      await waitLoaded(d.page);
      await expect(d.page.locator("#palette-bar")).toBeVisible();
      await clickPalette(d, "card");
      await clickPalette(d, "button");
      await openStyles(d);
      await d.page.locator("#styles-rescan").click();
      await expect(d.page.locator("#notices")).toContainText("Styles read again.");
      await d.page.waitForTimeout(1500);
      expect(d.samples).toHaveLength(1);

      await d.page.locator("#page-select").selectOption("home");
      await waitLoaded(d.page);
      // Rescan asked for the next sample of an app page to be sent.
      await expect.poll(() => d.samples.length, { timeout: 8000 }).toBe(2);
      expect(d.samples.map((s) => JSON.parse(s.body).page)).toEqual(["home", "home"]);
      const doc = readTokens(root);
      expect(doc.live.map((s) => s.page)).toEqual(["home"]);
      for (const t of doc.tokens) expect(t.sources.filter((s) => s.page === "blank"), t.id).toEqual([]);
    } finally {
      await d.close();
      await site.close();
      await removeRoot(root);
    }
  });
});
