import { vi } from "vitest";
import type { BatchcraftApi, LibraryApi } from "../api/client";
import type { GlobalCatalogItem, GlobalCopyResponse, GlobalProfileFamily, GlobalProfileMetadata, GlobalWorkflowVersion, ProjectCopyResponse } from "../api/types";

const metadata = { created_at: "2026-09-09T10:00:00Z", updated_at: "2026-09-09T10:00:00Z", archived_at: null, description: null };
export const globalWorkflow: GlobalCatalogItem = { ...metadata, id: "global-w", name: "Reusable portrait", source: {}, latest_version_id: "global-w-v1" };
export const globalVersion: GlobalWorkflowVersion = {
  id: "global-w-v1", workflow_id: "global-w", version_number: 1, name_snapshot: "Reusable portrait", note: null, created_at: metadata.created_at, archived_at: null, content_sha256: "a".repeat(64),
  workflow: { "1": { class_type: "TestNode", inputs: { text: "", seed: 1, filename_prefix: "test", image: "base.png" } } },
};
export const globalProfile: GlobalProfileMetadata = {
  id: "global-p-v1", workflow_profile_id: "global-p", workflow_id: "global-w", workflow_version_id: "global-w-v1", version_number: 1, name_snapshot: "Portrait mapping", name: "Portrait mapping", description: null, content_sha256: "b".repeat(64), created_at: metadata.created_at,
};
export const copiedSetup: ProjectCopyResponse = {
  request_id: "receipt", source: {},
  workflow: { workflow: { ...metadata, id: "copied-w", project_id: "project-1", name: "Reusable portrait" }, version: { ...globalVersion, id: "copied-w-v1", workflow_id: "copied-w", project_id: "project-1" } },
  profiles: [{ workflow_profile: { ...metadata, id: "copied-p", workflow_id: "copied-w", project_id: "project-1", name: "Portrait mapping" }, version: {
    ...globalProfile, id: "copied-p-v1", workflow_profile_id: "copied-p", workflow_id: "copied-w", workflow_version_id: "copied-w-v1", project_id: "project-1", note: null, archived_at: null,
    profile: { id: "copied-p", name: "Portrait mapping", mappings: { prompt: { node_id: "1", input_name: "text" }, seed: { node_id: "1", input_name: "seed" }, output_prefix: { node_id: "1", input_name: "filename_prefix" } }, image_inputs: [{ key: "source", label: "Source image", node_id: "1", input_name: "image" }], parameters: [] },
  } }],
};
export const importedSetup: GlobalCopyResponse = { request_id: "receipt", source: {}, workflow: { workflow: globalWorkflow, version: globalVersion }, profiles: [] };
export const globalProfileFamily: GlobalProfileFamily = { ...metadata, id: "global-p", workflow_id: "global-w", name: "Portrait mapping", latest_active_version_id: globalProfile.id, latest_compatible_version_id: globalProfile.id, latest_compatible_version: { ...globalProfile, note: null, archived_at: null } };

export function workflowLibraryApi(): LibraryApi & Partial<BatchcraftApi> {
  return {
    getGlobalWorkflow: vi.fn(async () => globalWorkflow),
    listGlobalWorkflowVersions: vi.fn(async () => ({ items: [globalVersion], next_cursor: null })),
    listGlobalProfileFamilies: vi.fn(async () => ({ items: [globalProfileFamily], next_cursor: null })),
    listGlobalProfileVersions: vi.fn(async () => ({ items: [{ ...globalProfile, note: null, archived_at: null }], next_cursor: null })),
    createGlobalWorkflow: vi.fn(async (body) => ({ workflow: { ...globalWorkflow, name: body.name, description: body.description ?? null }, version: { ...globalVersion, name_snapshot: body.name, workflow: body.workflow } })),
    appendGlobalWorkflow: vi.fn(async (_id, body) => ({ ...globalVersion, id: "global-w-v2", version_number: 2, workflow: body.workflow })),
    createGlobalProfile: vi.fn(async (_id, body) => ({ workflow_profile: { ...globalProfileFamily, name: body.name }, version: { ...globalProfile, note: null, archived_at: null, profile: { mappings: body.mappings, image_inputs: body.image_inputs, parameters: body.parameters } } })),
    appendGlobalProfile: vi.fn(async (_id, body) => ({ ...globalProfile, id: "global-p-v2", version_number: 2, note: null, archived_at: null, profile: { mappings: body.mappings, image_inputs: body.image_inputs, parameters: body.parameters } })),
    updateGlobalWorkflow: vi.fn(async (_id, body) => ({ ...globalWorkflow, ...body })),
    updateGlobalProfile: vi.fn(async (_id, body) => ({ ...globalProfileFamily, ...body })),
    archiveGlobalEntry: vi.fn(async () => globalWorkflow),
    browseGlobalWorkflows: vi.fn(async () => ({ items: [globalWorkflow], next_cursor: null })),
    getGlobalWorkflowVersion: vi.fn(async () => globalVersion),
    browseGlobalProfiles: vi.fn(async () => ({ items: [globalProfile], next_cursor: null })),
    getGlobalProfileVersion: vi.fn(async () => ({ ...globalProfile, profile: copiedSetup.profiles[0].version.profile, note: null, archived_at: null })),
    importProjectSetup: vi.fn(async (body) => ({ ...importedSetup, request_id: body.request_id })),
    useGlobalSetup: vi.fn(async (body) => ({ ...copiedSetup, request_id: body.request_id })),
    listProjects: vi.fn(async () => ({ projects: [{ ...metadata, id: "project-1", name: "Source Project", filesystem_key: "project_1" }, { ...metadata, id: "project-2", name: "Other Project", filesystem_key: "project_2" }] })),
    listWorkflows: vi.fn(async () => ({ workflows: [{ ...copiedSetup.workflow.workflow, latest_active_version: copiedSetup.workflow.version }] })),
    getWorkflow: vi.fn(async () => copiedSetup.workflow.workflow),
    getWorkflowVersion: vi.fn(async () => copiedSetup.workflow.version),
    listWorkflowVersions: vi.fn(async () => ({ workflow_versions: [copiedSetup.workflow.version] })),
    listWorkflowProfiles: vi.fn(async () => ({ workflow_profiles: copiedSetup.profiles.map((item) => ({ ...item.workflow_profile, latest_compatible_version: item.version })) })),
    getWorkflowProfile: vi.fn(async () => copiedSetup.profiles[0].workflow_profile),
    getWorkflowProfileVersion: vi.fn(async () => copiedSetup.profiles[0].version),
    listWorkflowProfileVersions: vi.fn(async () => ({ workflow_profile_versions: [copiedSetup.profiles[0].version] })),
  };
}
