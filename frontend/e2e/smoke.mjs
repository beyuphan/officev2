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
    await page.goto(`http://localhost:${VITE}/#${id}`);
    await page.reload();
    await page.waitForSelector("text=running");
  };
  const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
  const W = (p) => path.join(work, p);

  // 1. Merge two PDFs
  await goto("merge");
  await answer([W("a.pdf"), W("b.pdf")]);
  await page.click("text=Add files…");
  await page.waitForSelector("text=a.pdf");
  await answer(W("merged.pdf"));
  await page.click("button:has-text('Merge to…')");
  await page.waitForSelector("text=pages written", { timeout: 30000 });
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
  await page.click("button:has-text('Scan')");
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
  await goto("merge");
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

  // merge shows page counts and where each file lands
  await goto("merge");
  await answer([W("org.pdf"), W("four.pdf")]);
  await page.click("text=Add files…");
  await page.waitForSelector("text=The merged file will have 7 pages");
  check("merge shows which pages come from which file", (await page.locator("td:has-text('1–3')").count()) === 1 && (await page.locator("td:has-text('4–7')").count()) === 1);
  await shot("12-merge-preview");

  // organize: rotate page 2, remove page 3, move page 2 before page 1
  await goto("organize");
  await answer(W("org.pdf"));
  await page.click("text=Choose…");
  await page.waitForSelector(".ptile >> nth=2");
  await page.click("button[aria-label='Rotate page 2']");
  await page.click("button[aria-label='Remove page 3']");
  await page.click("button[aria-label='Move page 2 earlier']");
  const changes = await page.locator(".changes").innerText();
  check("organize lists every change in plain words", changes.includes("Removed: page 3") && changes.includes("Rotated: page 2 by 90°") && changes.includes("New order: 2, 1"), changes);
  await page.locator(".ptile").first().click();
  await page.waitForSelector(".rotbox img");
  await shot("13-organize");
  await answer(W("org-out.pdf"));
  await page.click("button:has-text('Save to…')");
  await page.waitForSelector("text=pages written", { timeout: 30000 });
  const out1 = await result("org-out.pdf");
  check("organize result matches what the page manager showed", JSON.stringify(out1) === JSON.stringify([["two", 90], ["one", 0]]), JSON.stringify(out1));

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

  // extract: click tiles, the range field follows; typing selects tiles
  await goto("split");
  await answer(W("four.pdf"));
  await page.click("text=Choose…");
  await page.waitForSelector("button[aria-label='Page 4']");
  await page.click("button[aria-label='Page 1']");
  await page.click("button[aria-label='Page 3']");
  check("tiles fill the range field", (await page.inputValue("#pages")) === "1,3");
  await page.fill("#pages", "2-4");
  check("typing a range selects the tiles", (await page.locator(".tile-page[aria-pressed='true']").count()) === 3);
  await page.fill("#pages", "2-9");
  await page.waitForSelector("text=Not a valid range");
  await page.fill("#pages", "2-3");
  await shot("16-extract");
  await answer(W("four-out.pdf"));
  await page.click("button:has-text('Extract to…')");
  await page.waitForSelector("text=pages written", { timeout: 30000 });
  const out3 = await result("four-out.pdf");
  check("extract keeps the chosen pages", JSON.stringify(out3.map((p) => p[0])) === JSON.stringify(["p2", "p3"]));

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
  const editCount = () => page.locator(".photoside .editlist li").count();
  const settle = () => page.waitForSelector(".photocanvas > img:not(.loading)", { timeout: 15000 });

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
  await page.waitForSelector("text=Crop to");
  await settle();
  const [nw, nh] = await natural();
  check("the preview shows the cropped square", Math.abs(nw / nh - 1) < 0.02 && nw < 600, `${nw}x${nh}`);
  await page.click("button[aria-label='Rotate right']");
  await page.waitForSelector("text=Rotate right 90°");

  await page.click("button[role='tab']:has-text('Adjust')");
  const srcBeforeAdjust = await imgSrc();
  await page.locator("#sl-Brightness").fill("40");
  await page.waitForSelector("text=brightness +40");
  await page.waitForFunction((b) => document.querySelector(".photocanvas > img").getAttribute("src") !== b, before, { timeout: 10000 });
  check("adjust sliders change the preview", true);

  await page.click("button[role='tab']:has-text('Filters')");
  await page.waitForFunction(() => document.querySelectorAll(".filtergrid img").length >= 10, null, { timeout: 15000 });
  check("every filter shows a thumbnail of this photo", (await page.locator(".filtergrid img").count()) >= 15);
  await page.click(".filtergrid button:has-text('sepia')");
  await page.waitForSelector("text=Filter: sepia");
  await shot("21-photo-filters");

  await page.click("button[role='tab']:has-text('Blur')");
  const layer = await page.locator(".draglayer").boundingBox();
  await page.mouse.move(layer.x + layer.width * 0.2, layer.y + layer.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(layer.x + layer.width * 0.6, layer.y + layer.height * 0.5, { steps: 6 });
  await page.mouse.up();
  await page.waitForSelector(".areabox");
  await page.click(".tabpanel button:has-text('Apply')");
  await page.waitForSelector("text=Gaussian blur (area)");

  await page.click("button[role='tab']:has-text('Text')");
  await page.fill("#tx-text", "Merhaba ğüşİ");
  const l2 = await page.locator(".draglayer").boundingBox();
  await page.mouse.click(l2.x + l2.width * 0.5, l2.y + l2.height * 0.8);
  await page.click("button:has-text('Add text')");
  await page.waitForSelector("text=Merhaba");

  await page.click("button[role='tab']:has-text('Draw')");
  await page.click("button[aria-pressed]:has-text('Arrow'), .tabpanel button:has-text('Arrow')");
  const l3 = await page.locator(".draglayer").boundingBox();
  await page.mouse.move(l3.x + l3.width * 0.1, l3.y + l3.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(l3.x + l3.width * 0.4, l3.y + l3.height * 0.3, { steps: 6 });
  await page.mouse.up();
  await page.waitForSelector("text=Draw arrow");
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
  await page.fill("input[aria-label='Preset name']", "my look");
  await page.click("button:has-text('Save'):near(input[aria-label='Preset name'])");
  await page.waitForSelector(".presetlist li:has-text('my look')");

  await page.click("button[role='tab']:has-text('Save')");
  await page.selectOption("#sv-fmt", "png");
  await answer(W("pic-edited.png"));
  await page.click("button:has-text('Save a copy…')");
  await page.waitForSelector("text=px written to", { timeout: 30000 });
  const saved = JSON.parse(await pyOut(`from PIL import Image;import json;im=Image.open(r"${wp("pic-edited.png")}");print(json.dumps([im.size[0],im.size[1],im.mode]))`));
  check("the saved photo is the edited, square, rotated result", saved[0] === saved[1] && saved[0] < 600, JSON.stringify(saved));
  check("the original photo is untouched", JSON.parse(await pyOut(`from PIL import Image;import json;print(json.dumps(list(Image.open(r"${wp("pic.png")}").size)))`))[0] === 600);

  // 12. PDF editor
  await doc("edit.pdf", ["Hello world", "Second page"]);
  await goto("pdfedit");
  await answer(W("edit.pdf"));
  await page.click("text=Open a PDF…");
  await page.waitForSelector(".page.editable img");
  await page.waitForSelector(".strip img");
  const box = () => page.locator(".page.editable").boundingBox();
  let pb = await box();
  const at = (x, y) => [pb.x + (x / 400) * pb.width, pb.y + (y / 300) * pb.height];
  const clickAt = async (x, y) => { const [px, py] = at(x, y); await page.mouse.click(px, py); };
  const dragAt = async (x0, y0, x1, y1) => { const [a, b] = at(x0, y0), [c, d] = at(x1, y1); await page.mouse.move(a, b); await page.mouse.down(); await page.mouse.move(c, d, { steps: 6 }); await page.mouse.up(); };
  const idle = () => page.waitForSelector(".preview:not(.loading)", { timeout: 15000 });

  await page.click("button[aria-label='Text']");
  await clickAt(100, 200);
  await page.waitForSelector("#pe-prompt");
  await page.fill("#pe-prompt", "Çalışma ğ");
  await page.keyboard.press("Enter");
  await page.waitForSelector("text=Çalışma ğ”");
  await idle();
  await page.click("button[aria-label='Highlight']");
  await dragAt(55, 100, 170, 125);
  await page.waitForSelector(".pdfside >> text=Highlight");
  await page.click("button[aria-label='Box']");
  await dragAt(220, 40, 320, 90);
  await page.waitForSelector(".pdfside >> text=Box");
  await page.click("button[aria-label='Text']");
  await page.click(".stamps button:has-text('APPROVED')");
  await clickAt(250, 250);
  await page.waitForSelector("text=APPROVED”");
  await idle();
  await shot("23-pdf-editor");

  await page.click("button[aria-label='Select']");
  await clickAt(110, 205);
  await page.waitForSelector("h2:has-text('Selected text')");
  const [mx, my] = at(110, 205), [mx2, my2] = at(110, 245);
  await page.mouse.move(mx, my);
  await page.mouse.down();
  await page.mouse.move(mx2, my2, { steps: 6 });
  await page.mouse.up();
  await idle();
  await clickAt(270, 65);
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => !document.querySelector(".pdfside .editlist")?.innerText.includes("Box"));
  check("select, drag and Delete work on the page", true);

  await page.click("button[aria-label^='Page 2']");
  await page.waitForSelector("img[alt='Page 2']");
  await page.click("button[aria-label='Note']");
  pb = await box();
  await clickAt(50, 50);
  await page.fill("#pe-prompt", "kontrol et");
  await page.keyboard.press("Enter");
  await page.waitForSelector("text=Note “kontrol et”");
  await page.click("button[aria-label^='Page 1']");
  await page.waitForSelector("img[alt='Page 1']");
  pb = await box();
  await page.click("button[aria-label='Link']");
  await dragAt(55, 100, 170, 130);
  await page.fill("#pe-prompt", "example.com");
  await page.keyboard.press("Enter");
  await page.waitForSelector("text=Link to example.com");
  const nOps = await page.locator(".pdfside .editlist li").count();
  await page.keyboard.press("Control+z");
  check("Ctrl+Z undoes the last PDF edit", (await page.locator(".pdfside .editlist li").count()) === nOps - 1);
  await page.keyboard.press("Control+y");
  await answer(W("edit-out.pdf"));
  await page.click("button:has-text('Save a copy…')");
  await page.waitForSelector("text=pages written", { timeout: 30000 });
  const out = JSON.parse(await pyOut(`import pymupdf,json\nd=pymupdf.open(r"${wp("edit-out.pdf")}")\np=d[0];q=d[1]\nw=p.search_for("Çalışma ğ")\nprint(json.dumps({"t1":p.get_text(),"annots":[a.type[1] for a in p.annots()],"links":[l.get("uri") for l in p.get_links()],"y":w[0].y0 if w else None,"stamp":"APPROVED" in p.get_text(),"note":[a.info["content"] for a in q.annots()]}))`));
  check("the saved PDF has the text, searchable with Turkish letters", out.t1.includes("Çalışma ğ") && out.y !== null, JSON.stringify(out));
  check("the text was moved by the drag (about 40 points down)", out.y > 225 && out.y < 255, String(out.y));
  check("highlight, link, stamp and note all made it into the file", out.annots.includes("Highlight") && !out.annots.includes("Square") && out.links.includes("https://example.com") && out.stamp && out.note[0] === "kontrol et", JSON.stringify(out));

  // 13. PDF page tools
  await goto("pagenums");
  await answer(W("edit.pdf"));
  await page.click("button:has-text('Choose…')");
  await page.waitForSelector("text=This page will be stamped");
  await shot("24-pagenumbers");
  await answer(W("numbered.pdf"));
  await page.click("button:has-text('Save to…')");
  await page.waitForSelector("text=pages written", { timeout: 30000 });
  const numbered = JSON.parse(await pyOut(`import pymupdf,json\nd=pymupdf.open(r"${wp("numbered.pdf")}")\nprint(json.dumps([p.get_text() for p in d]))`));
  check("page numbers are written as 1 / 2 and 2 / 2", numbered[0].includes("1 / 2") && numbered[1].includes("2 / 2"), JSON.stringify(numbered));

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

  await goto("export");
  await answer(W("four.pdf"));
  await page.locator("button:has-text('Choose…')").nth(0).click();
  await page.waitForSelector("text=4 pages");
  fs.mkdirSync(W("imgs"));
  await answer(W("imgs"));
  await page.locator("button:has-text('Choose…')").nth(1).click();
  await page.click("button.primary:has-text('Export')");
  await page.waitForSelector("text=file(s) written", { timeout: 30000 });
  check("every page is exported as a picture", fs.readdirSync(W("imgs")).length === 4);

  await goto("addsplit");
  await page.click("button:has-text('Split into files')");
  await answer(W("four.pdf"));
  await page.locator("button:has-text('Choose…')").nth(0).click();
  fs.mkdirSync(W("parts"));
  await answer(W("parts"));
  await page.locator("button:has-text('Choose…')").nth(1).click();
  await page.click("button.primary:has-text('Split')");
  await page.waitForSelector("text=file(s) written", { timeout: 30000 });
  check("a 4-page PDF split every 2 pages gives two files", fs.readdirSync(W("parts")).length === 2);

  // 10. Remaining screens at least render without console errors
  for (const id of ["pdfedit", "photo", "pagesize", "finish", "split", "organize", "convert", "protect", "watermark", "redact", "ocr", "images", "video", "background", "upscale", "transcribe", "autopilot"]) {
    await goto(id);
    await page.waitForSelector("h1");
  }
  await shot("11-autopilot");
  check("no console errors or exceptions", errors.length === 0, errors.slice(0, 3).join(" | "));

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
