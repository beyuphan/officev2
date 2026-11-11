export async function run({ page, answer, shot, goto, click, text, timed, part, note, W, wp, pyRun, shots }) {
  await part("photo", "empty editor", async () => {
    await goto("photo");
    await shot("photo-1-empty");
    note("photo", "empty editor", "info", (await text()).split("\n").filter(Boolean).slice(0, 4).join(" | "));
  });

  await part("photo", "open a photo", async () => {
    await answer(W("holiday.jpg"));
    const ms = await timed(async () => {
      await click("button:has-text('Open a photo')").catch(() => click("button.primary"));
      await page.waitForSelector(".photo canvas, .photo img", { timeout: 20000 });
    });
    await page.waitForTimeout(1200);
    await shot("photo-2-opened");
    note("photo", "opening a 1600x1067 photo", ms < 3000 ? "OK" : "SLOW", `${ms} ms; left menu ${(await page.locator("nav.rail").isVisible()) ? "visible" : "folded"}`);
    note("photo", "right panel sections", "info", (await page.locator("button.acchead").allInnerTexts()).join(" | "));
  });

  await part("photo", "Light and color: move a slider", async () => {
    const open = await page.locator("button.acchead:has-text('Light')").getAttribute("aria-expanded");
    if (open !== "true") await click("button.acchead:has-text('Light')");
    await page.waitForTimeout(500);
    await shot("photo-3-light-panel");
    note("photo", "Light and color open by default", open === "true" ? "OK" : "INFO", `aria-expanded was ${open}`);
    const sliders = page.locator("input[type='range']");
    const n = await sliders.count();
    note("photo", "light and color panel", "info", `${n} sliders; ${(await text(".side, aside")).split("\n").filter(Boolean).slice(0, 12).join(" | ")}`);
    if (n) {
      const b = await sliders.first().boundingBox();
      await page.mouse.move(b.x + b.width * 0.5, b.y + b.height / 2, { steps: 5 });
      await page.mouse.down();
      await page.mouse.move(b.x + b.width * 0.85, b.y + b.height / 2, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(1500);
      await shot("photo-4-brighter");
    }
  });

  await part("photo", "crop", async () => {
    await click("button.acchead:has-text('Crop')");
    await page.waitForTimeout(800);
    await shot("photo-5-crop");
    note("photo", "crop panel", "info", (await text(".side, aside")).split("\n").filter(Boolean).slice(0, 14).join(" | "));
  });

  await part("photo", "add text on the photo", async () => {
    const rail = await page.locator(".toolrail").innerText().catch(() => "");
    note("photo", "tool rail", "info", rail.split("\n").filter(Boolean).join(" | "));
    await click(".toolrail button[aria-label='Text']");
    const stage = await page.locator(".photostage").first().boundingBox();
    await page.mouse.move(stage.x + stage.width * 0.3, stage.y + stage.height * 0.3, { steps: 6 });
    await page.mouse.click(stage.x + stage.width * 0.3, stage.y + stage.height * 0.3);
    await page.keyboard.type("Summer 2026");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
    await shot("photo-6-text");
  });

  await part("photo", "filters", async () => {
    await click("button.acchead:has-text('Filters')");
    await page.waitForTimeout(2000);
    await shot("photo-7-filters");
  });

  await part("photo", "save", async () => {
    await click("button.acchead:has-text('Size and save')").catch(() => click("button:has-text('Save a copy')"));
    await page.waitForTimeout(600);
    await shot("photo-8-save-panel");
    note("photo", "save panel", "info", (await text(".side, aside")).split("\n").filter(Boolean).slice(0, 14).join(" | "));
    await answer(W("holiday-edited.jpg"));
    const btn = page.locator("button:has-text('Save a copy…'), button:has-text('Save…'), button.primary:has-text('Save')").last();
    const ms = await timed(async () => {
      await click(btn);
      await page.waitForSelector("text=px written to", { timeout: 30000 });
    });
    await shot("photo-9-saved");
    note("photo", "saving", ms < 5000 ? "OK" : "SLOW", `${ms} ms`);
    const out = shots.split("\\").join("/");
    await pyRun(`
from PIL import Image
im = Image.open(r"${wp("holiday-edited.jpg")}"); im.thumbnail((900, 900)); im.save(r"${out}/saved-photo.png")
print(Image.open(r"${wp("holiday-edited.jpg")}").size)
`);
  });
}
