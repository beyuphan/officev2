// End-to-end smoke test: real engine + real UI in Edge, with the Tauri dialogs mocked.
//   npm run test:e2e        (needs backend/venv, Microsoft Edge, ffmpeg not required)
// Screenshots go to $E2E_SHOTS (default: e2e/shots).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const shots = process.env.E2E_SHOTS ?? path.join(here, "shots");
fs.mkdirSync(shots, { recursive: true });

const work = fs.mkdtempSync(path.join(os.homedir(), "lf-e2e-"));
const data = path.join(work, "_data");
const PORT = 8766, VITE = 1420, TOKEN = "e2e-token";
const edge = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(fs.existsSync);
if (!edge) throw new Error("Microsoft Edge not found");

const procs = [];
function start(cmd, args, opts) {
  const p = spawn(cmd, args, { stdio: "ignore", shell: false, ...opts });
  procs.push(p);
  return p;
}
async function waitFor(url, headers = {}, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url, { headers })).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("timeout waiting for " + url);
}

const pyOut = (code) =>
  new Promise((res, rej) => {
    let out = "";
    const c = spawn(path.join(repo, "backend/venv/Scripts/python.exe"), ["-X", "utf8", "-c", code], { stdio: ["ignore", "pipe", "inherit"] });
    c.stdout.on("data", (d) => (out += d));
    c.on("exit", (code) => (code ? rej(new Error("python failed")) : res(out.trim())));
  });

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + extra}`);
  if (!ok) failures++;
};

async function main() {
  // ---- fixtures
  const py = path.join(repo, "backend/venv/Scripts/python.exe");
  const mkpdf = (file, text) =>
    new Promise((res, rej) =>
      spawn(py, ["-c", `import pymupdf;d=pymupdf.open();d.new_page().insert_text((72,100),"${text}");d.save(r"${file}")`]).on("exit", (c) => (c ? rej(new Error("mkpdf")) : res())),
    );
  await mkpdf(path.join(work, "a.pdf"), "alpha");
  await mkpdf(path.join(work, "b.pdf"), "beta");
  fs.mkdirSync(path.join(work, "proj/node_modules/pkg"), { recursive: true });
  fs.writeFileSync(path.join(work, "proj/node_modules/pkg/index.js"), "x".repeat(20000));
  fs.mkdirSync(path.join(work, "proj/src"), { recursive: true });
  fs.writeFileSync(path.join(work, "proj/src/main.py"), "print(1)");
  fs.mkdirSync(path.join(work, "photos"));
  for (const n of ["IMG_001.jpg", "IMG_002.jpg"]) fs.writeFileSync(path.join(work, "photos", n), "x");
  fs.writeFileSync(path.join(work, "secret.txt"), "launch codes");

  // ---- servers
  start(py, ["-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", String(PORT)], {
    cwd: path.join(repo, "backend"),
    env: { ...process.env, LOCALFLOW_TOKEN: TOKEN, LOCALFLOW_DATA_DIR: data, LOCALFLOW_ALLOWED_ROOTS: work },
  });
  start(process.execPath, [path.join(repo, "frontend/node_modules/vite/bin/vite.js"), "--port", String(VITE), "--strictPort"], {
    cwd: path.join(repo, "frontend"),
    env: { ...process.env, VITE_ENGINE: "" },
  });
  await waitFor(`http://127.0.0.1:${PORT}/health`, { Authorization: `Bearer ${TOKEN}` });
  await waitFor(`http://localhost:${VITE}/`);

  const browser = await chromium.launch({ executablePath: edge, headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // the wrong-password attempt in the vault scenario is a deliberate 401
  page.on("console", (m) => m.type() === "error" && !m.text().includes("status of 401") && !m.text().includes("Failed to load resource") && errors.push(m.text()));
  // report failed API calls with their URL and reason (401 = the deliberate wrong vault password)
  page.on("response", async (r) => {
    if (r.status() >= 400 && r.status() !== 401 && r.url().includes("127.0.0.1")) {
      const body = await r.text().catch(() => "");
      errors.push(`${r.status()} ${new URL(r.url()).pathname} ${body.slice(0, 140)}`);
    }
  });
  // Mock the Tauri bridge: engine credentials + file dialogs answered from a queue.
  await page.addInitScript(() => { try { if (!localStorage.getItem("officev2.lang")) localStorage.setItem("officev2.lang", "en"); } catch {} });
  await page.addInitScript(() => { try { if (!localStorage.getItem("e2e.init")) { localStorage.setItem("e2e.init", "1"); } } catch {} });
  await page.addInitScript(
    ({ port, token }) => {
      window.__dialogs = [];
      window.__clips = [
        { id: 1, text: "#FF5733", created_at: Date.now(), pinned: false },
        { id: 2, text: "https://example.com/docs?a=1", created_at: Date.now() - 1000, pinned: false },
        { id: 3, text: "plain note", created_at: Date.now() - 2000, pinned: true },
        { id: 4, kind: "image", text: "", width: 800, height: 600, thumb: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", created_at: Date.now() - 500, pinned: false },
      ];
      window.__clipboard = "";
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 0,
        invoke: async (cmd, args = {}) => {
          if (cmd === "engine_info") return { port, token };
          if (cmd.startsWith("plugin:dialog|")) return window.__dialogs.shift() ?? null;
          if (cmd === "clip_list") {
            const q = (args.query ?? "").toLowerCase();
            return [...window.__clips].filter((c) => c.text.toLowerCase().includes(q)).sort((a, b) => b.pinned - a.pinned || b.created_at - a.created_at);
          }
          if (cmd === "clip_paused") return !!window.__paused;
          if (cmd === "clip_set_paused") return void (window.__paused = args.paused);
          if (cmd === "clip_copy") return void (window.__clipboard = window.__clips.find((c) => c.id === args.id).text);
          if (cmd === "clip_pin") return void (window.__clips.find((c) => c.id === args.id).pinned = args.pinned);
          if (cmd === "clip_delete") return void (window.__clips = window.__clips.filter((c) => c.id !== args.id));
          if (cmd === "clip_clear") return void (window.__clips = window.__clips.filter((c) => c.pinned));
          if (cmd === "set_clipboard") return void (window.__clipboard = args.text);
          if (cmd === "pick_color") return "#336699";
          if (cmd === "start_snip" || cmd === "pin_image") return void (window.__called = [...(window.__called ?? []), cmd + ":" + JSON.stringify(args)]);
          throw new Error("unmocked command " + cmd);
        },
      };
    },
    { port: PORT, token: TOKEN },
  );
  const answer = (...vals) => page.evaluate((v) => window.__dialogs.push(...v), vals);
  const goto = async (id) => {
    // the dev server sometimes answers a first request while it is still preparing a module: try the page again
    for (let attempt = 1; ; attempt++) {
      await page.goto(`http://localhost:${VITE}/#${id}`);
      await page.reload();
      try {
        await page.waitForSelector("nav.rail", { state: "attached", timeout: 15000 });
        break;
      } catch (e) {
        if (attempt >= 3) throw e;
      }
    }
    await page.waitForFunction(() => !document.body.innerText.includes("Starting the local engine"));
  };
  const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
  const W = (p) => path.join(work, p);

  // 1. Merge two PDFs on the Pages screen
  await goto("pages");
  await answer([W("a.pdf"), W("b.pdf")]);
  await page.click("button:has-text('Add PDFs…') >> nth=0");
  await page.waitForSelector(".pg-tile >> nth=1");
  check("the Pages screen shows the pages of both files and says what Save will do", (await page.locator("text=1 file with").count()) === 1);
  await answer(W("merged.pdf"));
  await page.click("button:has-text('Save PDF…')");
  await page.waitForSelector("text=file(s) written", { timeout: 30000 }).catch(async (e) => { console.log("DBG", (await page.locator("main").innerText()).slice(0, 600)); throw e; });
  check("merge writes the file", fs.existsSync(W("merged.pdf")));
  await shot("01-merge");

  // 2. Rename with preview
  await goto("rename");
  await answer(W("photos"));
  await page.click("text=Choose…");
  await page.fill("#rn-p", "IMG_(\\d+)");
  await page.fill("#rn-r", "holiday-{n:03}");
  await page.check("text=Regular expression");
  await page.click("button:has-text('Preview')");
  await page.waitForSelector("text=holiday-001.jpg");
  check("rename preview does not touch files", fs.existsSync(W("photos/IMG_001.jpg")));
  await shot("02-rename");
  await page.click("button:has-text('Rename 2 files')");
  await page.waitForSelector("text=2 renamed");
  check("rename applied", fs.existsSync(W("photos/holiday-001.jpg")) && !fs.existsSync(W("photos/IMG_001.jpg")));

  // 3. Clean up developer junk -> quarantine
  await goto("cleanup");
  await page.click("button:has-text('Developer junk')");
  await answer(W("proj"));
  await page.click("text=Choose…");
  await page.click(".sheet button:has-text('Scan')");
  await page.waitForSelector("text=node_modules", { timeout: 30000 });
  await shot("03-cleanup");
  await page.click("button:has-text('to quarantine')");
  await page.waitForSelector("text=moved to quarantine");
  check("junk folder quarantined, source kept", !fs.existsSync(W("proj/node_modules")) && fs.existsSync(W("proj/src/main.py")));

  // 4. Activity: grouped revisions, undo restores
  await goto("activity");
  await page.waitForSelector("text=Quarantine");
  await shot("04-activity");
  const quarantineRow = page.locator("tr", { hasText: "Quarantine" }).first();
  await quarantineRow.locator("button:has-text('Undo')").click();
  await page.waitForSelector("tr.withdrawn");
  check("undo from Activity restores the folder", fs.existsSync(W("proj/node_modules/pkg/index.js")));
  const renameRow = page.locator("tr", { hasText: "Move / rename" }).first();
  await renameRow.locator("button:has-text('Undo')").click();
  await page.waitForFunction(() => document.querySelectorAll("tr.withdrawn").length >= 2);
  check("one undo restores a whole batch of renames", fs.existsSync(W("photos/IMG_001.jpg")) && fs.existsSync(W("photos/IMG_002.jpg")));

  // 5. Disk map
  await goto("diskmap");
  await answer(W(""));
  await page.click("text=Choose…");
  await page.waitForSelector(".tile", { timeout: 30000 });
  check("disk map shows tiles", (await page.locator(".tile").count()) >= 3);
  await shot("05-diskmap");

  // 6. Vault: create, add, lock, unlock
  await goto("vault");
  await page.fill("#v-pw", "correct horse battery");
  await page.fill("#v-pw2", "correct horse battery");
  await page.click("button:has-text('Create vault')");
  await page.waitForSelector("text=Vault created");
  const key = (await page.locator("pre.recovery").innerText()).trim();
  check("recovery key shown once in 8 groups", key.split("-").length === 8);
  await page.click("text=I have saved it");
  await answer([W("secret.txt")]);
  await page.click("text=Add files…");
  await page.waitForSelector("td:has-text('secret.txt')");
  await shot("06-vault");
  await page.click("button:has-text('Lock now')");
  await page.fill("#v-pw", "wrong password");
  await page.click("button:has-text('Unlock')");
  await page.waitForSelector("text=wrong password or recovery key");
  await page.fill("#v-pw", "correct horse battery");
  await page.click("button:has-text('Unlock')");
  await page.waitForSelector("td:has-text('secret.txt')");
  check("vault unlock with the right password", true);

  // 7. Command palette
  await goto("pages");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("whisper");
  await shot("07-palette");
  await page.keyboard.press("Enter");
  await page.waitForSelector("h1:has-text('Transcribe')");
  check("palette finds a tool by keyword", true);

  // 8. Dev lab JWT + text tools
  await goto("devlab");
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMiLCJleHAiOjE3MDAwMDAwMDB9.sig";
  await page.fill("#dl-in", jwt);
  await page.waitForSelector("text=expired");
  await shot("08-devlab");
  await goto("text");
  await page.fill("#tt-in", "line one\nline two\n\npara two");
  await page.waitForSelector("pre.out");
  check("clean paste output", (await page.locator("pre.out").innerText()).trim() === "line one line two\n\npara two");

  // 9. Models + Documents screens render with real data
  await goto("models");
  await page.waitForSelector("text=Real-ESRGAN");
  await shot("09-models");
  await goto("documents");
  await page.waitForSelector("text=Indexed folders");
  await shot("10-documents");

  // 9b. Clipboard history + screen tools (Rust commands are mocked here; the real ones have cargo tests)
  await goto("clipboard");
  await page.waitForSelector("text=plain note");
  check("clipboard shows a color swatch and a link host", (await page.locator(".swatch").count()) === 1 && (await page.locator("text=link to example.com").count()) === 1);
  check("clipboard shows image thumbnails", (await page.locator(".clip-thumb").count()) === 1 && (await page.locator("text=800×600").count()) === 1);
  check("pinned items are listed first", (await page.locator(".clips li").first().innerText()).includes("plain note"));
  await page.fill("input[aria-label='Search clipboard history']", "docs");
  await page.waitForFunction(() => document.querySelectorAll(".clips li").length === 1);
  await page.fill("input[aria-label='Search clipboard history']", "");
  await page.locator(".clips li", { hasText: "#FF5733" }).locator("button:has-text('Copy')").click();
  check("copy puts the text back on the clipboard", (await page.evaluate(() => window.__clipboard)) === "#FF5733");
  await page.locator(".clips li", { hasText: "plain note" }).locator("button:has-text('Delete')").click();
  await page.waitForFunction(() => !document.body.innerText.includes("plain note"));
  await shot("09b-clipboard");
  await goto("screen");
  await page.click("button:has-text('Pick a color')");
  await page.waitForSelector("text=#336699", { timeout: 6000 });
  check("color picker shows hex, rgb and hsl", (await page.locator("text=rgb(51, 102, 153)").count()) === 1 && (await page.locator("text=hsl(210, 50%, 40%)").count()) === 1);
  check("picked color is copied by default", (await page.evaluate(() => window.__clipboard)) === "#336699");
  await page.click("button:has-text('Select an area')");
  check("text capture starts the snip window", (await page.evaluate(() => window.__called)).some((c) => c.startsWith("start_snip")));
  await shot("09c-screen");

  // 9a. PDF previews: page manager, redaction review, live watermark, page picker, merge summary
  const doc = (name, pages) =>
    pyOut(`import pymupdf;d=pymupdf.open()\nfor t in ${JSON.stringify(pages)}:\n  d.new_page(width=400,height=300).insert_text((60,120),t,fontsize=20)\nd.save(r"${W(name).replace(/\\/g, "/")}")`);
  await doc("org.pdf", ["one", "two", "three"]);
  await doc("red.pdf", ["alpha SECRET beta", "SECRET again", "clean page"]);
  await doc("four.pdf", ["p1", "p2", "p3", "p4"]);
  const result = (name) =>
    pyOut(`import pymupdf,json;d=pymupdf.open(r"${W(name).replace(/\\/g, "/")}");print(json.dumps([[p.get_text().strip(),p.rotation] for p in d]))`).then(JSON.parse);

  // Pages: rotate page 2, remove page 3, move page 2 before page 1
  await goto("pages");
  await answer(W("org.pdf"));
  await page.click("button:has-text('Add PDFs…') >> nth=0");
  await page.waitForSelector(".pg-tile >> nth=2");
  await page.locator(".pg-tile").nth(1).click();
  await page.click("button:has-text('Rotate')");
  await page.locator(".pg-tile").nth(2).click();
  await page.click("button:has-text('Remove')");
  check("removing a page takes its tile away", (await page.locator(".pg-tile").count()) === 2);
  await page.locator(".pg-tile").nth(1).dragTo(page.locator(".pg-tile").nth(0));
  await shot("13-organize");
  await answer(W("org-out.pdf"));
  await page.click("button:has-text('Save PDF…')");
  await page.waitForSelector("text=file(s) written", { timeout: 30000 });
  const out1 = await result("org-out.pdf");
  check("the saved file matches what the Pages screen showed", JSON.stringify(out1) === JSON.stringify([["two", 90], ["one", 0]]), JSON.stringify(out1));

  // redact: find, deselect the match on page 1, draw an own box on page 3, save
  await goto("redact");
  await answer(W("red.pdf"));
  await page.click("text=Choose…");
  await page.fill("#r-terms", "SECRET");
  await page.click("button:has-text('Find')");
  await page.waitForSelector(".box.hit");
  check("redact lists matches per page", (await page.locator(".changes").innerText()).includes("2 areas on 2 pages"));
  await shot("14-redact");
  await page.locator(".box.hit").first().click();
  await page.waitForSelector(".box.off");
  check("clicking a match keeps it", (await page.locator(".changes").innerText()).includes("1 area on 1 page"));
  await page.locator(".pagelist button", { hasText: "Page 2" }).click();
  await page.fill("input[aria-label='Page number']", "3");
  await page.waitForSelector("img[alt='Page 3']");
  const img = await page.locator(".page img").boundingBox();
  await page.mouse.move(img.x + 40, img.y + 30);
  await page.mouse.down();
  await page.mouse.move(img.x + 160, img.y + 70, { steps: 5 });
  await page.mouse.up();
  await page.waitForSelector(".box.manual");
  check("drawing adds an area on that page", (await page.locator(".changes").innerText()).includes("2 areas on 2 pages"));
  await answer(W("red-out.pdf"));
  await page.click("button:has-text('Redact to…')");
  await page.waitForSelector("text=pages written", { timeout: 30000 });
  const out2 = await result("red-out.pdf");
  check("redacted exactly what was marked", out2[0][0].includes("SECRET") && !out2[1][0].includes("SECRET") && out2.length === 3, JSON.stringify(out2));

  // watermark: the preview follows the settings and the page selection
  await goto("watermark");
  await answer(W("org.pdf"));
  await page.click("text=Choose…");
  await page.waitForSelector(".page img");
  await page.waitForTimeout(700);
  const before = await page.locator(".page img").getAttribute("src");
  await page.fill("#wm-text", "DRAFT COPY");
  await page.waitForFunction((b) => document.querySelector(".page img")?.getAttribute("src") !== b, before, { timeout: 8000 });
  check("watermark preview updates as you type", true);
  await page.fill("#wm-pages", "1");
  await page.fill("input[aria-label='Page number']", "2");
  await page.waitForSelector("text=outside your selection", { timeout: 8000 });
  check("preview says when a page is not stamped", true);
  await shot("15-watermark");

  // keeping only some pages: select the ones to drop and remove them
  await goto("pages");
  await answer(W("four.pdf"));
  await page.click("button:has-text('Add PDFs…') >> nth=0");
  await page.waitForSelector(".pg-tile >> nth=3");
  await page.locator(".pg-tile").nth(0).click();
  await page.locator(".pg-tile").nth(3).click({ modifiers: ["Control"] });
  await page.click("button:has-text('Remove')");
  await answer(W("four-out.pdf"));
  await page.click("button:has-text('Save PDF…')");
  await page.waitForSelector("text=file(s) written", { timeout: 30000 });
  const out3 = await result("four-out.pdf");
  check("pages that were not removed are kept", JSON.stringify(out3.map((p) => p[0])) === JSON.stringify(["p2", "p3"]));

  // 11. Photo editor
  const wp = (n) => W(n).replace(/\\/g, "/");
  await pyOut(`from PIL import Image,ImageDraw\nim=Image.new("RGB",(600,400),(40,80,200))\nd=ImageDraw.Draw(im)\nd.rectangle((0,0,299,399),fill=(220,40,40))\nd.rectangle((250,150,350,250),fill=(255,255,255))\nim.save(r"${wp("pic.png")}")`);
  await goto("photo");
  await answer(W("pic.png"));
  await page.click("text=Open a photo…");
  await page.waitForSelector(".photocanvas img");
  check("the tool list folds away in the editors", !(await page.locator(".rail").isVisible()));
  const imgSrc = () => page.locator(".photocanvas > img").getAttribute("src");
  const natural = () => page.evaluate(() => { const i = document.querySelector(".photocanvas > img"); return [i.naturalWidth, i.naturalHeight]; });
  const settle = () => page.waitForSelector(".photocanvas > img:not(.loading)", { timeout: 15000 });
  const section = async (name) => { if ((await page.locator(`button.acchead[aria-expanded='true']:has-text('${name}')`).count()) === 0) await page.click(`button.acchead:has-text('${name}')`); };
  const editCount = async () => { await section("All edits"); return page.locator(".photoside .editlist li").count(); };
  const onPhoto = async (fx, fy) => { const l = await page.locator(".objlayer").boundingBox(); return [l.x + l.width * fx, l.y + l.height * fy]; };
  const dragPhoto = async (a, b) => { const [x0, y0] = await onPhoto(...a), [x1, y1] = await onPhoto(...b); await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move(x1, y1, { steps: 6 }); await page.mouse.up(); };
  const clickPhoto = async (fx, fy) => { const [x, y] = await onPhoto(fx, fy); await page.mouse.click(x, y); };

  await section("Crop and rotate");
  await page.selectOption("#cr-asp", "1:1");
  await page.waitForSelector(".cropbox");
  let cb = await page.locator(".cropbox").boundingBox();
  check("a square crop frame is square on screen", Math.abs(cb.width - cb.height) < 4, JSON.stringify(cb));
  const se = await page.locator(".handle.se").boundingBox();
  await page.mouse.move(se.x + 7, se.y + 7);
  await page.mouse.down();
  await page.mouse.move(se.x - 60, se.y - 60, { steps: 6 });
  await page.mouse.up();
  const cb2 = await page.locator(".cropbox").boundingBox();
  check("dragging a corner keeps the square and shrinks it", Math.abs(cb2.width - cb2.height) < 4 && cb2.width < cb.width - 20, JSON.stringify([cb, cb2]));
  await shot("20-photo-crop");
  await page.click("button:has-text('Apply crop')");
  await page.waitForFunction(() => { const i = document.querySelector(".photocanvas > img"); return i && i.naturalWidth && i.naturalWidth < 600 && Math.abs(i.naturalWidth / i.naturalHeight - 1) < 0.02; }, null, { timeout: 15000 });
  await settle();
  const [nw, nh] = await natural();
  check("the preview shows the cropped square", Math.abs(nw / nh - 1) < 0.02 && nw < 600, `${nw}x${nh}`);
  const beforeRotate = await imgSrc();
  await page.click("button[aria-label='Rotate right']");
  await page.waitForFunction((b) => document.querySelector(".photocanvas > img").getAttribute("src") !== b, beforeRotate, { timeout: 10000 });

  await section("Light and color");
  const srcBeforeAdjust = await imgSrc();
  await page.locator("#sl-Brightness").fill("40");
  await page.waitForFunction((b) => document.querySelector(".photocanvas > img").getAttribute("src") !== b, srcBeforeAdjust, { timeout: 10000 });
  check("adjust sliders change the preview", true);

  await section("Filters and looks");
  await page.waitForFunction(() => document.querySelectorAll(".filtergrid img").length >= 10, null, { timeout: 15000 });
  check("every filter shows a thumbnail of this photo", (await page.locator(".filtergrid img").count()) >= 15);
  const srcBeforeFilter = await imgSrc();
  await page.click(".filtergrid button:has-text('sepia')");
  await page.waitForFunction((b) => document.querySelector(".photocanvas > img").getAttribute("src") !== b, srcBeforeFilter, { timeout: 10000 });
  await shot("21-photo-filters");

  // blur area: a placed object you can see, select, move and reshape
  await page.click("button[aria-label='Blur area']");
  await dragPhoto([0.2, 0.2], [0.6, 0.5]);
  await page.waitForSelector("[data-type='blur']");
  check("a blur area is selected right away with its options above the photo", (await page.locator(".ctxlabel").innerText()).includes("Blur") && (await page.locator("input[aria-label='Strength']").count()) === 1);
  const blurBox = await page.locator("[data-type='blur']").boundingBox();
  const bh = await page.locator(".pobj.selected .hdl-se").boundingBox();
  await page.mouse.move(bh.x + 5, bh.y + 5);
  await page.mouse.down();
  await page.mouse.move(bh.x + 5 + 50, bh.y + 5 + 30, { steps: 5 });
  await page.mouse.up();
  const blurBox2 = await page.locator("[data-type='blur']").boundingBox();
  check("a handle resizes the blur area", blurBox2.width > blurBox.width + 30, `${blurBox.width} -> ${blurBox2.width}`);

  // text: click, type, done
  await page.click("button[aria-label='Text']");
  await clickPhoto(0.5, 0.8);
  await page.waitForSelector("textarea.ptext");
  await page.keyboard.type("Merhaba ğüşİ");
  await page.keyboard.press("Control+Enter");
  await page.waitForSelector("[data-type='text']");
  await settle();
  check("photo text is placed with one click and typed in place", (await page.locator("textarea.ptext").count()) === 0 && (await page.locator(".ctxlabel").innerText()) === "Text");
  const tb1 = await page.locator("[data-type='text']").boundingBox();
  // move it by dragging the text itself
  await page.mouse.move(tb1.x + tb1.width / 2, tb1.y + tb1.height / 2);
  await page.mouse.down();
  await page.mouse.move(tb1.x + tb1.width / 2, tb1.y + tb1.height / 2 - 80, { steps: 6 });
  await page.mouse.up();
  const tb2 = await page.locator("[data-type='text']").boundingBox();
  check("dragging placed text moves it", tb2.y < tb1.y - 50, `${tb1.y} -> ${tb2.y}`);
  // double-click retypes it in place
  await page.mouse.dblclick(tb2.x + tb2.width / 2, tb2.y + tb2.height / 2);
  await page.waitForSelector("textarea.ptext");
  check("double-click edits the text where it stands", (await page.locator("textarea.ptext").inputValue()) === "Merhaba ğüşİ");
  await page.keyboard.press("Escape");
  await page.waitForSelector("[data-type='text']");
  // change the size in the bar
  const w1 = (await page.locator("[data-type='text']").boundingBox()).width;
  await page.fill("input[aria-label='Size']", String(Math.round(Number(await page.locator("input[aria-label='Size']").inputValue()) * 1.6)));
  await page.waitForFunction((w) => document.querySelector("[data-type='text']").getBoundingClientRect().width > w * 1.2, w1, { timeout: 10000 });
  check("changing the size in the bar resizes the text on the photo", true);

  // the text tool stays on for the next text; the editor says whether anything is unsaved
  check("the text tool stays selected after a text is finished", (await page.locator("button[aria-label='Text']").getAttribute("aria-pressed")) === "true");
  check("the editor says the photo has unsaved changes", (await page.locator(".savestate").innerText()).includes("Not saved yet"));
  await page.locator(".phototop button:has-text('File')").click();
  await page.locator("[role='menuitem']:has-text('Close this photo')").click();
  await page.waitForSelector("[role='alertdialog']");
  check("closing with unsaved edits asks first", (await page.locator("[role='alertdialog']").innerText()).includes("did not save"));
  await page.click("[role='alertdialog'] button:has-text('Keep editing')");
  await page.waitForSelector("[role='alertdialog']", { state: "detached" });

  // curves and QR code are whole-photo panels that change the picture
  await page.click("button.acchead:has-text('Curves')");
  await page.waitForSelector("svg.curvebox");
  const srcBeforeCurve = await imgSrc();
  const cv = await page.locator("svg.curvebox").boundingBox();
  await page.mouse.move(cv.x + cv.width / 2, cv.y + cv.height / 2);
  await page.mouse.down();
  await page.mouse.move(cv.x + cv.width / 2, cv.y + cv.height / 4, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction((b) => document.querySelector(".photocanvas > img").getAttribute("src") !== b, srcBeforeCurve, { timeout: 10000 });
  check("dragging the tone curve changes the picture", true);
  await page.click("button.acchead:has-text('QR code')");
  const srcBeforeQr = await imgSrc();
  await page.fill("#qr-text", "https://example.com");
  await page.waitForFunction((b) => document.querySelector(".photocanvas > img").getAttribute("src") !== b, srcBeforeQr, { timeout: 10000 });
  check("a QR code is added to the photo", true);

  await page.click("button[aria-label='Arrow']");
  await dragPhoto([0.1, 0.1], [0.4, 0.3]);
  await page.waitForSelector("[data-type='shape']");
  await settle();
  await shot("22-photo-edited");

  const nBefore = await editCount();
  const shownEdited = await imgSrc();
  await page.locator("button:has-text('Hold to compare')").dispatchEvent("pointerdown");
  await page.waitForFunction((b) => document.querySelector(".photocanvas > img").getAttribute("src") !== b, shownEdited, { timeout: 10000 });
  await page.locator("button:has-text('Hold to compare')").dispatchEvent("pointerup");
  check("hold to compare shows the original", true);
  await page.click("button[aria-label='Undo']");
  check("undo removes the last edit", (await editCount()) === nBefore - 1);
  await page.keyboard.press("Control+y");
  check("redo (Ctrl+Y) brings it back", (await editCount()) === nBefore);
  // an edit in the list can be selected on the photo, and Delete removes it
  await page.fill("input[aria-label='Preset name']", "my look");
  await page.click("button:has-text('Save'):near(input[aria-label='Preset name'])");
  await page.waitForSelector(".presetlist li:has-text('my look')");

  await section("Size and save");
  await page.selectOption("#sv-fmt", "png");
  await answer(W("pic-edited.png"));
  await page.click(".photoside button:has-text('Save a copy…')");
  await page.waitForSelector("text=px written to", { timeout: 30000 });
  const saved = JSON.parse(await pyOut(`from PIL import Image;import json;im=Image.open(r"${wp("pic-edited.png")}");print(json.dumps([im.size[0],im.size[1],im.mode]))`));
  check("the saved photo is the edited, square, rotated result", saved[0] === saved[1] && saved[0] < 600, JSON.stringify(saved));
  check("the original photo is untouched", JSON.parse(await pyOut(`from PIL import Image;import json;print(json.dumps(list(Image.open(r"${wp("pic.png")}").size)))`))[0] === 600);

  // 12. PDF editor
  await doc("edit.pdf", ["Hello world", "Second page"]);
  await goto("pdfedit");
  await answer(W("edit.pdf"));
  await page.click("text=Open a PDF…");
  await page.waitForSelector(".page.editable img").catch(async (e) => { console.log("DBG editor", (await page.locator("body").innerText()).slice(0, 500), errors.slice(-3).join(" | ")); throw e; });
  await page.waitForSelector(".strip img");
  const pg = (n) => `.pagewrap[data-page='${n}'] .page.editable`;
  let pb = await page.locator(pg(1)).boundingBox();
  const at = (x, y) => [pb.x + (x / 400) * pb.width, pb.y + (y / 300) * pb.height];
  const clickAt = async (x, y) => { const [px, py] = at(x, y); await page.mouse.click(px, py); };
  const dragAt = async (x0, y0, x1, y1) => { const [a, b] = at(x0, y0), [c, d] = at(x1, y1); await page.mouse.move(a, b); await page.mouse.down(); await page.mouse.move(c, d, { steps: 6 }); await page.mouse.up(); };
  const count = (sel) => page.locator(sel).count();
  // the PDF tool groups fold: open the folded ones until the wanted tool shows
  const pdfTool = async (name) => {
    const btn = page.locator(`.toolrail button[aria-label='${name}']`);
    for (const h of await page.locator(".toolrail button.grouptitle[aria-expanded='false']").all()) {
      if (await btn.isVisible()) break;
      await h.click();
    }
    await btn.click();
  };
  const pagesTab = () => page.click(".sidetabs button:has-text('Pages')");

  // text: click, type, done. No dialog in between.
  await pdfTool("Text");
  await clickAt(100, 200);
  await page.waitForSelector("textarea.editing");
  await page.keyboard.type("Çalışma ğ");
  await page.keyboard.press("Control+Enter");
  await page.waitForSelector(".obj.text:has-text('Çalışma ğ')");
  check("text is placed with one click and typed in place", (await count("textarea.editing")) === 0);
  check("after placing, the text stays selected with its options above", (await page.locator(".ctxlabel").innerText()).startsWith("Text") && (await count(".obj.text.selected")) === 1);

  await pdfTool("Highlight");
  await dragAt(55, 100, 170, 125);
  await page.waitForSelector("[data-type='highlight']");
  await pdfTool("Box");
  await dragAt(220, 40, 320, 90);
  await page.waitForSelector("[data-type='rect']");
  check("a drawn box is selected right away and its options show above the page", (await page.locator(".ctxlabel").innerText()).startsWith("Box") && (await count("input[aria-label='Line width']")) === 1);
  const rectW = (await page.locator("[data-type='rect']").boundingBox()).width;
  await pdfTool("Stamp");
  await page.click(".ctxbar .stamps button:has-text('APPROVED')");
  await clickAt(250, 250);
  await page.waitForSelector(".obj.text:has-text('APPROVED')");
  await shot("23-pdf-editor");

  // click a placed item to edit it: double-click text to retype
  await pdfTool("Select");
  await clickAt(110, 200);
  check("clicking placed text selects it and shows font and size", (await count(".obj.text.selected")) === 1 && (await count("select[aria-label='Font']")) === 1);
  const [dx0, dy0] = at(110, 200);
  await page.mouse.dblclick(dx0, dy0);
  await page.waitForSelector("textarea.editing");
  check("double-click edits the text where it stands", (await page.locator("textarea.editing").inputValue()) === "Çalışma ğ");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".obj.text:has-text('Çalışma ğ')");
  await page.fill("input[aria-label='Size']", "20");
  const fs20 = await page.locator(".obj.text.selected").evaluate((e) => getComputedStyle(e).fontSize);
  check("changing the size in the bar changes the selected text", parseFloat(fs20) > 15, fs20);
  // move by dragging the text itself
  const [mx, my] = at(110, 200), [mx2, my2] = at(110, 240);
  await page.mouse.move(mx, my);
  await page.mouse.down();
  await page.mouse.move(mx2, my2, { steps: 6 });
  await page.mouse.up();
  // resize the box with its corner handle, then delete it with the keyboard
  await clickAt(220, 65);
  await page.waitForSelector(".hdl-se");
  const h = await page.locator(".hdl-se").boundingBox();
  await page.mouse.move(h.x + 5, h.y + 5);
  await page.mouse.down();
  await page.mouse.move(h.x + 5 + 40, h.y + 5 + 30, { steps: 5 });
  await page.mouse.up();
  const rectW2 = (await page.locator("[data-type='rect']").boundingBox()).width;
  check("a handle resizes a placed shape", rectW2 > rectW + 20, `${rectW} -> ${rectW2}`);
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => !document.querySelector("[data-type='rect']"));
  check("select, drag, resize and Delete work on the page", true);

  // second page: pages scroll one under another
  await pagesTab();
  await page.click("button[aria-label^='Page 2']");
  await page.waitForSelector(`${pg(2)} img`);
  pb = await page.locator(pg(2)).boundingBox();
  await pdfTool("Note");
  await clickAt(50, 50);
  await page.fill("input[aria-label='Note text']", "kontrol et");
  await page.waitForSelector(".obj.note");
  await pagesTab();
  await page.click("button[aria-label^='Page 1']");
  await page.waitForTimeout(400);
  pb = await page.locator(pg(1)).boundingBox();
  await pdfTool("Link");
  await dragAt(55, 100, 170, 130);
  await page.fill("input[aria-label='Link target']", "example.com");
  await page.waitForSelector("[data-type='link']");
  await clickAt(300, 280); // a click on empty page leaves the field
  const nOps = await count("[data-oid]");
  await page.keyboard.press("Control+z");
  let undone = 1;
  // typing the link target and placing the link are two undo steps when they are more than a moment apart
  if ((await count("[data-oid]")) !== nOps - 1) { await page.keyboard.press("Control+z"); undone = 2; }
  check("Ctrl+Z undoes the last PDF edit", (await count("[data-oid]")) === nOps - 1, `${nOps}`);
  for (let i = 0; i < undone; i++) await page.keyboard.press("Control+y"); // as many steps forwards as were taken back
  await answer(W("edit-out.pdf"));
  await page.click("button:has-text('Save a copy…')");
  await page.waitForSelector("text=pages written", { timeout: 30000 }).catch(async (e) => { console.log("STATUS:", await page.locator(".pdfstatus, .ctxbar").allInnerTexts()); throw e; });
  const out = JSON.parse(await pyOut(`import pymupdf,json\nd=pymupdf.open(r"${wp("edit-out.pdf")}")\np=d[0];q=d[1]\nw=p.search_for("Çalışma ğ")\nprint(json.dumps({"t1":p.get_text(),"annots":[a.type[1] for a in p.annots()],"links":[l.get("uri") for l in p.get_links()],"y":w[0].y0 if w else None,"stamp":"APPROVED" in p.get_text(),"note":[a.info["content"] for a in q.annots()]}))`));
  check("the saved PDF has the text, searchable with Turkish letters", out.t1.includes("Çalışma ğ") && out.y !== null, JSON.stringify(out));
  check("the text was moved by the drag (about 40 points down)", out.y > 225 && out.y < 262, String(out.y));
  check("highlight, link, stamp and note all made it into the file", out.annots.includes("Highlight") && !out.annots.includes("Square") && out.links.includes("https://example.com") && out.stamp && out.note[0] === "kontrol et", JSON.stringify(out));


  await goto("props");
  await answer(W("four.pdf"));
  await page.click("button:has-text('Choose…')");
  await page.waitForSelector("#pr-title");
  await page.fill("#pr-title", "Ünite Kitabı");
  await page.click("button:has-text('Add bookmark')");
  await page.fill("input[aria-label='Title']", "Başlangıç");
  await answer(W("props.pdf"));
  await page.click("button:has-text('Save to…')");
  await page.waitForSelector("text=pages written", { timeout: 30000 });
  const props = JSON.parse(await pyOut(`import pymupdf,json\nd=pymupdf.open(r"${wp("props.pdf")}")\nprint(json.dumps({"title":d.metadata["title"],"toc":d.get_toc()}))`));
  check("title and bookmark are saved", props.title === "Ünite Kitabı" && props.toc[0][1] === "Başlangıç", JSON.stringify(props));

  await pyOut(`import pymupdf\nd=pymupdf.open()\np=d.new_page(width=400,height=300)\nfor i,(n,t) in enumerate((("full_name",pymupdf.PDF_WIDGET_TYPE_TEXT),("agree",pymupdf.PDF_WIDGET_TYPE_CHECKBOX))):\n  w=pymupdf.Widget();w.field_name=n;w.field_type=t;w.rect=pymupdf.Rect(60,40+i*40,260,62+i*40);p.add_widget(w)\nd.save(r"${wp("form.pdf")}")`);
  await goto("forms");
  await answer(W("form.pdf"));
  await page.click("button:has-text('Choose…')");
  await page.waitForSelector("#fm-full_name");
  await page.fill("#fm-full_name", "Ayşe Yılmaz");
  await page.check("text=agree");
  await answer(W("filled.pdf"));
  await page.click("button:has-text('Save to…')");
  await page.waitForSelector("text=pages written", { timeout: 30000 });
  const filled = JSON.parse(await pyOut(`import pymupdf,json\nd=pymupdf.open(r"${wp("filled.pdf")}")\nprint(json.dumps({w.field_name:str(w.field_value) for w in d[0].widgets()}))`));
  check("form answers are saved", filled.full_name === "Ayşe Yılmaz" && filled.agree !== "Off", JSON.stringify(filled));

  await goto("convert");
  await answer(W("four.pdf"));
  await page.click("button:has-text('Choose a file…')");
  await page.click(".cv-card:has-text('Pictures of the pages')");
  fs.mkdirSync(W("imgs"));
  await answer(W("imgs"));
  await page.click("button.primary:has-text('Convert and choose a folder…')");
  await page.waitForSelector("text=file(s) written", { timeout: 30000 });
  check("every page is exported as a picture", fs.readdirSync(W("imgs")).length === 4);

  await goto("pages");
  await answer(W("four.pdf"));
  await page.click("button:has-text('Add PDFs…') >> nth=0");
  await page.waitForSelector(".pg-tile >> nth=3");
  await page.fill("input[aria-label='Split every this many pages']", "2");
  fs.mkdirSync(W("parts"));
  await answer(W("parts"));
  await page.click("button:has-text('Save 2 files…')");
  await page.waitForSelector("text=2 file(s) written", { timeout: 30000 });
  check("a 4-page PDF split every 2 pages gives two files", fs.readdirSync(W("parts")).length === 2);

  // 14. Editing what is already in the PDF, page tools, folders, fonts, the tool list
  await pyOut(`import pymupdf,io\nfrom PIL import Image\nd=pymupdf.open()\np=d.new_page(width=400,height=300)\np.insert_text((60,60),"Alpha line",fontsize=20)\nb=io.BytesIO();Image.new("RGB",(40,30),(200,30,30)).save(b,"PNG")\np.insert_image(pymupdf.Rect(250,120,330,180),stream=b.getvalue())\nd.new_page(width=400,height=300).insert_text((60,60),"Second page",fontsize=20)\nd.new_page(width=400,height=300).insert_text((60,60),"Third page",fontsize=20)\nd.save(r"${wp("orig.pdf")}")`);
  await goto("pdfedit");
  await answer(W("orig.pdf"));
  await page.click("text=Open a PDF…");
  await page.waitForSelector(".page.editable img");
  await page.waitForSelector("[data-orig='text']", { timeout: 15000 });
  check("the page's own text and picture can be selected", (await page.locator("[data-orig='text']").count()) >= 1 && (await page.locator("[data-orig='image']").count()) === 1);
  const pgxN = await page.locator(".pagewrap[data-page='1'] .page.editable").boundingBox();
  const tbN = await page.locator("[data-orig='text']").first().boundingBox();
  await page.mouse.move(tbN.x + tbN.width / 2, tbN.y + tbN.height / 2);
  await page.mouse.down();
  await page.mouse.move(tbN.x + tbN.width / 2, tbN.y + tbN.height / 2 + 120, { steps: 8 });
  await page.mouse.up();
  await page.waitForSelector(".obj.text:has-text('Alpha line')");
  check("dragging the page's own text moves it (it becomes an editable text)", (await page.locator("[data-type='cover']").count()) === 1);
  // a plain click on the page's own text opens it for typing right away
  await page.keyboard.press("Escape");
  await page.locator("[data-orig='text']").first().click().catch(() => undefined);
  // the picture: click, then Delete
  await page.locator("[data-orig='image']").click();
  await page.keyboard.press("Delete");
  await page.waitForSelector("[data-type='origimg']");
  check("the page's own picture can be deleted", true);
  await page.waitForFunction(() => !document.querySelector("[data-type='origimg'][data-selected]"), null, { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(700); // the picture's preview is fetched in the background
  await answer(W("orig-editedN.pdf"));
  await page.click("button:has-text('Save a copy…')");
  await page.waitForFunction(() => document.querySelector(".pdfstatus"), null, { timeout: 30000 });
  await page.waitForTimeout(800);
  const editedN = JSON.parse(await pyOut(`import pymupdf,json\nd=pymupdf.open(r"${wp("orig-editedN.pdf")}")\nw=[x for x in d[0].get_text("words") if x[4]=="Alpha"]\nprint(json.dumps({"y":w[0][1] if w else -1,"count":d[0].get_text().count("Alpha"),"tiny":all(i["width"]<=1 for i in d[0].get_image_info())}))`));
  check("the moved text is saved lower and the old copy is gone", editedN.count === 1 && editedN.y > 75, JSON.stringify(editedN));
  check("the deleted picture is gone from the saved file", editedN.tiny === true);

  // page tools: delete the current page
  await goto("pdfedit");
  await answer(W("orig.pdf"));
  await page.click("text=Open a PDF…");
  await page.waitForSelector(".strip img");
  await pagesTab();
  await page.click(".pdftop .numwrap button:has-text('Page tools')");
  await page.click("[role='menuitem']:has-text('Delete this page')");
  await page.waitForFunction(() => document.querySelectorAll(".strip [data-thumb]").length === 2, null, { timeout: 20000 });
  check("Pages > Delete removes the page from the editor", true);
  await page.click(".pdftop .numwrap button:has-text('Page tools')");
  await page.click("[role='menuitem']:has-text('Add a blank page after')");
  await page.waitForFunction(() => document.querySelectorAll(".strip [data-thumb]").length === 3, null, { timeout: 20000 });
  await page.keyboard.press("Control+z");
  await page.waitForFunction(() => document.querySelectorAll(".strip [data-thumb]").length === 2, null, { timeout: 20000 });
  check("undo also takes back a page change", true);
  await answer(W("orig-pages.pdf"));
  await page.click("button:has-text('Save a copy…')");
  await page.waitForFunction(() => document.querySelector(".pdfstatus"), null, { timeout: 30000 });
  await page.waitForTimeout(800);
  const pagedN = JSON.parse(await pyOut(`import pymupdf,json\nd=pymupdf.open(r"${wp("orig-pages.pdf")}")\nprint(json.dumps([p.get_text().strip() for p in d]))`));
  check("the saved copy has the page changes and the original has not changed", pagedN.length === 2 && pagedN[0].includes("Second") && JSON.parse(await pyOut(`import pymupdf,json;print(json.dumps(pymupdf.open(r"${wp("orig.pdf")}").page_count))`)) === 3, JSON.stringify(pagedN));

  // the page strip: drag to reorder, tools on a thumbnail, add another PDF
  await pyOut(`import pymupdf\nd=pymupdf.open()\nfor t in ["AAA","BBB","CCC"]:\n  d.new_page(width=400,height=300).insert_text((60,60),t,fontsize=20)\nd.save(r"${wp("strip.pdf")}")\nd=pymupdf.open()\nd.new_page(width=400,height=300).insert_text((60,60),"ZZZ",fontsize=20)\nd.save(r"${wp("strip2.pdf")}")`);
  await goto("pdfedit");
  await answer(W("strip.pdf"));
  await page.click("text=Open a PDF…");
  await page.waitForFunction(() => document.querySelectorAll(".strip [data-thumb] img").length === 3, null, { timeout: 20000 });
  const t1 = await page.locator(".strip [data-thumb='1'] > button").boundingBox();
  const t3 = await page.locator(".strip [data-thumb='3'] > button").boundingBox();
  await page.mouse.move(t1.x + t1.width / 2, t1.y + t1.height / 2);
  await page.mouse.down();
  await page.mouse.move(t1.x + t1.width / 2, t3.y + t3.height * 0.9, { steps: 12 });
  await page.waitForSelector(".strip .thumb.drop-after, .strip .thumb.drop-before");
  check("dragging a thumbnail shows where it will land", true);
  await page.mouse.up();
  await page.waitForTimeout(1500);
  await answer(W("strip-out.pdf"));
  await page.click("button:has-text('Save a copy…')");
  await page.waitForFunction(() => document.querySelector(".pdfstatus"), null, { timeout: 30000 });
  await page.waitForTimeout(800);
  const reordered = JSON.parse(await pyOut(`import pymupdf,json\nd=pymupdf.open(r"${wp("strip-out.pdf")}")\nprint(json.dumps([p.get_text().strip() for p in d]))`));
  check("dragging page 1 to the end reorders the saved PDF", JSON.stringify(reordered) === JSON.stringify(["BBB", "CCC", "AAA"]), JSON.stringify(reordered));
  await page.hover(".strip [data-thumb='2']");
  await page.click("button[aria-label='Delete page 2']");
  await page.waitForFunction(() => document.querySelectorAll(".strip [data-thumb]").length === 2, null, { timeout: 20000 });
  check("a thumbnail's own button deletes that page", true);
  await answer(W("strip2.pdf"));
  await page.click(".strip .stripadd button:has-text('Add PDF')");
  await page.waitForFunction(() => document.querySelectorAll(".strip [data-thumb]").length === 3, null, { timeout: 20000 });
  check("Add PDF puts another PDF's pages at the end", true);
  await page.waitForTimeout(1500); // the editor scrolls to the new page a moment after the change

  // marking text follows the words
  await pagesTab();
  await page.click("button[aria-label^='Page 1']"); // bring the first page back into view after the page changes
  await page.waitForTimeout(600);
  await pdfTool("Highlight");
  const wN1 = await page.locator(".pagewrap[data-page='1'] .page.editable").boundingBox();
  await page.mouse.move(wN1.x + wN1.width * 0.17, wN1.y + wN1.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(wN1.x + wN1.width * 0.35, wN1.y + wN1.height * 0.2, { steps: 6 });
  await page.mouse.up();
  await page.waitForSelector("[data-type='highlight']");
  const hbN = await page.locator("[data-type='highlight']").first().boundingBox();
  check("a highlight snaps to the words instead of the dragged box", hbN.width > 20 && hbN.width < wN1.width * 0.5 && hbN.height < wN1.height * 0.15, JSON.stringify(hbN));

  // the page's own text and pictures are clickable as soon as the PDF opens, with no mode to pick
  await goto("pdfedit");
  await page.waitForSelector("text=Open a PDF…");
  check("the tool list stays while no file is open in the editor", (await page.locator(".shell.norail").count()) === 0);
  await answer(W("orig.pdf"));
  await page.click("text=Open a PDF…");
  await page.waitForSelector(".page.editable img");
  check("the tool list folds away once a file is open", (await page.locator(".shell.norail").count()) === 1);
  await page.waitForSelector("[data-orig='text']", { timeout: 15000 });
  check("a PDF opens straight away with its own text selectable (no question, no Layers button)", (await page.locator("[role='dialog']").count()) === 0 && (await page.locator(".pdftop button:has-text('Layers')").count()) === 0);

  // a form field keeps the commas you type
  await pdfTool("Form field");
  const fN1 = await page.locator(".pagewrap[data-page='1'] .page.editable").boundingBox();
  await page.mouse.move(fN1.x + fN1.width * 0.2, fN1.y + fN1.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(fN1.x + fN1.width * 0.5, fN1.y + fN1.height * 0.68, { steps: 5 });
  await page.mouse.up();
  await page.waitForSelector("[data-type='field']");
  await page.selectOption("select[aria-label='Kind of field']", "combobox");
  await page.fill("input[aria-label='Choices']", "small, medium, large");
  check("commas can be typed in a form field's choices", (await page.inputValue("input[aria-label='Choices']")) === "small, medium, large");

  // a font can be added
  await pdfTool("Text");
  fs.copyFileSync("C:/Windows/Fonts/consola.ttf", W("MyMono.ttf"));
  await answer(W("MyMono.ttf"));
  await page.selectOption("select[aria-label='Font']", "__add__");
  await page.waitForFunction(() => document.querySelector("select[aria-label='Font']").value === "Consolas", null, { timeout: 15000 });
  check("a font file can be added from the font list", true);

  // folders: only the files directly inside, unless subfolders are asked for
  fs.mkdirSync(W("pics/deeper"), { recursive: true });
  for (const n of ["pics/a.jpg", "pics/b.jpg", "pics/deeper/c.jpg"]) fs.writeFileSync(W(n), "x");
  await goto("background");
  await answer(W("pics"));
  await page.click("button:has-text('Add folder…')");
  await page.waitForSelector(".chips li");
  check("adding a folder lists its own files and leaves subfolders out", (await page.locator(".chips li").count()) === 2);
  await page.click(".chips li button >> nth=0");
  check("a listed file can be removed", (await page.locator(".chips li").count()) === 1);
  await page.check("text=Include subfolders");
  await answer(W("pics"));
  await page.click("button:has-text('Add folder…')");
  await page.waitForFunction(() => document.querySelectorAll(".chips li").length === 3, null, { timeout: 10000 });
  check("with the box ticked the subfolder's files come too", true);

  // the tool list folds
  await goto("home");
  check("the other groups are folded away", (await page.locator("nav.rail .nav:has-text('Compare two PDFs')").count()) === 0);
  await page.click("nav.rail button.more");
  await page.click("nav.rail button.group-label:has-text('PDF')");
  await page.waitForSelector("nav.rail .nav:has-text('Compare two PDFs')");
  check("clicking a group header opens it", true);

  // 10. Remaining screens at least render without console errors
  for (const id of ["pdfedit", "photo", "pagesize", "split", "organize", "convert", "protect", "watermark", "redact", "ocr", "video", "background", "transcribe", "autopilot"]) {
    await goto(id).catch((e) => { console.log("DBG screen", id, errors.slice(-3).join(" | ")); throw e; });
    await page.waitForSelector("h1");
  }
  await shot("11-autopilot");
  // Convert: choose a PDF and the choices for a PDF appear
  await goto("convert");
  await answer(W("four.pdf"));
  await page.click("button:has-text('Choose a file…')");
  await page.waitForSelector(".cv-card:has-text('Word document')");
  check("Convert lists what a PDF can become", (await page.locator(".cv-card").count()) >= 8);
  await page.click("button[aria-label='What can I convert?']");
  await page.waitForSelector(".cv-help li");
  check("the information button lists every kind of file", (await page.locator(".cv-help li").count()) === 4);
  // Autopilot: ready-made rules
  await goto("autopilot");
  await page.waitForSelector(".ap-card:has-text('PNG pictures')");
  check("Autopilot offers ready-made rules", (await page.locator(".ap-card").count()) >= 6);
  // 11. The interface can be switched to Turkish and back
  await goto("home");
  await page.waitForSelector("text=What do you want to do?");
  await page.click("button[title='Türkçe']");
  await page.waitForSelector("text=Ne yapmak istiyorsun?");
  check("the start screen is translated", (await page.locator(".tasks").innerText()).includes("PDF düzenle veya imzala"));
  if ((await page.locator("nav.rail .nav:has-text('Birçok PDF birden')").count()) === 0) await page.click("nav.rail button.group-label >> nth=0"); // the PDF group may be folded
  check("the tool list is translated", (await page.locator("nav.rail").innerText()).includes("Birçok PDF birden"));
  await page.click("button:has-text('Birçok PDF birden') >> nth=0");
  await page.waitForSelector("text=Ne yapılacak (bu sırayla)");
  check("a tool screen is translated, including its buttons", (await page.locator(".sheet").innerText()).toLocaleLowerCase("tr").includes("başlat"));
  await page.click("button[title='English']");
  await page.waitForSelector("text=What to do (in this order)");
  check("switching back restores English", true);
  // the dev server can answer a first request while it still prepares a module; goto() reloads, so that one message is not a bug
  const realErrors = errors.filter((e) => !/Failed to fetch dynamically imported module/.test(String(e)));
  check("no console errors or exceptions", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

  // dark theme: the screens still read well (screenshots are for a human to look at)
  await page.emulateMedia({ colorScheme: "dark" });
  for (const id of ["home", "pages", "convert", "autopilot", "pdfedit"]) {
    await goto(id);
    await page.waitForSelector("h1");
    await shot(`dark-${id}`);
  }
  check("the dark theme applies the dark colors", (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--film").trim())) === "#1a1d21");
  await page.locator(".tb-theme").click();
  check("the theme button switches to light", (await page.evaluate(() => document.documentElement.getAttribute("data-theme"))) === "light");

  await browser.close();
}

try {
  await main();
} catch (e) {
  console.error(e);
  failures++;
} finally {
  procs.forEach((p) => p.kill());
  await new Promise((r) => setTimeout(r, 800));
  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch {}
  process.exit(failures ? 1 : 0);
}
