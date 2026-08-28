import type {
  ApiErrorEnvelope,
  BatchRequest,
  ComfyUIStatusResponse,
  ExecutionResponse,
  ExecutionStartedResponse,
  PreviewResponse,
  ResultsResponse,
  RunCreatedResponse,
} from "./types";

const DEFAULT_API_URL = "http://127.0.0.1:8000";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface BatchcraftApi {
  getComfyUIStatus(signal?: AbortSignal): Promise<ComfyUIStatusResponse>;
  previewBatch(batch: BatchRequest): Promise<PreviewResponse>;
  createRun(batch: BatchRequest): Promise<RunCreatedResponse>;
  startRun(runId: string): Promise<ExecutionStartedResponse>;
  getExecution(runId: string, signal?: AbortSignal): Promise<ExecutionResponse>;
  getResults(runId: string, signal?: AbortSignal): Promise<ResultsResponse>;
  resultUrl(downloadUrl: string): string;
}

export class BatchcraftApiClient implements BatchcraftApi {
  readonly baseUrl: string;

  constructor(baseUrl = import.meta.env.VITE_BATCHCRAFT_API_URL || DEFAULT_API_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  getComfyUIStatus(signal?: AbortSignal): Promise<ComfyUIStatusResponse> {
    return this.request("/api/comfyui/status", { signal });
  }

  previewBatch(batch: BatchRequest): Promise<PreviewResponse> {
    return this.request("/api/batches/preview", this.jsonRequest(batch));
  }

  createRun(batch: BatchRequest): Promise<RunCreatedResponse> {
    return this.request("/api/runs", this.jsonRequest(batch));
  }

  startRun(runId: string): Promise<ExecutionStartedResponse> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/execute`, { method: "POST" });
  }

  getExecution(runId: string, signal?: AbortSignal): Promise<ExecutionResponse> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/execution`, { signal });
  }

  getResults(runId: string, signal?: AbortSignal): Promise<ResultsResponse> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}/results`, { signal });
  }

  resultUrl(downloadUrl: string): string {
    return `${this.baseUrl}${downloadUrl.startsWith("/") ? "" : "/"}${downloadUrl}`;
  }

  private jsonRequest(body: BatchRequest): RequestInit {
    return {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, init);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      throw new ApiError("Cannot reach the batchcraft API", "network_error", null);
    }

    if (!response.ok) {
      const envelope = await readErrorEnvelope(response);
      throw new ApiError(
        envelope?.error.message ?? `The batchcraft API returned HTTP ${response.status}`,
        envelope?.error.code ?? "http_error",
        response.status,
      );
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new ApiError("The batchcraft API returned invalid JSON", "invalid_response", response.status);
    }
  }
}

async function readErrorEnvelope(response: Response): Promise<ApiErrorEnvelope | null> {
  try {
    const value: unknown = await response.json();
    if (!isRecord(value) || !isRecord(value.error)) {
      return null;
    }
    if (typeof value.error.code !== "string" || typeof value.error.message !== "string") {
      return null;
    }
    return { error: { code: value.error.code, message: value.error.message } };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const apiClient = new BatchcraftApiClient();
