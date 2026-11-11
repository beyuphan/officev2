export async function run({ page, goto, shot, click, text, note, part }) {
  await part("home", "first screen", async () => {
    await goto("home");
    await shot("home-1");
    const cards = await page.locator(".task").allInnerTexts();
    note("home", "start screen task cards", "info", cards.map((c) => c.split("\n")[0]).join(" | "));
    const rail = (await page.locator("nav.rail").innerText()).split("\n").filter(Boolean);
    note("home", "left menu", "info", rail.join(" | "));
  });
  const titles = (await page.locator(".task b").allInnerTexts().catch(() => [])) ?? [];
  for (const t of titles) {
    await part("home", `card "${t}"`, async () => {
      await goto("home");
      await click(`.task:has-text("${t}")`);
      await page.waitForTimeout(600);
      const h = await page.locator("h1").first().innerText().catch(() => "(no heading)");
      note("home", `card "${t}" opens`, "info", h);
    });
  }
}
