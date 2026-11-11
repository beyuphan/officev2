export async function run({ page, answer, shot, goto, click, text, timed, part, note, W, wp, pyRun }) {
  await part("pages", "open the Pages screen", async () => {
    await goto("pages");
    await shot("pages-1-empty");
    note("pages", "empty screen", "info", (await text()).split("\n").filter(Boolean).slice(0, 5).join(" | "));
  });

  await part("pages", "add two PDFs", async () => {
    await answer([W("report.pdf"), W("appendix.pdf")]);
    const ms = await timed(async () => {
      await click("button:has-text('Add PDFs…')");
      await page.waitForSelector(".pg-tile >> nth=4", { timeout: 20000 });
    });
    await page.waitForTimeout(1200);
    await shot("pages-2-loaded");
    note("pages", "5 pages from 2 files appear", ms < 4000 ? "OK" : "SLOW", `${ms} ms; ${(await page.locator(".pg-tile").count())} tiles; summary: ${(await text(".pg-save")).replace(/\n/g, " ")}`);
  });

  await part("pages", "rotate page 2, delete page 4, drag the last page first", async () => {
    await click(page.locator(".pg-tile").nth(1));
    await click("button:has-text('Rotate')");
    await click(page.locator(".pg-tile").nth(3));
    await click("button:has-text('Remove')");
    await page.waitForTimeout(300);
    const last = page.locator(".pg-tile").nth(3);
    const first = page.locator(".pg-tile").nth(0);
    const a = await last.boundingBox();
    const b = await first.boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2, { steps: 6 });
    await page.mouse.down();
    await page.mouse.move(b.x + 10, b.y + b.height / 2, { steps: 14 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    await shot("pages-3-edited");
    note("pages", "rotate / remove / drag", "info", `now ${await page.locator(".pg-tile").count()} tiles; ${(await text(".pg-save")).replace(/\n/g, " ")}`);
  });

  await part("pages", "cut into files", async () => {
    await click(page.locator(".pg-tile .pg-cut").nth(1));
    await page.waitForTimeout(300);
    await shot("pages-4-cut");
    note("pages", "one scissors click", "info", (await text(".pg-save")).replace(/\n/g, " "));
  });

  await part("pages", "save the result", async () => {
    const dir = W("pages-out");
    (await import("node:fs")).mkdirSync(dir, { recursive: true });
    await answer(dir);
    const ms = await timed(async () => {
      await click(page.locator(".pg-save button.primary"));
      await page.waitForSelector("text=file(s) written", { timeout: 30000 });
    });
    await shot("pages-5-saved");
    note("pages", "saving 2 files", ms < 4000 ? "OK" : "SLOW", `${ms} ms; ${(await text(".msg")).replace(/\n/g, " ").slice(0, 120)}`);
  });
}
