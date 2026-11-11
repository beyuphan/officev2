// A person's walk through the app: real mouse movement and clicks, screenshots, timings and notes. No pass/fail checks.
//   node e2e/walkthrough.mjs [area ...]     areas: home pdf pages photo convert autopilot tools
// Screenshots go to e2e/walk (or $WALK_SHOTS). File dialogs (a desktop feature) are answered with prepared files.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const shots = process.env.WALK_SHOTS ?? path.join(here, "walk-shots");
fs.rmSync(shots, { recursive: true, force: true });
fs.mkdirSync(shots, { recursive: true });
const wanted = process.argv.slice(2);
const want = (a) => wanted.length === 0 || wanted.includes(a);

const work = fs.mkdtempSync(path.join(os.homedir(), "lf-walk-"));
const fakeHome = path.join(work, "home");
for (const d of ["Downloads", "Pictures", "Documents", "Desktop"]) fs.mkdirSync(path.join(fakeHome, d), { recursive: true });
const data = path.join(work, "_data");
const PORT = 8767, VITE = 1420, TOKEN = "walk-token";
const edge = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(fs.existsSync);
const py = path.join(repo, "backend/venv/Scripts/python.exe");
const W = (p) => path.join(work, p);
const wp = (p) => W(p).replace(/\\/g, "/");

const procs = [];
function start(cmd, args, opts) {
  const p = spawn(cmd, args, { stdio: "ignore", shell: false, ...opts });
  procs.push(p);
  return p;
}
async function waitFor(url, headers = {}, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url, { headers })).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("timeout waiting for " + url);
}
const pyRun = (code) =>
  new Promise((res, rej) => {
    let out = "";
    const c = spawn(py, ["-X", "utf8", "-c", code], { stdio: ["ignore", "pipe", "inherit"] });
    c.stdout.on("data", (d) => (out += d));
    c.on("exit", (n) => (n ? rej(new Error("python failed")) : res(out.trim())));
  });

const notes = [];
const note = (area, what, verdict, detail = "") => {
  notes.push({ area, what, verdict, detail });
  console.log(`[${area}] ${verdict.padEnd(8)} ${what}${detail ? "  -> " + detail : ""}`);
};

async function main() {
  // ---- realistic files
  await pyRun(`
import pymupdf, io, random
from PIL import Image, ImageDraw, ImageFilter
random.seed(3)
# a letterhead-like background: soft gradient, full page
bg = Image.new("RGB", (595, 842))
d = ImageDraw.Draw(bg)
for y in range(842):
    d.line([(0, y), (595, y)], fill=(225 - y // 12, 236 - y // 14, 250 - y // 20))
buf = io.BytesIO(); bg.save(buf, "PNG"); bgbytes = buf.getvalue()
logo = Image.new("RGB", (160, 80), (196, 50, 40)); ld = ImageDraw.Draw(logo); ld.rectangle((8, 8, 152, 72), outline=(255, 255, 255), width=3); ld.text((50, 32), "ACME", fill=(255, 255, 255))
lb = io.BytesIO(); logo.save(lb, "PNG"); logobytes = lb.getvalue()
doc = pymupdf.open()
lorem = ["Revenue grew by twelve percent compared with the previous quarter,", "driven mainly by the new subscription plans and a lower churn rate.", "Operating costs stayed flat while the team grew from nine to fourteen.", "We expect the trend to continue through the end of the year."]
for n in range(1, 4):
    p = doc.new_page(width=595, height=842)
    p.insert_image(p.rect, stream=bgbytes)
    p.insert_image(pymupdf.Rect(40, 36, 140, 86), stream=logobytes)
    p.insert_text((60, 150), "Quarterly Report" if n == 1 else f"Section {n}", fontsize=26, fontname="hebo", color=(0.1, 0.1, 0.25))
    p.insert_text((60, 178), "Prepared for the board of directors", fontsize=12, fontname="helv", color=(0.3, 0.3, 0.3))
    y = 230
    for blk in range(3):
        for line in lorem:
            p.insert_text((60, y), line, fontsize=11, fontname="helv"); y += 16
        y += 18
    p.draw_rect(pymupdf.Rect(60, y, 535, y + 70), color=(0.3, 0.3, 0.3), width=0.8)
    for i, cell in enumerate(["Region", "Q1", "Q2", "Q3"]):
        p.insert_text((70 + i * 115, y + 20), cell, fontsize=11, fontname="hebo")
    for i, cell in enumerate(["North", "120", "135", "151"]):
        p.insert_text((70 + i * 115, y + 48), cell, fontsize=11, fontname="helv")
    p.insert_text((60, 800), "Confidential - for internal use. IBAN TR33 0006 1005 1978 6457 8413 26", fontsize=9, fontname="helv")
doc.save(r"${wp("report.pdf")}")
other = pymupdf.open()
for t in ("Appendix A", "Appendix B"):
    q = other.new_page(); q.insert_text((72, 120), t, fontsize=24)
other.save(r"${wp("appendix.pdf")}")
# a phone-photo-like picture
im = Image.new("RGB", (1600, 1067))
dd = ImageDraw.Draw(im)
for y in range(1067):
    dd.line([(0, y), (1600, y)], fill=(70 + y // 12, 120 + y // 15, 190 - y // 14))
dd.ellipse((1150, 90, 1330, 270), fill=(255, 224, 120))
dd.polygon([(0, 1067), (500, 520), (900, 1067)], fill=(52, 84, 58))
dd.polygon([(500, 1067), (1000, 600), (1600, 1067)], fill=(40, 66, 48))
dd.rectangle((640, 760, 760, 900), fill=(190, 150, 110)); dd.polygon([(620, 760), (700, 690), (780, 760)], fill=(150, 60, 50))
im = im.filter(ImageFilter.GaussianBlur(1.2)); im.save(r"${wp("holiday.jpg")}", quality=92)
im.save(r"${wp("holiday.png")}")
`);
  fs.writeFileSync(W("notes.txt"), "plain notes");

  // ---- servers
  start(py, ["-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", String(PORT)], {
    cwd: path.join(repo, "backend"),
    env: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, LOCALFLOW_TOKEN: TOKEN, LOCALFLOW_DATA_DIR: data, LOCALFLOW_ALLOWED_ROOTS: [work, fakeHome].join(path.delimiter) },
  });
  start(process.execPath, [path.join(repo, "frontend/node_modules/vite/bin/vite.js"), "--port", String(VITE), "--strictPort"], { cwd: path.join(repo, "frontend"), env: { ...process.env, VITE_ENGINE: "" } });
  await waitFor(`http://127.0.0.1:${PORT}/health`, { Authorization: `Bearer ${TOKEN}` });
  await waitFor(`http://localhost:${VITE}/`);

  const browser = await chromium.launch({ executablePath: edge, headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("response", async (r) => {
    if (r.status() >= 400 && r.url().includes("127.0.0.1")) errors.push(`${r.status()} ${new URL(r.url()).pathname} ${(await r.text().catch(() => "")).slice(0, 140)}`);
  });
  await page.addInitScript(() => { try { if (!localStorage.getItem("officev2.lang")) localStorage.setItem("officev2.lang", "en"); } catch {} });
  await page.addInitScript(
    ({ port, token }) => {
      window.__dialogs = [];
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 0,
        invoke: async (cmd, args = {}) => {
          if (cmd === "engine_info") return { port, token };
          if (cmd.startsWith("plugin:dialog|")) return window.__dialogs.shift() ?? null;
          if (cmd === "clip_list") return [];
          if (cmd === "clip_paused") return false;
          return null;
        },
      };
    },
    { port: PORT, token: TOKEN },
  );

  const answer = (...vals) => page.evaluate((v) => window.__dialogs.push(...v), vals);
  const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
  const goto = async (id) => {
    for (let a = 1; ; a++) {
      await page.goto(`http://localhost:${VITE}/#${id}`);
      await page.reload();
      try {
        await page.waitForSelector("nav.rail", { state: "attached", timeout: 15000 });
        break;
      } catch (e) {
        if (a >= 3) throw e;
      }
    }
    await page.waitForFunction(() => !document.body.innerText.includes("Starting the local engine"));
    await page.waitForTimeout(300);
  };
  // a person's mouse: move there, then press
  const click = async (loc, opts = {}) => {
    const l = typeof loc === "string" ? page.locator(loc).first() : loc.first();
    await l.waitFor({ state: "visible", timeout: 10000 });
    await l.scrollIntoViewIfNeeded();
    const b = await l.boundingBox();
    const x = b.x + (opts.fx ?? 0.5) * b.width, y = b.y + (opts.fy ?? 0.5) * b.height;
    await page.mouse.move(x, y, { steps: 8 });
    await page.mouse.click(x, y, { clickCount: opts.count ?? 1 });
  };
  const text = async (sel = "main") => (await page.locator(sel).first().innerText().catch(() => "")).replace(/\s+\n/g, "\n");
  const timed = async (fn) => {
    const t = Date.now();
    await fn();
    return Date.now() - t;
  };
  // run one part of the walk; a part that gets stuck is reported as such, and the walk goes on
  const part = async (area, what, fn) => {
    const before = errors.length;
    try {
      await fn();
    } catch (e) {
      note(area, what, "BLOCKED", String(e.message).split("\n")[0].slice(0, 160));
      await shot(`BLOCKED-${area}-${what.replace(/\W+/g, "-").slice(0, 40)}`).catch(() => {});
    }
    if (errors.length > before) note(area, what, "ERRORS", errors.slice(before, before + 2).join(" | ").slice(0, 200));
  };

  const ctx = { page, answer, shot, goto, click, text, timed, part, note, W, wp, pyRun, shots, work, fakeHome, errors };

  if (want("home")) await (await import("./walk/home.mjs")).run(ctx);
  if (want("pdf")) await (await import("./walk/pdf.mjs")).run(ctx);
  if (want("pages")) await (await import("./walk/pages.mjs")).run(ctx);
  if (want("photo")) await (await import("./walk/photo.mjs")).run(ctx);
  if (want("convert")) await (await import("./walk/convert.mjs")).run(ctx);
  if (want("autopilot")) await (await import("./walk/autopilot.mjs")).run(ctx);
  if (want("tools")) await (await import("./walk/tools.mjs")).run(ctx);

  fs.writeFileSync(path.join(shots, "notes.json"), JSON.stringify(notes, null, 1));
  await browser.close();
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const p of procs) p.kill();
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch {}
  });
