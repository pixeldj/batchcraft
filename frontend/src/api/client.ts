import type {
  AdoptableProjectsResponse,
  ApiErrorEnvelope,
  AssetsResponse,
  BatchRequest,
  ComfyUIStatusResponse,
  CreatePromptRequest,
  CreatePromptResponse,
  CreatePromptVersionRequest,
  CreatePromptVersionResponse,
  ExecutionResponse,
  ExecutionStartedResponse,
  LibraryPromptVersion,
  PreviewResponse,
  ProjectAdoptRequest,
  ProjectCreateRequest,
  ProjectResponse,
  ProjectsResponse,
  ProjectUpdateRequest,
  Prompt,
  PromptsResponse,
  PromptUpdateRequest,
  PromptVersionsResponse,
  ResultsResponse,
  RunCreatedResponse,
  RunResponse,
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
  listProjects(includeArchived?: boolean, signal?: AbortSignal): Promise<ProjectsResponse>;
  createProject(body: ProjectCreateRequest): Promise<ProjectResponse>;
  getProject(projectId: string, signal?: AbortSignal): Promise<ProjectResponse>;
  updateProject(projectId: string, body: ProjectUpdateRequest): Promise<ProjectResponse>;
  adoptProject(body: ProjectAdoptRequest): Promise<ProjectResponse>;
  listAdoptableProjects(signal?: AbortSignal): Promise<AdoptableProjectsResponse>;
  listProjectAssets(projectKey: string, signal?: AbortSignal): Promise<AssetsResponse>;
  uploadProjectAssets(
    projectKey: string,
    files: File[],
    signal?: AbortSignal,
  ): Promise<AssetsResponse>;
  listPrompts(projectId: string, signal?: AbortSignal): Promise<PromptsResponse>;
  createPrompt(projectId: string, body: CreatePromptRequest): Promise<CreatePromptResponse>;
  getPrompt(promptId: string, signal?: AbortSignal): Promise<Prompt>;
  updatePrompt(promptId: string, body: PromptUpdateRequest): Promise<Prompt>;
  listPromptVersions(
    promptId: string,
    includeArchived?: boolean,
    signal?: AbortSignal,
  ): Promise<PromptVersionsResponse>;
  createPromptVersion(
    promptId: string,
    body: CreatePromptVersionRequest,
  ): Promise<CreatePromptVersionResponse>;
  getPromptVersion(versionId: string, signal?: AbortSignal): Promise<LibraryPromptVersion>;
  previewBatch(batch: BatchRequest): Promise<PreviewResponse>;
  createRun(batch: BatchRequest): Promise<RunCreatedResponse>;
  getRun(runId: string, signal?: AbortSignal): Promise<RunResponse>;
  startRun(runId: string): Promise<ExecutionStartedResponse>;
  getExecution(runId: string, signal?: AbortSignal): Promise<ExecutionResponse>;
  getResults(runId: string, signal?: AbortSignal): Promise<ResultsResponse>;
  resultUrl(downloadUrl: string): string;
  assetUrl(contentUrl: string): string;
}

export class BatchcraftApiClient implements BatchcraftApi {
  readonly baseUrl: string;

  constructor(baseUrl = import.meta.env.VITE_BATCHCRAFT_API_URL || DEFAULT_API_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  getComfyUIStatus(signal?: AbortSignal): Promise<ComfyUIStatusResponse> {
    return this.request("/api/comfyui/status", { signal });
  }

  listProjects(includeArchived = false, signal?: AbortSignal): Promise<ProjectsResponse> {
    const query = includeArchived ? "?include_archived=true" : "";
    return this.request(`/api/projects${query}`, { signal });
  }

  createProject(body: ProjectCreateRequest): Promise<ProjectResponse> {
    return this.request("/api/projects", this.jsonRequest(body, "POST"));
  }

  getProject(projectId: string, signal?: AbortSignal): Promise<ProjectResponse> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}`, { signal });
  }

  updateProject(projectId: string, body: ProjectUpdateRequest): Promise<ProjectResponse> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}`,
      this.jsonRequest(body, "PATCH"),
    );
  }

  adoptProject(body: ProjectAdoptRequest): Promise<ProjectResponse> {
    return this.request("/api/projects/adopt", this.jsonRequest(body, "POST"));
  }

  listAdoptableProjects(signal?: AbortSignal): Promise<AdoptableProjectsResponse> {
    return this.request("/api/projects/adoptable", { signal });
  }

  listProjectAssets(projectKey: string, signal?: AbortSignal): Promise<AssetsResponse> {
    return this.request(`/api/projects/${encodeURIComponent(projectKey)}/assets`, { signal });
  }

  uploadProjectAssets(
    projectKey: string,
    files: File[],
    signal?: AbortSignal,
  ): Promise<AssetsResponse> {
    const body = new FormData();
    for (const file of files) {
      body.append("files", file);
    }
    return this.request(`/api/projects/${encodeURIComponent(projectKey)}/assets`, {
      method: "POST",
      body,
      signal,
    });
  }

  listPrompts(projectId: string, signal?: AbortSignal): Promise<PromptsResponse> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/prompts`, { signal });
  }

  createPrompt(projectId: string, body: CreatePromptRequest): Promise<CreatePromptResponse> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/prompts`,
      this.jsonRequest(body, "POST"),
    );
  }

  getPrompt(promptId: string, signal?: AbortSignal): Promise<Prompt> {
    return this.request(`/api/prompts/${encodeURIComponent(promptId)}`, { signal });
  }

  updatePrompt(promptId: string, body: PromptUpdateRequest): Promise<Prompt> {
    return this.request(
      `/api/prompts/${encodeURIComponent(promptId)}`,
      this.jsonRequest(body, "PATCH"),
    );
  }

  listPromptVersions(
    promptId: string,
    includeArchived = false,
    signal?: AbortSignal,
  ): Promise<PromptVersionsResponse> {
    const query = includeArchived ? "?include_archived=true" : "";
    return this.request(`/api/prompts/${encodeURIComponent(promptId)}/versions${query}`, { signal });
  }

  createPromptVersion(
    promptId: string,
    body: CreatePromptVersionRequest,
  ): Promise<CreatePromptVersionResponse> {
    return this.request(
      `/api/prompts/${encodeURIComponent(promptId)}/versions`,
      this.jsonRequest(body, "POST"),
    );
  }

  getPromptVersion(
    versionId: string,
    signal?: AbortSignal,
  ): Promise<LibraryPromptVersion> {
    return this.request(`/api/prompt-versions/${encodeURIComponent(versionId)}`, { signal });
  }

  previewBatch(batch: BatchRequest): Promise<PreviewResponse> {
    return this.request("/api/batches/preview", this.jsonRequest(batch, "POST"));
  }

  createRun(batch: BatchRequest): Promise<RunCreatedResponse> {
    return this.request("/api/runs", this.jsonRequest(batch, "POST"));
  }

  getRun(runId: string, signal?: AbortSignal): Promise<RunResponse> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}`, { signal });
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
    return this.absoluteUrl(downloadUrl);
  }

  assetUrl(contentUrl: string): string {
    return this.absoluteUrl(contentUrl);
  }

  private jsonRequest(body: unknown, method: "POST" | "PATCH"): RequestInit {
    return {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
  }

  private absoluteUrl(path: string): string {
    return `${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
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
