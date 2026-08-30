export type JsonObject = Record<string, unknown>;

export interface IdentityRequest {
  id: string;
  filesystem_key: string;
  name: string;
}

export interface VariableBindingRequest {
  placeholder: string;
  variable_list: {
    id: string;
    values: string[];
  };
  mode: "all" | "fixed";
  selected_values: string[];
  fixed_value: string | null;
}

export interface BatchRequest {
  project: IdentityRequest;
  batch: IdentityRequest;
  prompt_versions: Array<{
    id: string;
    name: string;
    text: string;
  }>;
  variable_bindings: VariableBindingRequest[];
  references: Array<{ asset_id: string }>;
  seeds: {
    mode: "fixed" | "explicit";
    values: number[];
  };
  workflow: JsonObject;
  workflow_profile: JsonObject;
}

export interface ComfyUIStatusResponse {
  reachable: boolean;
  version: string | null;
  devices: string[];
  diagnostic: string | null;
}

export interface AssetResponse {
  asset_id: string;
  original_filename: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  created_at: string;
  content_url: string;
}

export interface AssetsResponse {
  assets: AssetResponse[];
}

export interface ProjectResponse {
  id: string;
  name: string;
  filesystem_key: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface ProjectsResponse {
  projects: ProjectResponse[];
}

export interface ProjectCreateRequest {
  name: string;
  filesystem_key: string;
  description?: string | null;
}

export interface ProjectUpdateRequest {
  name?: string;
  description?: string | null;
}

export interface ProjectAdoptRequest {
  filesystem_key: string;
  project_id?: string | null;
  name?: string | null;
  description?: string | null;
}

export interface AdoptableProject {
  filesystem_key: string;
  owner_state: "owned" | "ownerless";
  project_id: string | null;
  initial_name: string | null;
}

export interface AdoptableProjectsResponse {
  projects: AdoptableProject[];
}

export interface Prompt {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface LibraryPromptVersion {
  id: string;
  prompt_id: string;
  version_number: number;
  name_snapshot: string;
  text: string;
  note: string | null;
  created_at: string;
  archived_at: string | null;
}

export interface ProjectPrompt extends Prompt {
  latest_active_version: LibraryPromptVersion | null;
}

export interface PromptsResponse {
  prompts: ProjectPrompt[];
}

export interface PromptVersionsResponse {
  prompt_versions: LibraryPromptVersion[];
}

export interface CreatePromptRequest {
  name: string;
  description?: string | null;
  text: string;
  note?: string | null;
}

export interface CreatePromptResponse {
  prompt: Prompt;
  version: LibraryPromptVersion;
}

export interface CreatePromptVersionRequest {
  text: string;
  note?: string | null;
}

export type CreatePromptVersionResponse = LibraryPromptVersion;

export interface PromptUpdateRequest {
  name?: string;
  description?: string | null;
}

export interface CompilationWarningResponse {
  code: string;
  message: string;
  placeholder: string;
}

export interface JobPreviewResponse {
  ordinal: number;
  prompt_version_id: string;
  prompt_version_name: string;
  resolved_prompt: string;
  resolved_variables: Array<{ name: string; value: string }>;
  reference_asset_id: string | null;
  seed: number;
}

export interface PreviewResponse {
  job_count: number;
  warnings: CompilationWarningResponse[];
  jobs: JobPreviewResponse[];
}

export interface RunCreatedResponse {
  run_id: string;
  run_number: number;
  project_id: string;
  project_name: string;
  batch_id: string;
  batch_name: string;
  job_count: number;
  durable_status: string;
}

export interface RunResponse extends RunCreatedResponse {
  created_at: string;
  prompt_versions: Array<{ id: string; name: string; text: string }>;
  jobs: Array<{ ordinal: number; prompt_version_id: string }>;
  execution: ExecutionResponse;
}

export type RunStatus = "created" | "running" | "succeeded" | "failed" | "blocked";

export interface JobExecutionResponse {
  ordinal: number;
  status: string;
  prompt_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  diagnostics: string[];
  result_count: number;
}

export interface ExecutionResponse {
  run_id: string;
  status: RunStatus;
  started_at: string | null;
  completed_at: string | null;
  current_job_ordinal: number | null;
  error: string | null;
  diagnostics: string[];
  jobs: JobExecutionResponse[];
}

export interface ExecutionStartedResponse {
  run_id: string;
  status: string;
}

export interface ResultResponse {
  job_ordinal: number;
  artifact_ordinal: number;
  producing_node_id: string;
  output_name: string;
  remote_filename: string;
  content_type: string | null;
  byte_size: number;
  sha256: string;
  download_url: string;
}

export interface ResultsResponse {
  run_id: string;
  results: ResultResponse[];
}

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
  };
}
