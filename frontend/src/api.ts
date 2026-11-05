import { invoke } from "@tauri-apps/api/core";

export type Progress = { done: number; total: number; message: string };

export type Job = {
  id: string;
  type: string;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any;
  error: string | null;
  progress: Progress | null;
};

type EngineInfo = { port: number; token: string };

let info: EngineInfo | null = null;

async function engine(): Promise<EngineInfo> {
  if (!info) {
    // Dev only: lets the UI run in a plain browser against a manually started engine.
    const dev = import.meta.env.DEV && !("__TAURI_INTERNALS__" in window) ? import.meta.env.VITE_ENGINE : undefined;
    if (dev) {
      const [port, token] = String(dev).split(":");
      info = { port: Number(port), token };
    } else {
      info = await invoke<EngineInfo>("engine_info");
    }
  }
  return info;
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { port, token } = await engine();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = body.detail;
    throw new Error(
      typeof detail === "string" ? detail : Array.isArray(detail) ? detail.map((d) => d.msg).join("; ") : `HTTP ${res.status}`,
    );
  }
  return res.json();
}

export const get = <T>(path: string) => request<T>(path);
export const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
export const put = <T>(path: string, body: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const del = <T>(path: string) => request<T>(path, { method: "DELETE" });

/** Resolves once the sidecar answers /health (it needs a moment to start). */
export async function waitForEngine(timeoutMs = 20000): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      await request("/health");
      return;
    } catch (e) {
      if (Date.now() > end) throw new Error("Engine did not start: " + String(e));
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

export type HistoryEntry = {
  id: number;
  op: string;
  source: string | null;
  destination: string | null;
  job_id: string | null;
  created_at: number;
  reverted_at: number | null;
};

export type JobRecord = Job & { created_at: number };

export const listJobs = () => get<JobRecord[]>("/jobs");
export const listHistory = () => get<HistoryEntry[]>("/history");
export const undoEntry = (id: number) => post<{ moved_to?: string; restored_to?: string }>(`/history/${id}/undo`);
export const cancelJob = (id: string) => post<{ cancelled: boolean }>(`/jobs/${id}/cancel`);

/** Starts a job and polls it to the end, reporting each update (progress) along the way. */
export async function runJob(path: string, body: unknown, onUpdate?: (job: Job) => void): Promise<Job> {
  let job = await post<Job>(path, body);
  onUpdate?.(job);
  while (job.state === "queued" || job.state === "running") {
    await new Promise((r) => setTimeout(r, 350));
    job = await get<Job>(`/jobs/${job.id}`);
    onUpdate?.(job);
  }
  return job;
}
