export type JsonObject = Record<string, unknown>;

export interface IdentityRequest {
  id: string;
  filesystem_key: string;
  name: string;
}

export interface VariableBindingRequest {
  placeholder: string;
  values: string[];
}

export interface ImageBindingRequest {
  slot_key: string;
  values: Array<string | null>;
}

export type ParameterValueType = "string" | "integer" | "float" | "boolean";
export type ParameterScalar = string | number | boolean;

export interface ParameterValuesBindingRequest {
  parameter_key: string;
  mode: "values";
  values: Array<ParameterScalar | null>;
}

export interface ParameterRangeBindingRequest {
  parameter_key: string;
  mode: "range";
  include_base: boolean;
  range: {
    start: string;
    end: string;
    step: string;
  };
}

export type ParameterBindingRequest = ParameterValuesBindingRequest | ParameterRangeBindingRequest;

export interface LinkedParameterRowRequest {
  row_label: string | null;
  values: Record<string, ParameterScalar | null>;
}

export interface LinkedParameterSetRequest {
  set_key: string;
  set_label: string;
  members: string[];
  rows: LinkedParameterRowRequest[];
}

export interface WorkflowProfileParameter {
  key: string;
  label: string;
  node_id: string;
  input_name: string;
  value_type: ParameterValueType;
}

export interface WorkflowProfileImageInput {
  key: string;
  label: string;
  node_id: string;
  input_name: string;
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
  image_bindings: ImageBindingRequest[];
  parameter_bindings: ParameterBindingRequest[];
  linked_parameter_sets: LinkedParameterSetRequest[];
  seeds:
    | { mode: "fixed" | "explicit"; values: number[]; random_seed_count?: null }
    | { mode: "random"; values: number[]; random_seed_count: number };
  workflow: JsonObject;
  workflow_profile: JsonObject;
  batch_snapshot: EditableBatchSnapshot;
}

export interface RunCreateRequest extends BatchRequest {
  run_name: string | null;
  run_description: string | null;
}

export interface EditableBatchSnapshot {
  format: "batchcraft.batch-snapshot";
  format_version: 1;
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
  image_bindings: ImageBindingRequest[];
  parameter_bindings: ParameterBindingRequest[];
  linked_parameter_sets: LinkedParameterSetRequest[];
  seed_intent: SavedBatchSeedIntent;
  workflow_selection: {
    workflow_id: string | null;
    workflow_version_id: string | null;
    workflow_name: string | null;
    workflow_version_number: number | null;
    workflow_profile_id: string | null;
    workflow_profile_version_id: string | null;
    workflow_profile_name: string | null;
    workflow_profile_version_number: number | null;
    workflow: JsonObject;
    workflow_profile: JsonObject;
  };
}

export type BatchReconstructionResourceStatus = "linked" | "detached" | "conflict";

export interface BatchReconstructionResource {
  historical_version_id: string | null;
  status: BatchReconstructionResourceStatus;
  reason: string | null;
  linked_version_id: string | null;
  linked_resource_id: string | null;
}

export interface BatchReconstructionResponse {
  run_id: string;
  batch_snapshot: EditableBatchSnapshot;
  resources: {
    prompt_versions: Array<BatchReconstructionResource & { position: number }>;
    workflow_version: BatchReconstructionResource;
    workflow_profile_version: BatchReconstructionResource;
  };
}

export interface HistoricalResourceImportRequest {
  import_request_id: string;
  name: string;
  description: string | null;
  note: string | null;
}

export interface HistoricalWorkflowProfileImportRequest extends HistoricalResourceImportRequest {
  workflow_version_id: string;
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

export interface ProjectImportRequest {
  filesystem_key: string;
}

export interface ProjectImportResponse {
  project_id: string;
  filesystem_key: string;
  name: string;
  batch_count: number;
  asset_count: number;
  run_count: number;
  diagnostic_count: number;
}

export interface HistoryDiagnosticResponse {
  scope: string;
  filesystem_key: string | null;
  entity_id: string | null;
  code: string;
  message: string;
}

export interface HistoricalRunResponse {
  run_id: string;
  batch_id: string;
  batch_filesystem_key: string;
  batch_name: string;
  run_number: number;
  filesystem_key: string;
  run_name: string | null;
  run_description: string | null;
  created_at: string;
  job_count: number;
  execution_available: boolean;
  execution_status: string | null;
  started_at: string | null;
  completed_at: string | null;
  integrity_status: "verified" | "degraded";
  replayable: boolean;
}

export interface ProjectRunsResponse {
  project_id: string;
  runs: HistoricalRunResponse[];
  diagnostics: HistoryDiagnosticResponse[];
}

export interface HistoryQuery {
  limit?: number;
  cursor?: string | null;
  sort?: "newest" | "oldest";
  q?: string;
  run_id?: string | null;
  batch_id?: string | null;
  execution_status?: RunStatus | null;
  execution_available?: boolean | null;
}

export interface HistoryRunSummaryResponse {
  run_id: string;
  batch_id: string;
  batch_name: string;
  run_number: number;
  run_name: string | null;
  run_description_excerpt: string | null;
  display_truncated: boolean;
  created_at: string;
  job_count: number;
  execution_available: boolean;
  execution_status: string | null;
  integrity_status: string;
  replayable: boolean;
}

export interface HistoryRunItemResponse {
  run: HistoryRunSummaryResponse;
  result_count: number;
}

export interface HistoryResultItemResponse {
  run: HistoryRunSummaryResponse;
  job_id: string;
  job_ordinal: number;
  artifact_ordinal: number;
  filename_excerpt: string;
  filename_truncated: boolean;
  content_type: string | null;
  byte_size: number;
  sha256: string;
  integrity_status: string;
  download_url: string | null;
  download_unavailable_reason:
    | "execution_unavailable"
    | "artifact_unavailable"
    | "unaddressable_run_id"
    | null;
}

export interface HistoryRunPageResponse {
  project_id: string;
  generation: string | null;
  scanned_at: string | null;
  items: HistoryRunItemResponse[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface HistoryResultPageResponse {
  project_id: string;
  generation: string | null;
  scanned_at: string | null;
  items: HistoryResultItemResponse[];
  next_cursor: string | null;
  has_more: boolean;
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
  values: string[];
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
  image_bindings: ImageBindingRequest[];
  parameter_bindings: ParameterBindingRequest[];
  linked_parameter_sets: LinkedParameterSetRequest[];
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
  image_bindings: ImageBindingRequest[];
  parameter_bindings: ParameterBindingRequest[];
  linked_parameter_sets: LinkedParameterSetRequest[];
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
  placeholders: string[];
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
  image_inputs: WorkflowProfileImageInput[];
  parameters: WorkflowProfileParameter[];
  note?: string | null;
}

export interface CreateWorkflowProfileResponse {
  workflow_profile: WorkflowProfile;
  version: LibraryWorkflowProfileVersion;
}

export interface CreateWorkflowProfileVersionRequest {
  workflow_version_id: string;
  mappings: JsonObject;
  image_inputs: WorkflowProfileImageInput[];
  parameters: WorkflowProfileParameter[];
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
  resolved_image_inputs: ResolvedImageInputResponse[];
  resolved_parameters: ResolvedParameterResponse[];
  resolved_parameter_sets: ResolvedParameterSetResponse[];
  seed: number;
}

export interface ResolvedImageInputResponse {
  slot_key: string;
  label: string;
  asset_id: string | null;
  filename: string | null;
}

export interface ResolvedParameterResponse {
  parameter_key: string;
  label: string;
  value: ParameterScalar | null;
}

export interface ResolvedParameterSetResponse {
  set_key: string;
  set_label: string;
  row_ordinal: number;
  row_label: string | null;
}

export interface PreviewResponse {
  job_count: number;
  warnings: CompilationWarningResponse[];
  jobs: JobPreviewResponse[];
}

export interface RunCreatedResponse {
  run_id: string;
  run_number: number;
  run_name: string | null;
  run_description: string | null;
  filesystem_key: string;
  project_id: string;
  project_name: string;
  batch_id: string;
  batch_name: string;
  job_count: number;
  durable_status: string;
}

export interface ActiveExecutionResponse {
  run_id: string | null;
}

export interface RunResponse extends RunCreatedResponse {
  created_at: string;
  prompt_versions: Array<{ id: string; name: string; text: string }>;
  jobs: Array<{ ordinal: number; prompt_version_id: string }>;
  plan: RunPlanResponse;
  batch_snapshot: EditableBatchSnapshot;
  execution: ExecutionResponse;
}

export type RunPlanJobResponse = JobPreviewResponse;

export interface RunPlanResponse {
  job_count: number;
  warnings: CompilationWarningResponse[];
  jobs: RunPlanJobResponse[];
}

export type RunStatus = "created" | "running" | "succeeded" | "failed" | "blocked" | "cancelled";

export type JobStatus =
  | "pending"
  | "preparing"
  | "submitting"
  | "submission_unknown"
  | "submitted"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface JobExecutionResponse {
  ordinal: number;
  status: JobStatus;
  prompt_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  diagnostics: string[];
  result_count: number;
}

export type RunCancellationState =
  | "stop_requested"
  | "stopping_after_current_job"
  | "detach_requested"
  | "detached"
  | "cancelled"
  | "finished";

export interface RunCancellationResponse {
  mode: "after_current_job" | "detach";
  requested_at: string | null;
  state: RunCancellationState;
}

export interface RunCancellationRequestedResponse extends RunCancellationResponse {
  run_id: string;
  created: boolean;
}

export interface ExecutionResponse {
  run_id: string;
  status: RunStatus;
  execution_task_active: boolean;
  started_at: string | null;
  completed_at: string | null;
  current_job_ordinal: number | null;
  error: string | null;
  diagnostics: string[];
  jobs: JobExecutionResponse[];
  cancellation?: RunCancellationResponse | null;
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
  integrity_status: "verified" | "missing" | "corrupt";
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
