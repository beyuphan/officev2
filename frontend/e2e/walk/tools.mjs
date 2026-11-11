// the remaining screens: open each as a new person would, and record the first impression
const SCREENS = [
  ["redact", "pdf"], ["watermark", "pdf"], ["protect", "pdf"], ["compare", "pdf"], ["ocr", "pdf"], ["pagenums", "pdf"],
  ["pagesize", "pdf"], ["forms", "pdf"], ["props", "pdf"], ["finish", "pdf"], ["pdfbatch", "pdf"], ["pdfimages", "pdf"],
  ["scanclean", "pdf"], ["printlayout", "pdf"], ["attachments", "pdf"], ["sign", "pdf"],
  ["social", "photo"], ["idphoto", "photo"], ["collage", "photo"], ["background", "photo"],
  ["rename", "files"], ["cleanup", "files"], ["diskmap", "files"],
  ["transcribe", "ai"], ["documents", "ai"], ["models", "ai"],
  ["clipboard", "desk"], ["screen", "desk"], ["vault", "private"], ["text", "tools"], ["devlab", "tools"], ["addons", "system"], ["activity", "system"],
];

export async function run({ page, shot, goto, text, part, note, shots }) {
  for (const [id, group] of SCREENS) {
    await part("tools", id, async () => {
      await goto(id);
      await page.waitForSelector("h1", { timeout: 8000 });
      await page.waitForTimeout(500);
      await shot(`tool-${id}`);
      const h = await page.locator("h1").first().innerText();
      const hint = (await page.locator("header.title p, .title p").first().innerText().catch(() => "")).slice(0, 140);
      const buttons = (await page.locator("main button").allInnerTexts()).map((s) => s.trim()).filter(Boolean).slice(0, 6).join(" / ");
      note("tools", `${id} (${group})`, "info", `"${h}" — ${hint} — buttons: ${buttons}`);
    });
  }
}
