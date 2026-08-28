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
  prompt_version: {
    id: string;
    text: string;
  };
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

export interface CompilationWarningResponse {
  code: string;
  message: string;
  placeholder: string;
}

export interface JobPreviewResponse {
  ordinal: number;
  resolved_prompt: string;
  resolved_variables: Array<{ name: string; value: string }>;
  reference_asset_id: string;
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
