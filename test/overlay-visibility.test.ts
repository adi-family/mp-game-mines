// Regression test for the "New game" overlay always showing.
//
// `.mines__overlay` sets `display: flex` with the same specificity as the UA's own
// `[hidden] { display: none }` rule, and an author stylesheet always outranks the UA one — so
// without an explicit `.mines__overlay[hidden] { display: none }` override, the overlay (and its
// "New game" button) renders even while the element's `hidden` attribute is set. happy-dom (and
// bun's own DOM shims) never apply CSS cascade at all, so no unit test against the DOM alone can
// catch this; it needs a real browser's computed style.
//
// This spins up the actual frontend server and drives it with Playwright + headless Chromium.
// Neither is a dependency of the bundle itself (see frontend/index.ts: no build step, no
// package.json needed to *run* the dashboard) — this test skips loudly, rather than failing,
// wherever that optional tooling isn't installed: `bun add -d playwright && bunx playwright
// install chromium` to make it actually run.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

async function loadPlaywright(): Promise<typeof import("playwright") | null> {
  try {
    // @ts-ignore — optional dependency, resolved only if a developer installed it.
    return await import("playwright");
  } catch {
    return null;
  }
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`frontend never answered ${url} within ${timeoutMs}ms`);
}

const playwright = await loadPlaywright();
const port = 41000 + Math.floor(Math.random() * 4000);
let proc: ChildProcess | null = null;

describe.skipIf(!playwright)("overlay visibility (display:flex outranking [hidden])", () => {
  beforeAll(async () => {
    proc = spawn("bun", ["run", "frontend/index.ts"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: "ignore",
    });
    await waitForServer(`http://127.0.0.1:${port}/`, 8000);
  });

  afterAll(() => {
    proc?.kill();
  });

  test("hidden is actually invisible; un-hidden is actually visible", async () => {
    const browser = await playwright!.chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
      // `state: "attached"` — the default ("visible") would time out here on the correct
      // behaviour: the overlay is hidden until a win or game over.
      await page.waitForSelector(".mines__overlay", { state: "attached" });

      expect(
        await page.$eval(".mines__overlay", (el) => getComputedStyle(el).display),
      ).toBe("none");

      await page.$eval(".mines__overlay", (el) => el.removeAttribute("hidden"));
      expect(
        await page.$eval(".mines__overlay", (el) => getComputedStyle(el).display),
      ).toBe("flex");

      await page.$eval(".mines__overlay", (el) => el.setAttribute("hidden", ""));
      expect(
        await page.$eval(".mines__overlay", (el) => getComputedStyle(el).display),
      ).toBe("none");
    } finally {
      await browser.close();
    }
  }, 20000);
});

if (!playwright) {
  console.warn(
    "overlay-visibility.test.ts: playwright not installed — skipped. " +
      "`bun add -d playwright && bunx playwright install chromium` to run the real check.",
  );
}
