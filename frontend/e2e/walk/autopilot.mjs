import fs from "node:fs";
import path from "node:path";

export async function run({ page, shot, goto, click, text, part, note, fakeHome }) {
  await part("autopilot", "first look", async () => {
    await goto("autopilot");
    await page.waitForSelector(".ap-card", { timeout: 10000 });
    await shot("autopilot-1");
    note("autopilot", "what the screen says", "info", (await text()).split("\n").filter(Boolean).slice(0, 8).join(" | "));
  });

  await part("autopilot", "turn on the PNG rule", async () => {
    await click(".ap-card:has-text('PNG pictures') button");
    await page.waitForTimeout(800);
    await shot("autopilot-2-on");
    note("autopilot", "after Turn on", "info", (await text(".msg")).replace(/\n/g, " ").slice(0, 220));
    note("autopilot", "rules table", "info", (await text("table")).replace(/\n/g, " | ").slice(0, 220));
  });

  await part("autopilot", "a PNG arrives in Downloads", async () => {
    const dl = path.join(fakeHome, "Downloads");
    fs.copyFileSync(path.join(path.dirname(fakeHome), "holiday.png"), path.join(dl, "beach.png"));
    await page.waitForTimeout(6000); // the engine waits for a download to settle
    const target = path.join(fakeHome, "Pictures", "PNG", "beach.png");
    note("autopilot", "new PNG moved by itself", fs.existsSync(target) ? "OK" : "NOT MOVED", fs.existsSync(target) ? "found in Pictures/PNG" : "still in Downloads: " + fs.existsSync(path.join(dl, "beach.png")));
  });

  await part("autopilot", "move what is already there", async () => {
    const dl = path.join(fakeHome, "Downloads");
    fs.copyFileSync(path.join(path.dirname(fakeHome), "holiday.png"), path.join(dl, "old.png"));
    await click("button:has-text('Move what is there now')");
    await page.waitForTimeout(1500);
    await shot("autopilot-3-run-now");
    note("autopilot", "Move what is there now", "info", (await text(".msg")).replace(/\n/g, " ").slice(0, 160));
  });

  await part("autopilot", "write my own rule", async () => {
    await click("summary:has-text('Write my own rule')");
    await page.waitForTimeout(400);
    await shot("autopilot-4-own");
  });
}
