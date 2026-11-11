import fs from "node:fs";

export async function run({ page, answer, shot, goto, click, text, timed, part, note, W, wp }) {
  await part("convert", "first look", async () => {
    await goto("convert");
    await shot("convert-1-empty");
    note("convert", "empty screen", "info", (await text()).split("\n").filter(Boolean).join(" | "));
    await click("button[aria-label='What can I convert?']");
    await page.waitForTimeout(300);
    await shot("convert-2-info");
    note("convert", "information list", "info", (await text(".cv-help")).split("\n").filter(Boolean).join(" | "));
  });

  const choose = async (file) => {
    await answer(W(file));
    await click("button:has-text('Choose'):has-text('file')");
    await page.waitForSelector(".cv-card", { timeout: 10000 });
  };
  const result = async () => (await page.locator(".msg").first().innerText().catch(() => "(no message)")).replace(/\n/g, " ").slice(0, 200);

  await part("convert", "a PDF: choices appear", async () => {
    await choose("report.pdf");
    await shot("convert-3-pdf-choices");
    note("convert", "PDF choices", "info", (await page.locator(".cv-card b").allInnerTexts()).join(" | "));
  });

  const run = async (area, cardText, outName, folder = false) => {
    await part("convert", cardText, async () => {
      await click(`.cv-card:has-text("${cardText}")`);
      await page.waitForTimeout(300);
      await shot(`convert-4-${cardText.replace(/\W+/g, "-").slice(0, 24)}`);
      if (folder) {
        const d = W(outName);
        fs.mkdirSync(d, { recursive: true });
        await answer(d);
      } else await answer(W(outName));
      const ms = await timed(async () => {
        await click("button.primary:has-text('Convert')");
        await page.waitForFunction(() => document.querySelector(".msg"), null, { timeout: 60000 });
      });
      note("convert", `"${cardText}" result`, (await result()).match(/written|saved/i) ? (ms < 8000 ? "OK" : "SLOW") : "PROBLEM", `${ms} ms; ${await result()}`);
      await shot(`convert-5-${cardText.replace(/\W+/g, "-").slice(0, 24)}-done`);
    });
  };

  await run("convert", "Make it fit a size limit", "small.pdf");
  await run("convert", "Plain text or Markdown", "report.txt");
  await run("convert", "Pictures of the pages", "page-pics", true);
  await run("convert", "Word document", "report.docx");
  await run("convert", "Excel tables", "tables", true);

  await part("convert", "a photo: choices appear", async () => {
    await choose("holiday.jpg");
    await shot("convert-6-photo-choices");
    note("convert", "photo choices", "info", (await page.locator(".cv-card b").allInnerTexts()).join(" | "));
  });
  await run("convert", "Another picture type", "photo-out", true);
  await run("convert", "Make it smaller", "photo-small", true);

  await part("convert", "a file it cannot handle", async () => {
    await answer(W("notes.txt"));
    await click("button:has-text('Choose'):has-text('file')");
    await page.waitForTimeout(600);
    await shot("convert-7-text-file");
    note("convert", "a .txt file", "info", (await text()).split("\n").filter(Boolean).slice(0, 6).join(" | "));
  });
}
