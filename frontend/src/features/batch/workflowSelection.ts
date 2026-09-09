import type { Workflow, WorkflowProfile, LibraryWorkflowVersion, LibraryWorkflowProfileVersion } from "../../api/types";
import { reconcileFormBindings, type BatchFormState } from "./form";

export function applyProfile(form: BatchFormState, profile: WorkflowProfile, version: LibraryWorkflowProfileVersion): BatchFormState {
  const profileJson = JSON.stringify(version.profile, null, 2);
  return reconcileFormBindings({ ...form, workflowProfileId: profile.id, workflowProfileName: profile.name, workflowProfileVersionId: version.id, workflowProfileVersionNumber: version.version_number, workflowProfileWorkflowVersionId: version.workflow_version_id, workflowProfileContentSha256: version.content_sha256, workflowProfileJson: profileJson, historicalProfileVersionId: null, historicalProfileResourceStatus: null, historicalProfileResourceReason: null, historicalImportCopyResolutions: { ...form.historicalImportCopyResolutions, workflowProfileVersion: null } }, profileJson);
}

export function applyWorkflow(form: BatchFormState, projectId: string, workflow: Workflow, version: LibraryWorkflowVersion): BatchFormState {
  return {
    ...clearProfileSelectionAndSnapshot(detach(form)),
    workflowLibraryProjectId: projectId,
    workflowId: workflow.id,
    workflowName: workflow.name,
    workflowVersionId: version.id,
    workflowVersionNumber: version.version_number,
    workflowContentSha256: version.content_sha256,
    workflowJson: JSON.stringify(version.workflow, null, 2),
  };
}

export function clearProfileLink(form: BatchFormState): BatchFormState {
  return { ...form, workflowProfileId: null, workflowProfileName: "", workflowProfileVersionId: null, workflowProfileVersionNumber: null, workflowProfileWorkflowVersionId: null, workflowProfileContentSha256: null, historicalProfileVersionId: null, historicalProfileResourceStatus: null, historicalProfileResourceReason: null, historicalImportCopyResolutions: { ...form.historicalImportCopyResolutions, workflowProfileVersion: null } };
}

export function clearProfileSelectionAndSnapshot(form: BatchFormState): BatchFormState {
  return { ...clearProfileLink(form), workflowProfileJson: "{}", imageBindings: [], parameterBindings: [], linkedParameterSets: [] };
}

export function detach(form: BatchFormState): BatchFormState {
  return { ...clearProfileLink(form), workflowLibraryProjectId: null, workflowId: null, workflowName: "", workflowVersionId: null, workflowVersionNumber: null, workflowContentSha256: null, historicalWorkflowVersionId: null, historicalWorkflowResourceStatus: null, historicalWorkflowResourceReason: null, historicalImportCopyResolutions: { ...form.historicalImportCopyResolutions, workflowVersion: null, workflowProfileVersion: null } };
}
