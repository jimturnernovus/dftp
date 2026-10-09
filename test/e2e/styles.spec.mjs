// The Styles tab and the live style sample, against fixture projects served
// by a tiny static dev server through the proxy: the tab lists the scanned
// tokens with their sources, Rescan reads changed files, the page's
// computed styles are merged into .dftp/tokens.json (seen on the page, and
// frequent new values as tokens of their own), and nothing from a private
// field, or from inside an element marked private, is counted.

import { test } from "@playwright/test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { openDesigner, expect, tempRoot, removeRoot, TOOL_DIR, clickIn, listIds, setMode, waitLoaded } from "./helpers.mjs";
import { startStaticSite } from "../fixtures/static-site.mjs";

const PROJECTS = path.join(TOOL_DIR, "test", "fixtures", "projects");

// A throwaway project: a copy of a fixture project (or nothing), plus files.
async function project(name, files = {}) {
  const root = await tempRoot({ demo: false });
  if (name) await fsp.cp(path.join(PROJECTS, name), root, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fsp.writeFile(path.join(root, rel), text);
  }
  return root;
}

// The designer on a project, its pages served by a static dev server.
async function openProject(browser, root) {
  const site = await startStaticSite(root);
  let d;
  try {
    d = await openDesigner(browser, { root, flags: { demo: false, target: site.origin } });
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

const tokensFile = (root) => path.join(root, ".dftp", "tokens.json");
function readTokens(root) {
  try {
    return JSON.parse(fs.readFileSync(tokensFile(root), "utf8"));
  } catch {
    return null;
  }
}
const tokenOf = (root, id) => {
  const doc = readTokens(root);
  return doc ? doc.tokens.find((t) => t.id === id) || null : null;
};
const row = (d, id) => d.page.locator(`#styles-body li[data-token="${id}"]`);

async function openStyles(d) {
  await d.page.locator("#side-tab-styles").click();
  await expect(d.page.locator("#styles-panel")).toBeVisible();
  await expect(d.page.locator("#picked")).toBeHidden();
}

// Elements styled from a script, which the file scan does not read: what
// they show reaches tokens.json only through the live sample.
const NOTES_SCRIPT = `for (let i = 0; i < 4; i++) {
  const p = document.createElement("p");
  p.className = "note";
  p.textContent = "A note";
  p.style.color = "rgb(101, 67, 33)";
  document.querySelector("main").appendChild(p);
}
`;

test("the Styles tab lists the scanned tokens with name, value, role and source; Rescan reads changed files", async ({ browser }) => {
  const root = await project("css-vars-dark");
  const d = await openProject(browser, root);
  try {
    await openStyles(d);
    await expect(d.page.locator("#side-tab-styles")).toHaveAttribute("aria-selected", "true");
    await expect(d.page.locator("#styles-status")).toContainText("tokens");

    // Colors: value, role, dark mode and the file and line they come from.
    await expect(row(d, "color.brand.600").locator(".tk-value")).toHaveText("#2f5bd8");
    await expect(row(d, "color.brand.600").locator(".tk-src")).toHaveText("src/styles/tokens.css:3");
    await expect(row(d, "color.primary").locator(".tk-role")).toHaveText("primary");
    await expect(row(d, "color.primary").locator(".tk-src")).toHaveText("src/styles/tokens.css:5 (+1 more)");
    await expect(row(d, "color.primary").locator(".tk-mode")).toHaveText("dark #6b8cff");
    await expect(row(d, "color.text").locator(".tk-role")).toHaveText("text");
    expect(await row(d, "color.brand.600").locator(".tk-chip").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(47, 91, 216)");
    expect(await row(d, "color.primary").locator(".tk-chip-dark").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(107, 140, 255)");
    // Swatches with a role come first, in the role order.
    const colorIds = await d.page.locator("#styles-body [data-group=\"colors\"] li").evaluateAll((lis) => lis.map((li) => li.dataset.token));
    expect(colorIds.indexOf("color.primary")).toBeLessThan(colorIds.indexOf("color.brand.600"));
    expect(colorIds.indexOf("color.surface")).toBeLessThan(colorIds.indexOf("color.text"));

    // Type scale, largest first, drawn at its size.
    const sizes = await d.page.locator("#styles-body [data-group=\"type-scale\"] li").evaluateAll((lis) => lis.map((li) => li.dataset.token));
    expect(sizes.slice(0, 2)).toEqual(["font-size.auto.28px", "font-size.auto.22px"]);
    await expect(row(d, "font-size.auto.28px").locator(".tk-src")).toHaveText("src/styles/app.css:29");
    expect(await row(d, "font-size.auto.28px").locator(".tk-type").evaluate((el) => getComputedStyle(el).fontSize)).toBe("28px");
    await expect(row(d, "font.sans").locator(".tk-value")).toHaveText("\"Inter\", system-ui, sans-serif");

    // Spacing with the scale, radii and shadows.
    await expect(d.page.locator("#styles-body .tk-scale")).toHaveText("Scale: 4 · 8 · 16 px");
    await expect(row(d, "spacing.4").locator(".tk-value")).toHaveText("16px");
    await expect(row(d, "spacing.4").locator(".tk-src")).toHaveText("src/styles/tokens.css:14");
    expect(await row(d, "spacing.4").locator(".tk-bar").evaluate((el) => el.getBoundingClientRect().width)).toBe(16);
    await expect(row(d, "radius.default").locator(".tk-value")).toHaveText("0.5rem (8px)");
    expect(await row(d, "radius.default").locator(".tk-radius").evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("8px");
    await expect(row(d, "shadow.sm").locator(".tk-src")).toHaveText("src/styles/tokens.css:16");
    expect(await row(d, "shadow.sm").locator(".tk-shadow").evaluate((el) => getComputedStyle(el).boxShadow)).toContain("0px 1px 2px");
    await expect(d.page.locator("#styles-body")).toContainText("Breakpoints: md 768px · lg 1024px");

    // Rescan reads a file changed since.
    const file = path.join(root, "src", "styles", "tokens.css");
    const text = fs.readFileSync(file, "utf8");
    const line = text.split("\n").length + (text.endsWith("\n") ? 0 : 1) + 1;
    fs.writeFileSync(file, `${text}${text.endsWith("\n") ? "" : "\n"}:root {\n  --accent-500: #ff7a00;\n}\n`);
    await expect(row(d, "color.accent.500")).toHaveCount(0);
    await d.page.locator("#styles-rescan").click();
    await expect(row(d, "color.accent.500").locator(".tk-src")).toHaveText(`src/styles/tokens.css:${line}`);
    await expect(row(d, "color.accent.500").locator(".tk-role")).toHaveText("accent");
    expect(tokenOf(root, "color.accent.500").value).toEqual({ hex: "#ff7a00", alpha: 1 });

    // The tabs: arrow keys move between them and never reach the page.
    await clickIn(d.page, d.frame, ".title");
    await d.page.locator("#side-tab-styles").focus();
    await d.page.keyboard.press("ArrowLeft");
    await expect(d.page.locator("#side-tab-changes")).toBeFocused();
    await expect(d.page.locator("#styles-panel")).toBeHidden();
    await expect(d.page.locator("#picked")).toContainText("A sample heading");
    await d.page.keyboard.press("ArrowRight");
    await expect(d.page.locator("#styles-panel")).toBeVisible();
    await d.page.waitForTimeout(400);
    expect(await listIds(d.page)).toEqual([]);
    await d.page.locator("#styles-close").click();
    await expect(d.page.locator("#side-panel")).toBeHidden();
  } finally {
    await d.close();
  }
});

test("the live sample marks values the page shows as seen and adds frequent new ones; an unchanged reload sends none", async ({ browser }) => {
  const root = await project("css-vars-dark", { "notes.js": NOTES_SCRIPT });
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8").replace("</head>", "  <script src=\"notes.js\" defer></script>\n  </head>");
  fs.writeFileSync(path.join(root, "index.html"), html);
  const d = await openProject(browser, root);
  try {
    // The button's background is --color-primary (#2f5bd8).
    await expect.poll(() => tokenOf(root, "color.primary")?.usage.seenLive, { timeout: 10000 }).toBe(true);
    const primary = tokenOf(root, "color.primary");
    expect(primary.sources).toContainEqual({ adapter: "live", page: "home", device: "desktop" });
    expect(primary.usage.live).toBeGreaterThanOrEqual(1);
    expect(tokenOf(root, "color.brand.600").usage.seenLive).toBe(true);
    // Never on the page: not seen.
    expect(tokenOf(root, "color.danger").usage.seenLive).toBe(false);
    // Four notes in a color no file names: a token of its own.
    const auto = tokenOf(root, "color.auto.654321");
    expect(auto).not.toBeNull();
    expect(auto.usage).toMatchObject({ seenLive: true });
    expect(auto.usage.live).toBeGreaterThanOrEqual(4);
    expect(auto.sources).toEqual([{ adapter: "live", page: "home", device: "desktop" }]);
    const doc = readTokens(root);
    expect(doc.live).toHaveLength(1);
    expect(doc.live[0]).toMatchObject({ page: "home", device: "desktop", theme: "light" });
    expect(doc.live[0].elements).toBeGreaterThan(5);

    await openStyles(d);
    await expect(row(d, "color.primary").locator(".tk-live")).toHaveText("on page");
    await expect(row(d, "color.danger").locator(".tk-live")).toHaveCount(0);
    await expect(row(d, "color.auto.654321").locator(".tk-src")).toHaveText("seen on the page (home, desktop)");
    expect(d.samples).toHaveLength(1);
    const sent = JSON.parse(d.samples[0].body);
    expect(sent).toMatchObject({ page: "home", device: "desktop", theme: "light" });
    expect(sent.values).toContainEqual({ prop: "color", value: "rgb(101, 67, 33)", count: 4 });

    // The same page again: the same sample, so nothing is sent.
    await d.page.locator("#reload-page").click();
    await waitLoaded(d.page);
    await d.page.waitForTimeout(2500);
    expect(d.samples).toHaveLength(1);

    // Rescan asks the page for a new sample and sends it even when unchanged.
    await d.page.locator("#styles-rescan").click();
    await expect.poll(() => d.samples.length, { timeout: 8000 }).toBe(2);

    // Before shows the page without its edits: nothing is counted there.
    await d.page.locator("[data-set-view=\"before\"]").click();
    await expect(d.page.locator("#before-note")).toBeVisible();
    await d.page.locator("#styles-rescan").click();
    await d.page.waitForTimeout(1500);
    expect(d.samples).toHaveLength(2);
  } finally {
    await d.close();
  }
});

test("private fields, and everything inside an element marked private, are never counted", async ({ browser }) => {
  const SECRET = "SAMPLESECRET-4Q7Z";
  const TYPED = "TYPEDNAME-8P2X";
  const root = await project(null, {
    "index.html": [
      "<!doctype html>",
      "<html lang=\"en\">",
      "<head><meta charset=\"utf-8\"><title>Sign in</title><script src=\"site.js\" defer></script></head>",
      "<body>",
      "<main>",
      "  <h1>Sign in</h1>",
      "  <form>",
      "    <p><label>Name <input id=\"name\" type=\"text\"></label></p>",
      "    <p><label>Password <input id=\"pw\" type=\"password\"></label></p>",
      "    <p><label>Card <input id=\"cc\" type=\"text\" autocomplete=\"cc-number\"></label></p>",
      "    <div id=\"vault\" data-dftp-private><p>VAULTTEXT one</p><p>VAULTTEXT two</p><p>VAULTTEXT three</p><p>VAULTTEXT four</p></div>",
      "  </form>",
      "  <ul id=\"list\"><li>One</li><li>Two</li><li>Three</li><li>Four</li></ul>",
      "</main>",
      "</body>",
      "</html>",
      "",
    ].join("\n"),
    // Styles set from a script, so only the live sample could find them.
    "site.js": [
      "const mark = (el) => {",
      "  el.style.color = \"rgb(11, 22, 33)\";",
      "  el.style.backgroundColor = \"rgb(44, 55, 66)\";",
      "  el.style.borderRadius = \"13px\";",
      "  el.style.letterSpacing = \"3px\";",
      "  el.style.boxShadow = \"rgb(77, 88, 99) 0px 9px 9px 0px\";",
      "};",
      "for (const el of document.querySelectorAll(\"#pw, #cc, #vault, #vault p\")) mark(el);",
      "for (const el of document.querySelectorAll(\"#list li\")) el.style.color = \"rgb(101, 67, 33)\";",
      "",
    ].join("\n"),
  });
  const d = await openProject(browser, root);
  try {
    // Values typed into the fields, then a fresh sample.
    await setMode(d.page, "use");
    await d.frame.locator("#pw").fill(SECRET);
    await d.frame.locator("#cc").fill(SECRET);
    await d.frame.locator("#name").fill(TYPED);
    await setMode(d.page, "design");
    await openStyles(d);
    const n = d.samples.length;
    await d.page.locator("#styles-rescan").click();
    await expect.poll(() => d.samples.length, { timeout: 8000 }).toBeGreaterThan(n);
    await expect.poll(() => tokenOf(root, "color.auto.654321")?.usage.seenLive, { timeout: 8000 }).toBe(true);

    const text = fs.readFileSync(tokensFile(root), "utf8");
    const bodies = d.samples.map((s) => s.body).join("\n");
    for (const s of [text, bodies]) {
      for (const needle of [SECRET, TYPED, "VAULTTEXT", "Sign in", "rgb(11, 22, 33)", "rgb(44, 55, 66)", "rgb(77, 88, 99)", "#0b1621", "#2c3742", "#4d5863", "13px"]) {
        expect(s, needle).not.toContain(needle);
      }
    }
    const doc = readTokens(root);
    expect(doc.tokens.some((t) => t.type === "letterSpacing")).toBe(false);
    expect(doc.tokens.some((t) => t.type === "shadow")).toBe(false);
    // The plain list was counted.
    for (const b of d.samples) {
      const sent = JSON.parse(b.body);
      expect(sent.values).toContainEqual({ prop: "color", value: "rgb(101, 67, 33)", count: 4 });
      expect(sent.values.every((v) => !/[<>]/.test(v.value))).toBe(true);
    }
  } finally {
    await d.close();
  }
});

test("switching Light / Dark counts the page again under the other theme", async ({ browser }) => {
  const root = await project("css-vars-dark", {
    "dftp.config.json": `${JSON.stringify({ theme: { selector: "html", darkClass: "dark" } })}\n`,
  });
  const d = await openProject(browser, root);
  try {
    await expect.poll(() => d.samples.length, { timeout: 10000 }).toBe(1);
    expect(JSON.parse(d.samples[0].body).theme).toBe("light");
    await expect(d.page.locator("#theme-switch")).toBeVisible();
    await d.page.locator("[data-set-theme=\"dark\"]").click();
    await expect.poll(() => d.samples.length, { timeout: 8000 }).toBe(2);
    const dark = JSON.parse(d.samples[1].body);
    expect(dark).toMatchObject({ page: "home", device: "desktop", theme: "dark" });
    // The page's dark surface (--surface in .dark) is what the body shows now.
    expect(dark.values).toContainEqual(expect.objectContaining({ prop: "background-color", value: "rgb(11, 16, 32)" }));
    await expect.poll(() => (readTokens(root)?.live || []).map((s) => s.theme).sort().join(","), { timeout: 8000 }).toBe("dark,light");
  } finally {
    await d.close();
  }
});
