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
  batch_snapshot: EditableBatchSnapshot;
}

export interface EditableBatchSnapshot {
  snapshot_version: 1;
  project: IdentityRequest;
  source_saved_batch: { id: string; revision: number } | null;
  batch: IdentityRequest & { description: string | null };
  prompt_versions: Array<{
    id: string;
    prompt_id: string | null;
    version_number: number | null;
    name: string;
    text: string;
  }>;
  variable_bindings: VariableBindingRequest[];
  references: Array<{ asset_id: string }>;
  seed_intent: SavedBatchSeedIntent;
  workflow_selection: {
    workflow_id: string | null;
    workflow_version_id: string | null;
    workflow_profile_id: string | null;
    workflow_profile_version_id: string | null;
    workflow: JsonObject;
    workflow_profile: JsonObject;
  };
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

export interface SavedBatchPromptSelection {
  prompt_version_id: string;
  name_snapshot: string;
  text: string;
  prompt_id: string | null;
  prompt_name: string | null;
  version_number: number | null;
  prompt_archived_at: string | null;
  version_archived_at: string | null;
}

export interface SavedBatchVariableBinding {
  placeholder: string;
  variable_list_id: string;
  values: string[];
  selected_values: string[];
  mode: "all" | "fixed";
  fixed_value: string | null;
}

export interface SavedBatchSeedIntent {
  mode: "fixed" | "explicit" | "random";
  values: number[];
  random_seed_count: number | null;
}

export interface SavedBatchWorkflowVersion {
  id: string;
  content_sha256: string;
  workflow: JsonObject;
  workflow_id: string | null;
  workflow_name: string | null;
  version_number: number | null;
  name_snapshot: string | null;
  workflow_archived_at: string | null;
  version_archived_at: string | null;
}

export interface SavedBatchWorkflowProfileVersion {
  id: string;
  workflow_profile_id: string;
  workflow_version_id: string;
  content_sha256: string;
  profile: JsonObject;
  workflow_profile_name: string | null;
  version_number: number | null;
  name_snapshot: string | null;
  workflow_profile_archived_at: string | null;
  version_archived_at: string | null;
}

export interface SavedBatchDefinitionRequest {
  name: string;
  description: string | null;
  prompt_selections: SavedBatchPromptSelection[];
  variable_bindings: SavedBatchVariableBinding[];
  reference_selections: Array<{ asset_id: string }>;
  seed_intent: SavedBatchSeedIntent;
  selected_workflow_version: SavedBatchWorkflowVersion | null;
  selected_workflow_profile_id: string | null;
  selected_workflow_profile_version: SavedBatchWorkflowProfileVersion | null;
}

export interface SavedBatchCreateRequest extends SavedBatchDefinitionRequest {
  filesystem_key: string;
}

export interface SavedBatchAdoptRequest extends SavedBatchCreateRequest {
  batch_id: string | null;
}

export interface SavedBatchUpdateRequest extends SavedBatchDefinitionRequest {
  expected_revision: number;
}

export interface SavedBatchListItem {
  id: string;
  project_id: string;
  filesystem_key: string;
  name: string;
  revision: number;
  updated_at: string;
  archived_at: string | null;
}

export interface SavedBatchDetail extends SavedBatchListItem {
  description: string | null;
  seed_mode: SavedBatchSeedIntent["mode"];
  seed_values: number[];
  random_seed_count: number | null;
  selected_workflow_version_id: string | null;
  selected_workflow_profile_id: string | null;
  selected_workflow_profile_version_id: string | null;
  selected_workflow_profile_name: string | null;
  selected_workflow_profile_archived_at: string | null;
  created_at: string;
  prompt_selections: SavedBatchPromptSelection[];
  variable_bindings: SavedBatchVariableBinding[];
  reference_selections: Array<{ asset_id: string }>;
  selected_workflow_version: SavedBatchWorkflowVersion | null;
  selected_workflow_profile_version: SavedBatchWorkflowProfileVersion | null;
}

export interface SavedBatchesResponse {
  batches: SavedBatchListItem[];
}

export interface AdoptableBatch {
  filesystem_key: string;
  owner_state: "owned" | "ownerless";
  batch_id: string | null;
  initial_name: string | null;
}

export interface AdoptableBatchesResponse {
  batches: AdoptableBatch[];
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

export interface Workflow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface LibraryWorkflowVersion {
  id: string;
  workflow_id: string;
  project_id: string;
  version_number: number;
  name_snapshot: string;
  workflow: JsonObject;
  content_sha256: string;
  note: string | null;
  created_at: string;
  archived_at: string | null;
}

export interface ProjectWorkflow extends Workflow {
  latest_active_version: LibraryWorkflowVersion | null;
}

export interface WorkflowsResponse {
  workflows: ProjectWorkflow[];
}

export interface CreateWorkflowRequest {
  name: string;
  description?: string | null;
  workflow: JsonObject;
  note?: string | null;
}

export interface CreateWorkflowResponse {
  workflow: Workflow;
  version: LibraryWorkflowVersion;
}

export interface CreateWorkflowVersionRequest {
  workflow: JsonObject;
  note?: string | null;
}

export interface WorkflowUpdateRequest {
  name?: string;
  description?: string | null;
}

export interface WorkflowVersionsResponse {
  workflow_versions: LibraryWorkflowVersion[];
}

export interface WorkflowProfile {
  id: string;
  workflow_id: string;
  project_id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface LibraryWorkflowProfileVersion {
  id: string;
  workflow_profile_id: string;
  workflow_id: string;
  project_id: string;
  workflow_version_id: string;
  version_number: number;
  name_snapshot: string;
  profile: JsonObject;
  content_sha256: string;
  note: string | null;
  created_at: string;
  archived_at: string | null;
}

export interface ProjectWorkflowProfile extends WorkflowProfile {
  latest_compatible_version: LibraryWorkflowProfileVersion | null;
}

export interface WorkflowProfilesResponse {
  workflow_profiles: ProjectWorkflowProfile[];
}

export interface CreateWorkflowProfileRequest {
  name: string;
  description?: string | null;
  workflow_version_id: string;
  mappings: JsonObject;
  note?: string | null;
}

export interface CreateWorkflowProfileResponse {
  workflow_profile: WorkflowProfile;
  version: LibraryWorkflowProfileVersion;
}

export interface CreateWorkflowProfileVersionRequest {
  workflow_version_id: string;
  mappings: JsonObject;
  note?: string | null;
}

export interface WorkflowProfileUpdateRequest {
  name?: string;
  description?: string | null;
}

export interface WorkflowProfileVersionsResponse {
  workflow_profile_versions: LibraryWorkflowProfileVersion[];
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
