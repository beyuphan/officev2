import { useEffect, useState } from "react";
import {
  CheckField,
  FolderField,
  InputsField,
  RunBar,
  Segmented,
  SelectField,
  TextField,
  Title,
  imageFilter,
  useTask,
  videoFilter,
} from "../shared";
import { get } from "../api";

export function Images({ onDone }: { onDone: () => void }) {
  const [inputs, setInputs] = useState<string[]>([]);
  const [outDir, setOutDir] = useState<string | null>(null);
  const [format, setFormat] = useState("webp");
  const [quality, setQuality] = useState("80");
  const [maxSide, setMaxSide] = useState("0");
  const [strip, setStrip] = useState(true);
  const task = useTask(onDone);

  return (
    <>
      <Title
        title="Images"
        hint="Compress and convert images in bulk. Results go to a separate folder; your originals are never touched."
      />
      <InputsField label="Images or folders" items={inputs} onChange={setInputs} filters={imageFilter} />
      <FolderField label="Save to folder" value={outDir} onPick={setOutDir} />
      <div className="row3">
        <SelectField
          id="i-fmt"
          label="Format"
          value={format}
          onChange={setFormat}
          options={[
            { id: "webp", label: "WebP" },
            { id: "jpeg", label: "JPEG" },
            { id: "png", label: "PNG" },
            { id: "same", label: "Keep format" },
          ]}
        />
        <TextField id="i-q" label="Quality" type="number" mono value={quality} onChange={setQuality} />
        <TextField id="i-max" label="Longest side px" type="number" mono value={maxSide} onChange={setMaxSide} hint="0 keeps size" />
      </div>
      <CheckField
        label="Remove metadata (EXIF, GPS, camera info)"
        checked={strip}
        onChange={setStrip}
        hint="Orientation is applied first so photos stay upright."
      />
      <RunBar
        label="Convert"
        busyLabel="Converting…"
        disabled={inputs.length === 0 || !outDir}
        task={task}
        onRun={() =>
          task.run("/media/images", {
            inputs,
            out_dir: outDir,
            format,
            quality: Number(quality),
            max_side: Number(maxSide),
            strip_metadata: strip,
          })
        }
      />
    </>
  );
}

export function Video({ onDone }: { onDone: () => void }) {
  const [inputs, setInputs] = useState<string[]>([]);
  const [outDir, setOutDir] = useState<string | null>(null);
  const [format, setFormat] = useState("mp4");
  const [crf, setCrf] = useState("28");
  const [height, setHeight] = useState("0");
  const task = useTask(onDone);

  return (
    <>
      <Title title="Video" hint="Shrink and convert videos with ffmpeg. Originals are kept. Large files take a while; you can cancel." />
      <InputsField label="Videos or folders" items={inputs} onChange={setInputs} filters={videoFilter} />
      <FolderField label="Save to folder" value={outDir} onPick={setOutDir} />
      <div className="row3">
        <SelectField
          id="v-fmt"
          label="Format"
          value={format}
          onChange={setFormat}
          options={[
            { id: "mp4", label: "MP4 (H.264)" },
            { id: "webm", label: "WebM (VP9)" },
          ]}
        />
        <TextField id="v-crf" label="Quality (CRF)" type="number" mono value={crf} onChange={setCrf} hint="Lower is better. 23 high, 28 balanced, 33 small" />
        <TextField id="v-h" label="Max height px" type="number" mono value={height} onChange={setHeight} hint="0 keeps size" />
      </div>
      <RunBar
        label="Convert"
        busyLabel="Converting…"
        disabled={inputs.length === 0 || !outDir}
        task={task}
        onRun={() => task.run("/media/video", { inputs, out_dir: outDir, format, crf: Number(crf), max_height: Number(height) })}
      />
    </>
  );
}

export function Background({ onDone }: { onDone: () => void }) {
  const [inputs, setInputs] = useState<string[]>([]);
  const [outDir, setOutDir] = useState<string | null>(null);
  const [model, setModel] = useState("u2netp");
  const task = useTask(onDone);

  return (
    <>
      <Title
        title="Remove background"
        hint="Cut out the subject and save a transparent PNG. Runs locally. The model downloads once on first use."
      />
      <InputsField label="Images or folders" items={inputs} onChange={setInputs} filters={imageFilter} />
      <FolderField label="Save to folder" value={outDir} onPick={setOutDir} />
      <Segmented
        label="Model"
        value={model}
        onChange={setModel}
        options={[
          { id: "u2netp", label: "Fast (5 MB)" },
          { id: "u2net", label: "Accurate (176 MB)" },
        ]}
      />
      <RunBar
        label="Remove background"
        busyLabel="Working…"
        disabled={inputs.length === 0 || !outDir}
        task={task}
        onRun={() => task.run("/media/remove-background", { inputs, out_dir: outDir, model })}
      />
    </>
  );
}

type ModelInfo = { id: string; installed: boolean };

export function Upscale({ onDone, goToModels }: { onDone: () => void; goToModels: () => void }) {
  const [inputs, setInputs] = useState<string[]>([]);
  const [outDir, setOutDir] = useState<string | null>(null);
  const [scale, setScale] = useState("4");
  const [installed, setInstalled] = useState<boolean | null>(null);
  const task = useTask(onDone);

  useEffect(() => {
    get<ModelInfo[]>("/models").then((m) => setInstalled(m.find((x) => x.id === "realesrgan")?.installed ?? false));
  }, []);

  return (
    <>
      <Title
        title="Upscale"
        hint="Enlarge low-resolution images 2 to 4 times with Real-ESRGAN on your graphics card. Results go to a separate folder."
      />
      {installed === false && (
        <p className="msg bad">
          The upscaler is a separate download (45 MB, a third-party program) and is not installed.{" "}
          <button className="icon text" onClick={goToModels}>
            Open Models
          </button>
        </p>
      )}
      <InputsField label="Images or folders" items={inputs} onChange={setInputs} filters={imageFilter} />
      <FolderField label="Save to folder" value={outDir} onPick={setOutDir} />
      <SelectField
        id="u-scale"
        label="Scale"
        value={scale}
        onChange={setScale}
        options={[
          { id: "2", label: "2×" },
          { id: "3", label: "3×" },
          { id: "4", label: "4×" },
        ]}
      />
      <RunBar
        label="Upscale"
        busyLabel="Upscaling…"
        disabled={inputs.length === 0 || !outDir || installed === false}
        task={task}
        onRun={() => task.run("/media/upscale", { inputs, out_dir: outDir, scale: Number(scale) })}
      />
    </>
  );
}
