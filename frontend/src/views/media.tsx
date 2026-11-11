import { useState } from "react";
import { useModelGate } from "../modelgate";
import {
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
  const gate = useModelGate();

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
        onRun={async () => {
          if (await gate.ensure(`rembg-${model}`)) await task.run("/media/remove-background", { inputs, out_dir: outDir, model });
        }}
      />
      {gate.dialog}
    </>
  );
}
