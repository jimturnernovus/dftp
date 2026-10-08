// Makes the README screenshot of the demo in the designer (1440 x 900).
// Runs only when DFTP_SCREENSHOT names the output file, for example:
//   DFTP_SCREENSHOT=docs/screenshot.png npx playwright test test/e2e/screenshot.spec.mjs

import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { openDesigner, clickIn, saves, waitSaved, waitEditor, TOOL_DIR } from "./helpers.mjs";

const OUT = process.env.DFTP_SCREENSHOT;

test("README screenshot", async ({ browser }) => {
  test.skip(!OUT, "set DFTP_SCREENSHOT to make the screenshot");
  const d = await openDesigner(browser, { viewport: { width: 1440, height: 900 } });
  try {
    await clickIn(d.page, d.frame, "#new-btn", { fx: 0.3, fy: 0.12 });
    await d.page.keyboard.press("e");
    await waitEditor(() => d.frame);
    let n = await saves(d.page);
    await d.page.keyboard.type("Add a client");
    await d.page.keyboard.press("Enter");
    await waitSaved(d.page, n);
    await clickIn(d.page, d.frame, ".kpi:nth-child(3)", { fx: 0.5, fy: 0.07 });
    n = await saves(d.page);
    await d.page.keyboard.press("Shift+ArrowDown");
    await waitSaved(d.page, n);
    await d.page.mouse.move(5, 5);
    await d.page.waitForTimeout(300);
    const file = path.resolve(TOOL_DIR, OUT);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await d.page.screenshot({ path: file });
  } finally {
    await d.close();
  }
});
