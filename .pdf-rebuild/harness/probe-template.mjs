// Sonde temporaire (non commitée) : ouvre chaque PDF du corpus dans le module PDF
// et mesure ouverture / premier rendu / miniatures / erreurs console.
import { chromium } from "@playwright/test";
import { readdirSync } from "node:fs";
import path from "node:path";

const [, , BASE, CORPUS, ONLY] = process.argv;
const files = readdirSync(CORPUS).filter((f) => f.endsWith(".pdf") && (!ONLY || f.includes(ONLY)));
const browser = await chromium.launch({ channel: "msedge", headless: true });

const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT " + label)), ms))]);

for (const f of files) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const log = [];
  page.on("console", (m) => {
    if (["error", "warning"].includes(m.type())) log.push(`${m.type()}: ${m.text().replace(/data:image[^']*/, "data:…").slice(0, 200)}`);
  });
  page.on("pageerror", (e) => log.push(`pageerror: ${e.message.slice(0, 200)}`));
  const res = { f };
  try {
    await page.goto(BASE);
    await page.getByRole("button", { name: /^PDF/ }).click();
    const t0 = Date.now();
    await page.setInputFiles('input[type="file"][accept*="pdf"]', path.join(CORPUS, f));
    if (f.includes("pwd-test")) {
      const pw = page.locator('input[type="password"]').first();
      await pw.waitFor({ timeout: 8000 });
      await pw.fill("test");
      await pw.press("Enter");
    }
    await page.locator(".pdfx-canvas canvas").first().waitFor({ timeout: 30000 });
    res.tOpen = Date.now() - t0;
    res.tPaint = -1;
    for (let i = 0; i < 40; i++) {
      const ok = await withTimeout(
        page.evaluate(() => {
          const c = document.querySelector(".pdfx-canvas canvas");
          if (!c || c.width < 10) return false;
          const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
          for (let i = 0; i < d.length; i += 4000) if (d[i] < 200) return true;
          return false;
        }),
        5000,
        "paint-check",
      );
      if (ok) {
        res.tPaint = Date.now() - t0;
        break;
      }
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(1000);
    Object.assign(
      res,
      await withTimeout(
        page.evaluate(() => {
          const canv = [...document.querySelectorAll(".pdfx-canvas canvas")];
          const imgs = [...document.querySelectorAll(".pdfx img")];
          return {
            canvases: canv.length,
            painted: canv.filter((c) => c.width > 10).length,
            imgs: imgs.length,
            brokenImgs: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,
            dom: document.querySelectorAll("*").length,
            mem: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null,
            status: document.querySelector(".pdfx-status")?.textContent?.slice(0, 80),
          };
        }),
        10000,
        "stats",
      ),
    );
  } catch (e) {
    res.error = String(e.message || e).slice(0, 160);
  }
  console.log(JSON.stringify(res));
  for (const l of [...new Set(log)].slice(0, 8)) console.log("    " + l);
  await ctx.close().catch(() => {});
}
await browser.close();
console.log("PROBE DONE");
