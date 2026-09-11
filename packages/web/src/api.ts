/**
 * The backend client.
 *
 * The frontend's ONLY knowledge of the backend. Everything it imports beyond this
 * file comes from @valiify/studio-shared, so replacing the local Node service with a
 * hosted runner means changing `BASE` and nothing else.
 */
import type {
  BriefSchemaResponse,
  CommitRunResponse,
  CreateRunRequest,
  CreateRunResponse,
  DesignContract,
  RunDetail,
  RunListResponse,
  StudioHealth,
  SubmitAnswersRequest,
  SubmitFeedbackRequest,
  SubmitFeedbackResponse,
  TargetRepoInfo,
} from "@valiify/studio-shared";

const BASE = import.meta.env.VITE_STUDIO_API ?? "";

export class ApiError extends Error {
  status: number;
  detail?: string;
  constructor(status: number, message: string, detail?: string) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, parsed?.error ?? res.statusText, parsed?.detail);
  return parsed as T;
}

const post = <T>(path: string, body: unknown): Promise<T> =>
  req<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  health: () => req<StudioHealth>("/api/health"),
  target: () => req<TargetRepoInfo>("/api/target"),
  briefSchema: (surfaceId: string) =>
    req<BriefSchemaResponse>(`/api/surfaces/${encodeURIComponent(surfaceId)}/brief-schema`),
  runs: () => req<RunListResponse>("/api/runs"),
  run: (runId: string) => req<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`),
  createRun: (body: CreateRunRequest) => post<CreateRunResponse>("/api/runs", body),
  answers: (runId: string, body: SubmitAnswersRequest) =>
    post<{ round: number; relPath: string; run: RunDetail }>(`/api/runs/${encodeURIComponent(runId)}/answers`, body),
  /** Validates through val-core's feedback-check; a FAIL comes back as a 422 body, not a throw. */
  feedback: async (runId: string, body: SubmitFeedbackRequest): Promise<SubmitFeedbackResponse> => {
    const res = await fetch(`${BASE}/api/runs/${encodeURIComponent(runId)}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = await res.json();
    if (res.status === 200 || res.status === 422) return parsed as SubmitFeedbackResponse;
    throw new ApiError(res.status, parsed?.error ?? res.statusText, parsed?.detail);
  },
  approve: (runId: string, message: string) =>
    post<{ runId: string; prompt: string }>(`/api/runs/${encodeURIComponent(runId)}/approve`, { message }),
  commit: async (runId: string, message?: string): Promise<CommitRunResponse> => {
    const res = await fetch(`${BASE}/api/runs/${encodeURIComponent(runId)}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    });
    return (await res.json()) as CommitRunResponse;
  },
  file: async (runId: string, path: string): Promise<string> => {
    const res = await fetch(`${BASE}/api/runs/${encodeURIComponent(runId)}/file?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new ApiError(res.status, `Cannot read ${path}`);
    return res.text();
  },
  contract: (runId: string) => req<DesignContract>(`/api/runs/${encodeURIComponent(runId)}/file?path=05-package/contract.json`),
  conceptUrl: (runId: string, version: number) =>
    `${BASE}/api/runs/${encodeURIComponent(runId)}/concept/${version}`,
  runEventsUrl: (runId: string) => `${BASE}/api/runs/${encodeURIComponent(runId)}/events`,
  eventsUrl: () => `${BASE}/api/events`,
};
