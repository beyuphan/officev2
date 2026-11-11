export async function run({ page, answer, shot, goto, click, text, timed, part, note, W, wp, pyRun, shots }) {
  const tool = async (name) => {
    const btn = page.locator(`.toolrail button[aria-label='${name}']`);
    for (const h of await page.locator(".toolrail button.grouptitle[aria-expanded='false']").all()) {
      if (await btn.isVisible()) break;
      await click(h);
    }
    await click(btn);
  };
  const pageBox = async (n = 1) => page.locator(`.pagewrap[data-page='${n}'] .page.editable`).boundingBox();

  await part("pdf", "empty editor", async () => {
    await goto("pdfedit");
    await shot("pdf-1-empty");
    note("pdf", "empty editor shows", "info", (await text(".photo.empty, main")).split("\n").filter(Boolean).slice(0, 4).join(" | "));
  });

  await part("pdf", "open a PDF", async () => {
    await answer(W("report.pdf"));
    const ms = await timed(async () => {
      await click("text=Open a PDF…");
      await page.waitForSelector(".page.editable img", { timeout: 20000 });
    });
    await page.waitForTimeout(800);
    await shot("pdf-2-opened");
    const rail = await page.locator("nav.rail").isVisible();
    note("pdf", "opening the report", ms < 3000 ? "OK" : "SLOW", `${ms} ms to first page; left menu ${rail ? "still visible" : "folded away"}`);
    const boxes = await page.locator("[data-orig='text']").count();
    const pics = await page.locator("[data-orig='image']").count();
    note("pdf", "page's own content found without any mode", boxes > 0 ? "OK" : "FAIL", `${boxes} text boxes, ${pics} pictures on page 1 (rendered so far)`);
  });

  await part("pdf", "hover and click the title", async () => {
    const title = page.locator(".pagewrap[data-page='1'] [data-orig='text']").first();
    await title.waitFor({ state: "visible", timeout: 10000 });
    const b = await title.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
    await page.waitForTimeout(300);
    await shot("pdf-3-hover-title");
    await click(title);
    await page.waitForTimeout(500);
    await shot("pdf-4-after-click-title");
    const editing = await page.locator("textarea.editing, .obj.text [contenteditable], textarea").count();
    note("pdf", "one click on the title", editing ? "OK" : "NOTHING", editing ? "a text box opens for typing" : "no text box appeared");
    await page.keyboard.press("Control+a");
    await page.keyboard.type("Annual Report 2026");
    await page.waitForTimeout(300);
    await shot("pdf-5-typed");
    const pb = await pageBox(1);
    await page.mouse.click(pb.x + pb.width * 0.5, pb.y + pb.height * 0.97);
    await page.waitForTimeout(500);
    await shot("pdf-6-committed");
  });

  await part("pdf", "what the options panel shows when text is selected", async () => {
    const t = page.locator(".pagewrap[data-page='1'] .obj.text").first();
    if (await t.count()) await click(t);
    await page.waitForTimeout(400);
    await shot("pdf-7-panel-text");
    note("pdf", "side panel with a text selected", "info", (await text(".sidepanel")).split("\n").filter(Boolean).slice(0, 14).join(" | "));
  });

  await part("pdf", "select the logo and delete it", async () => {
    const pics = page.locator(".pagewrap[data-page='1'] [data-orig='image']:not(.bg)");
    const n = await pics.count();
    if (!n) return note("pdf", "logo is selectable", "FAIL", "no picture box on page 1");
    await click(pics.first());
    await page.waitForTimeout(300);
    await shot("pdf-8-logo-selected");
    await page.keyboard.press("Delete");
    await page.waitForTimeout(1200);
    await shot("pdf-9-logo-deleted");
    note("pdf", "delete the logo on page 1", "info", "see screenshots; page 2 and 3 must keep theirs (checked after saving)");
  });

  await part("pdf", "add new text with the Text tool", async () => {
    await tool("Text");
    const pb = await pageBox(1);
    await page.mouse.move(pb.x + pb.width * 0.75, pb.y + pb.height * 0.2, { steps: 8 });
    await page.mouse.click(pb.x + pb.width * 0.75, pb.y + pb.height * 0.2);
    await page.keyboard.type("Reviewed by Elif");
    await page.waitForTimeout(300);
    await shot("pdf-10-new-text-typing");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await shot("pdf-11-new-text-done");
    note("pdf", "side panel while the Text tool is active", "info", (await text(".sidepanel")).split("\n").filter(Boolean).slice(0, 12).join(" | "));
  });

  await part("pdf", "highlight words", async () => {
    await tool("Highlight");
    const pb = await pageBox(1);
    const y = pb.y + pb.height * (260 / 842);
    await page.mouse.move(pb.x + pb.width * (60 / 595), y, { steps: 6 });
    await page.mouse.down();
    await page.mouse.move(pb.x + pb.width * (300 / 595), y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    await shot("pdf-12-highlight");
  });

  await part("pdf", "undo", async () => {
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(400);
    await shot("pdf-13-after-undo");
  });

  await part("pdf", "ordinary tools: the rail", async () => {
    note("pdf", "tool rail", "info", (await text(".toolrail")).split("\n").filter(Boolean).join(" | "));
    await shot("pdf-14-rail");
  });

  await part("pdf", "save a copy", async () => {
    await answer(W("report-edited.pdf"));
    const ms = await timed(async () => {
      await click("button:has-text('Save a copy…')");
      await page.waitForSelector("text=pages written", { timeout: 30000 });
    });
    await shot("pdf-15-saved");
    note("pdf", "saving", ms < 4000 ? "OK" : "SLOW", `${ms} ms; message: ${(await text(".pdfstatus")).replace(/\n/g, " ").slice(0, 120)}`);
    // what the saved file really looks like, pages 1 and 2
    const out = shots.split("\\").join("/");
    const o = await pyRun(`
import pymupdf
d = pymupdf.open(r"${wp("report-edited.pdf")}")
for i in (0, 1):
    d[i].get_pixmap(dpi=70).save(r"${out}/saved-page-" + str(i + 1) + ".png")
print(d[0].get_text()[:90].replace(chr(10), " | "))
print([len([x for x in d[i].get_image_info() if x["width"] > 1]) for i in range(len(d))])
`);
    note("pdf", "saved file contents", "info", o.split("\n").join(" ; "));
  });
}
