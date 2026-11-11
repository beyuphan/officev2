import { failed } from "../lib/notify";
import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { CheckField, FolderField, InputsField, RunBar, Segmented, SelectField, SourceField, TextField, Title, baseName, imageFilter, useTask } from "../shared";
import { ColorInput, Slider } from "../photoui";
import { get } from "../api";

const stem = (p: string) => baseName(p).replace(/\.[^.]+$/, "");

/* ------------------------------------------------------------------------------------------ */
/* Sizes for social media                                                                      */
/* ------------------------------------------------------------------------------------------ */

type Size = { id: string; label: string; width: number; height: number };

export function Social({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<string | null>(null);
  const [sizes, setSizes] = useState<Size[]>([]);
  const [chosen, setChosen] = useState<string[]>(["instagram_post"]);
  const [mode, setMode] = useState<"fill" | "fit">("fill");
  const [format, setFormat] = useState("jpeg");
  const [bg, setBg] = useState("#ffffff");
  const [outDir, setOutDir] = useState<string | null>(null);
  const [fx, setFx] = useState(0.5);
  const [fy, setFy] = useState(0.5);
  const task = useTask(onDone);

  useEffect(() => {
    get<{ sizes: Size[] }>("/photo/social-sizes").then((r) => setSizes(r.sizes)).catch(failed("Could not load the size list"));
  }, []);
  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  return (
    <>
      <Title title="Sizes for social media" hint="Make one photo fit Instagram, YouTube, LinkedIn and more at once. Each size becomes its own file." />
      <SourceField label="Photo" file={file} onPick={setFile} filters={imageFilter} />
      <span className="label">Sizes</span>
      <div className="checks wide">
        {sizes.map((s) => (
          <CheckField key={s.id} label={`${s.label} (${s.width}×${s.height})`} checked={chosen.includes(s.id)} onChange={() => toggle(s.id)} />
        ))}
      </div>
      <Segmented label="When the shape is different" value={mode} onChange={setMode} options={[{ id: "fill", label: "Fill the whole size (cut the edges)" }, { id: "fit", label: "Show the whole photo (add bars)" }]} />
      {mode === "fill" ? (
        <>
          <Slider label="Keep this part: left to right" value={fx} min={0} max={1} step={0.05} reset={0.5} onChange={setFx} />
          <Slider label="Keep this part: top to bottom" value={fy} min={0} max={1} step={0.05} reset={0.5} onChange={setFy} />
        </>
      ) : (
        <ColorInput label="Bar colour" value={bg} onChange={setBg} />
      )}
      <SelectField id="so-fmt" label="File type" value={format} onChange={setFormat} options={[{ id: "jpeg", label: "JPEG" }, { id: "png", label: "PNG" }, { id: "webp", label: "WebP" }]} />
      <FolderField label="Save the files in" value={outDir} onPick={setOutDir} />
      <RunBar
        label="Make the pictures"
        busyLabel="Working…"
        disabled={!file || !outDir || chosen.length === 0}
        task={task}
        onRun={() => task.run("/photo/social", { input: file, out_dir: outDir, presets: chosen, mode, format, background: bg, focus_x: fx, focus_y: fy })}
      />
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Passport photos                                                                             */
/* ------------------------------------------------------------------------------------------ */

const ID_SIZES = [
  { id: "35x45", label: "35 × 45 mm (passport, most countries)", w: 35, h: 45 },
  { id: "50x60", label: "50 × 60 mm (Turkish ID card, biometric)", w: 50, h: 60 },
  { id: "40x60", label: "40 × 60 mm", w: 40, h: 60 },
  { id: "51x51", label: "51 × 51 mm (2 × 2 inch, US)", w: 51, h: 51 },
  { id: "25x35", label: "25 × 35 mm (small visa photo)", w: 25, h: 35 },
  { id: "custom", label: "Another size…", w: 35, h: 45 },
];

export function IdPhoto({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<string | null>(null);
  const [size, setSize] = useState("35x45");
  const [w, setW] = useState("35");
  const [h, setH] = useState("45");
  const [paper, setPaper] = useState("10x15");
  const [count, setCount] = useState("0");
  const [fy, setFy] = useState(0.4);
  const task = useTask(onDone);
  const pick = ID_SIZES.find((s) => s.id === size)!;
  const mm = size === "custom" ? { w: Number(w), h: Number(h) } : { w: pick.w, h: pick.h };
  const valid = mm.w >= 10 && mm.w <= 100 && mm.h >= 10 && mm.h <= 100;

  return (
    <>
      <Title title="Passport photos" hint="Crop a portrait to the exact size and fill a sheet of photo paper with copies. Print at 100% (no “fit to page”)." />
      <SourceField label="Portrait photo" file={file} onPick={setFile} filters={imageFilter} />
      <SelectField id="id-size" label="Photo size" value={size} onChange={setSize} options={ID_SIZES.map((s) => ({ id: s.id, label: s.label }))} />
      {size === "custom" && (
        <div className="row3">
          <TextField id="id-w" label="Width mm" type="number" mono value={w} onChange={setW} />
          <TextField id="id-h" label="Height mm" type="number" mono value={h} onChange={setH} />
        </div>
      )}
      <SelectField
        id="id-paper"
        label="Paper"
        value={paper}
        onChange={setPaper}
        options={[
          { id: "10x15", label: "10 × 15 cm photo paper" },
          { id: "13x18", label: "13 × 18 cm photo paper" },
          { id: "A4", label: "A4" },
          { id: "A5", label: "A5" },
        ]}
      />
      <TextField id="id-count" label="How many copies" type="number" mono value={count} onChange={setCount} hint="0 fills the whole sheet" />
      <Slider label="Face height on the photo" value={fy} min={0} max={1} step={0.05} reset={0.4} onChange={setFy} />
      <p className="hint">If the head is cut off, move this towards the top.</p>
      <RunBar
        label="Make the sheet…"
        busyLabel="Working…"
        disabled={!file || !valid}
        task={task}
        onRun={async () => {
          if (!file) return;
          const output = await save({ filters: [{ name: "JPEG", extensions: ["jpg"] }, { name: "PNG", extensions: ["png"] }], defaultPath: `${stem(file)}-sheet.jpg` });
          if (output) await task.run("/photo/passport", { input: file, output, width_mm: mm.w, height_mm: mm.h, paper, count: Number(count) || 0, focus_y: fy });
        }}
      />
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Collage, animation, panorama, exposure merge                                                */
/* ------------------------------------------------------------------------------------------ */

type Make = "collage" | "animation" | "panorama" | "merge";

const MAKE: Record<Make, { label: string; hint: string; path: string; ext: string[]; name: string; min: number }> = {
  collage: { label: "Collage", hint: "Put several pictures on one image, in a neat grid.", path: "/photo/collage", ext: ["jpg", "png"], name: "collage.jpg", min: 2 },
  animation: { label: "Animated GIF", hint: "Make a moving picture from several pictures, one after the other.", path: "/photo/animation", ext: ["gif", "webp"], name: "animation.gif", min: 2 },
  panorama: { label: "Panorama", hint: "Join photos that overlap by about a third (taken from one spot, left to right) into one wide picture.", path: "/photo/panorama", ext: ["jpg", "png"], name: "panorama.jpg", min: 2 },
  merge: { label: "Balance exposures", hint: "Blend photos of the same scene taken darker and brighter into one well-lit picture (HDR look). Use a tripod or a steady hand.", path: "/photo/merge-exposure", ext: ["jpg", "png"], name: "balanced.jpg", min: 2 },
};

export function Collage({ onDone, start }: { onDone: () => void; start?: Make }) {
  const [kind, setKind] = useState<Make>(start ?? "collage");
  const [inputs, setInputs] = useState<string[]>([]);
  const [cols, setCols] = useState("0");
  const [gap, setGap] = useState("12");
  const [bg, setBg] = useState("#ffffff");
  const [fill, setFill] = useState(true);
  const [ms, setMs] = useState("500");
  const task = useTask(onDone);
  const m = MAKE[kind];

  return (
    <>
      <Title title="Collage and more" hint={m.hint} />
      <Segmented label="What to make" value={kind} onChange={setKind} options={(Object.keys(MAKE) as Make[]).map((k) => ({ id: k, label: MAKE[k].label }))} />
      <InputsField label={kind === "animation" ? "Pictures, in the order they appear" : "Pictures"} items={inputs} onChange={setInputs} filters={imageFilter} />
      {kind === "collage" && (
        <>
          <div className="row3">
            <TextField id="co-cols" label="Pictures per row" type="number" mono value={cols} onChange={setCols} hint="0 chooses for you" />
            <TextField id="co-gap" label="Space between (px)" type="number" mono value={gap} onChange={setGap} />
            <ColorInput label="Background" value={bg} onChange={setBg} />
          </div>
          <CheckField label="Fill every cell (cut the edges of the pictures)" checked={fill} onChange={setFill} />
        </>
      )}
      {kind === "animation" && <TextField id="an-ms" label="Time per picture (milliseconds)" type="number" mono value={ms} onChange={setMs} hint="500 is half a second" />}
      <RunBar
        label="Make it…"
        busyLabel="Working…"
        disabled={inputs.length < m.min}
        task={task}
        onRun={async () => {
          const output = await save({ filters: [{ name: m.label, extensions: m.ext }], defaultPath: m.name });
          if (!output) return;
          const body =
            kind === "collage"
              ? { inputs, output, columns: Number(cols) || 0, gap: Number(gap) || 0, background: bg, fill }
              : kind === "animation"
                ? { inputs, output, duration_ms: Number(ms) || 500 }
                : { inputs, output };
          await task.run(m.path, body);
        }}
      />
    </>
  );
}
