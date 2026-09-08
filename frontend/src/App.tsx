import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  ApiError,
  apiClient,
  type BatchcraftApi,
  type RunCancellationApi,
  type RunDiscardApi,
} from "./api/client";
import type {
  BatchRequest,
  EditableBatchSnapshot,
  ExecutionResponse,
  PreviewResponse,
  ProjectResponse,
  ResultResponse,
  RunCreatedResponse,
  RunResponse,
  RunStatus,
  SavedBatchDetail,
} from "./api/types";
import { BatchEditor } from "./features/batch/BatchEditor";
import { PreviewPanel } from "./features/batch/PreviewPanel";
import {
  buildBatchRequest,
  buildEditableBatchSnapshot,
  editableBatchSnapshotToForm,
  editableBatchSnapshotIdentity,
  initialBatchForm,
  reconcileFormBindings,
  restoreHistoricalResourceState,
  withMaterializedRandomSeeds,
  type BatchFormState,
} from "./features/batch/form";
import {
  buildSavedBatchCreate,
  buildSavedBatchUpdate,
  canonicalBatchIntent,
  savedBatchToForm,
} from "./features/batch/savedBatch";
import type { SavedBatchCreateInput } from "./features/batch/SavedBatchSelector";
import { ProjectBrowser } from "./features/project/ProjectBrowser";
import { useWorkspaceNavigation } from "./features/project/useWorkspaceNavigation";
import { RunWorkspace } from "./features/run/RunWorkspace";
import {
  loadWorkingSessionRecovery,
  saveWorkingSessionRecovery,
} from "./features/session/workingSessionRecovery";
import { ComfyUIStatus } from "./features/status/ComfyUIStatus";
import { SettingsMenu } from "./features/settings/SettingsMenu";
import { errorMessage } from "./utils/errors";

interface Props {
  api?: BatchcraftApi & RunDiscardApi & RunCancellationApi;
  pollIntervalMs?: number;
}

interface PreviewSnapshot {
  request: BatchRequest;
  response: PreviewResponse;
  formRevision: number;
  singleUse: boolean;
}

interface RestoredRunSeed {
  runId: string;
  execution: ExecutionResponse;
  results: ResultResponse[];
  resultsError: string | null;
}

interface PreviewRunAssociation {
  runId: string;
  runNumber: number;
  consistent: boolean;
}

interface SavedBatchLink {
  id: string;
  revision: number;
  baseline: string;
}

interface SavedBatchRecoveryPointer {
  id: string;
  revision: number;
}

interface SavedBatchConflict {
  kind: "save" | "session";
  batchId: string;
}

interface RunSnapshotIdentity {
  runId: string;
  snapshot: EditableBatchSnapshot;
}

const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "blocked", "cancelled"]);
const EMPTY_RESULTS: ResultResponse[] = [];
const RESTORED_DRAFT_MESSAGE = "Draft restored from this browser. Preview to verify the Job plan.";

export default function App({ api = apiClient, pollIntervalMs = 1000 }: Props) {
  const navigation = useWorkspaceNavigation();
  const [initialSession] = useState(loadWorkingSessionRecovery);
  const [form, setForm] = useState<BatchFormState>(initialSession.form);
  const [historicalSourceRunId, setHistoricalSourceRunId] = useState<string | null>(
    initialSession.sourceRunId,
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    initialSession.selectedProjectId,
  );
  const [projectVerified, setProjectVerified] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | null>(initialSession.currentRunId);
  const [previewSnapshot, setPreviewSnapshot] = useState<PreviewSnapshot | null>(null);
  const [run, setRun] = useState<RunCreatedResponse | RunResponse | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [historyRevisions, setHistoryRevisions] = useState<Record<string, number>>({});
  function onHistoryChange(projectId: string) {
    setHistoryRevisions((current) => ({ ...current, [projectId]: (current[projectId] ?? 0) + 1 }));
  }
  const [createdUnavailableRunId, setCreatedUnavailableRunId] = useState<string | null>(null);
  const [executionControlUnavailableRunId, setExecutionControlUnavailableRunId] =
    useState<string | null>(null);
  const [runSnapshotIdentity, setRunSnapshotIdentity] = useState<RunSnapshotIdentity | null>(null);
  const [restoredRunSeed, setRestoredRunSeed] = useState<RestoredRunSeed | null>(null);
  const [previewRunAssociation, setPreviewRunAssociation] =
    useState<PreviewRunAssociation | null>(null);
  const [runName, setRunName] = useState("");
  const [runDescription, setRunDescription] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [restoringRun, setRestoringRun] = useState(true);
  const [runRestoreUnresolved, setRunRestoreUnresolved] = useState(false);
  const [sessionMessage, setSessionMessage] = useState<string | null>(
    initialSession.draftRestored
      ? RESTORED_DRAFT_MESSAGE
      : null,
  );
  const [batchError, setBatchError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [consistencyError, setConsistencyError] = useState<string | null>(null);
  const [savedBatchLink, setSavedBatchLink] = useState<SavedBatchLink | null>(null);
  const [savedBatchRecoveryPointer, setSavedBatchRecoveryPointer] =
    useState<SavedBatchRecoveryPointer | null>(() => (
      initialSession.selectedSavedBatchId && initialSession.savedBatchBaseRevision
        ? {
          id: initialSession.selectedSavedBatchId,
          revision: initialSession.savedBatchBaseRevision,
        }
        : null
    ));
  const [savedBatchConflict, setSavedBatchConflict] = useState<SavedBatchConflict | null>(null);
  const [savingBatch, setSavingBatch] = useState(false);
  const [savedBatchListRefresh, setSavedBatchListRefresh] = useState(0);
  const [saveAsRequest, setSaveAsRequest] = useState(false);
  const [savedBatchRestorePending, setSavedBatchRestorePending] = useState(
    initialSession.selectedSavedBatchId !== null,
  );
  const [snapshotRecoveryPending, setSnapshotRecoveryPending] = useState(
    initialSession.workflowSnapshotRecoveryRequired ||
      initialSession.profileSnapshotRecoveryRequired,
  );
  const formRevision = useRef(0);
  const batchReplacementGeneration = useRef(0);
  const runRevision = useRef(0);
  const frozenRunCache = useRef(new Map<string, RunResponse>());
  const frozenRunRequests = useRef(new Map<string, Promise<RunResponse>>());
  const currentBatchIdentity = batchIdentity(form);
  const currentBatchIdentityRef = useRef(currentBatchIdentity);
  const projectContextRef = useRef({ selectedProjectId, projectVerified });
  const historicalSourceRunIdRef = useRef(historicalSourceRunId);
  const recoveredHistoricalRun = useRef<string | null>(null);
  const currentRunIdRef = useRef(currentRunId);
  const monitoredRunIdRef = useRef<string | null>(null);

  const cacheFrozenRun = useCallback((frozenRun: RunResponse) => {
    frozenRunCache.current.set(frozenRun.run_id, frozenRun);
    if (frozenRunCache.current.size > 20) {
      const oldest = frozenRunCache.current.keys().next().value;
      if (oldest) frozenRunCache.current.delete(oldest);
    }
    return frozenRun;
  }, []);

  const getCachedFrozenRun = useCallback((runId: string) => {
    return frozenRunCache.current.get(runId) ?? null;
  }, []);

  const changeCreatedUnavailable = useCallback((runId: string, unavailable: boolean) => {
    setCreatedUnavailableRunId((current) => unavailable
      ? runId
      : current === runId ? null : current);
  }, []);

  const changeExecutionControlUnavailable = useCallback((runId: string, unavailable: boolean) => {
    setExecutionControlUnavailableRunId((current) => unavailable
      ? runId
      : current === runId ? null : current);
  }, []);

  const loadFrozenRun = useCallback((runId: string) => {
    const cached = frozenRunCache.current.get(runId);
    if (cached) {
      return Promise.resolve(cached);
    }
    const pending = frozenRunRequests.current.get(runId);
    if (pending) {
      return pending;
    }
    const request = api.getRun(runId).then(
      (frozenRun) => {
        frozenRunRequests.current.delete(runId);
        return cacheFrozenRun(frozenRun);
      },
      (error: unknown) => {
        frozenRunRequests.current.delete(runId);
        throw error;
      },
    );
    frozenRunRequests.current.set(runId, request);
    return request;
  }, [api, cacheFrozenRun]);

  const recoveryStateRef = useRef({
    form,
    currentRunId,
    selectedProjectId,
    savedBatchRecoveryPointer,
    historicalSourceRunId,
  });
  const persistRecovery = useCallback(() => {
    const state = recoveryStateRef.current;
    saveWorkingSessionRecovery(
      state.form,
      state.currentRunId,
      state.selectedProjectId,
      undefined,
      state.savedBatchRecoveryPointer?.id ?? null,
      state.savedBatchRecoveryPointer?.revision ?? null,
      state.historicalSourceRunId,
    );
  }, []);

  useEffect(() => {
    persistRecovery();
  }, [currentRunId, form, historicalSourceRunId, persistRecovery, savedBatchRecoveryPointer, selectedProjectId]);

  useEffect(() => {
    window.addEventListener("pagehide", persistRecovery);
    return () => window.removeEventListener("pagehide", persistRecovery);
  }, [persistRecovery]);

  const formRef = useRef(form);

  // Publish committed draft pointers before passive recovery effects and browser events read them.
  useLayoutEffect(() => {
    currentBatchIdentityRef.current = currentBatchIdentity;
    projectContextRef.current = { selectedProjectId, projectVerified };
    historicalSourceRunIdRef.current = historicalSourceRunId;
    currentRunIdRef.current = currentRunId;
    formRef.current = form;
    recoveryStateRef.current = {
      form, currentRunId, selectedProjectId, savedBatchRecoveryPointer, historicalSourceRunId,
    };
  }, [currentBatchIdentity, currentRunId, form, historicalSourceRunId, projectVerified, savedBatchRecoveryPointer, selectedProjectId]);

  useEffect(() => {
    if (!snapshotRecoveryPending || !projectVerified) return;
    if (!selectedProjectId || selectedProjectId !== formRef.current.projectId) {
      setSnapshotRecoveryPending(false);
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const current = formRef.current;
        const requestedSelection = {
          projectId: current.projectId,
          workflowId: current.workflowId,
          workflowVersionId: current.workflowVersionId,
          workflowProfileId: current.workflowProfileId,
          workflowProfileVersionId: current.workflowProfileVersionId,
        };
        const [workflowVersion, profileVersion] = await Promise.all([
          initialSession.workflowSnapshotRecoveryRequired && current.workflowVersionId
            ? api.getWorkflowVersion(current.workflowVersionId, controller.signal)
            : null,
          initialSession.profileSnapshotRecoveryRequired && current.workflowProfileVersionId
            ? api.getWorkflowProfileVersion(current.workflowProfileVersionId, controller.signal)
            : null,
        ]);
        if (controller.signal.aborted) return;
        if (workflowVersion && (
          workflowVersion.id !== current.workflowVersionId ||
          workflowVersion.project_id !== current.projectId ||
          workflowVersion.workflow_id !== current.workflowId
        )) {
          throw new Error("The recovered WorkflowVersion does not match this Project and Workflow.");
        }
        if (profileVersion && (
          profileVersion.id !== current.workflowProfileVersionId ||
          profileVersion.project_id !== current.projectId ||
          profileVersion.workflow_id !== current.workflowId ||
          profileVersion.workflow_profile_id !== current.workflowProfileId ||
          profileVersion.workflow_version_id !== current.workflowVersionId
        )) {
          throw new Error("The recovered ProfileVersion does not match this Project and WorkflowVersion.");
        }
        setForm((latest) => {
          if (
            latest.projectId !== requestedSelection.projectId
            || latest.workflowId !== requestedSelection.workflowId
            || latest.workflowVersionId !== requestedSelection.workflowVersionId
            || latest.workflowProfileId !== requestedSelection.workflowProfileId
            || latest.workflowProfileVersionId !== requestedSelection.workflowProfileVersionId
          ) {
            return latest;
          }
          let recovered = {
            ...latest,
            workflowJson: workflowVersion
              ? JSON.stringify(workflowVersion.workflow, null, 2)
              : latest.workflowJson,
            workflowProfileJson: profileVersion
              ? JSON.stringify(profileVersion.profile, null, 2)
              : latest.workflowProfileJson,
          };
          if (profileVersion) {
            recovered = reconcileFormBindings(recovered, recovered.workflowProfileJson);
          }
          return recovered;
        });
      } catch (caught) {
        if (!isAbort(caught) && !controller.signal.aborted) {
          setSessionMessage(
            `The recovered Workflow/Profile snapshots could not be loaded. ${errorMessage(caught)}`,
          );
        }
      } finally {
        if (!controller.signal.aborted) setSnapshotRecoveryPending(false);
      }
    })();
    return () => controller.abort();
  }, [api, initialSession, projectVerified, selectedProjectId, snapshotRecoveryPending]);

  useEffect(() => {
    const sourceRunId = historicalSourceRunId;
    if (
      !sourceRunId
      || recoveredHistoricalRun.current === sourceRunId
      || !projectVerified
      || snapshotRecoveryPending
      || !selectedProjectId
      || selectedProjectId !== formRef.current.projectId
    ) return;
    const requestedProjectId = selectedProjectId;
    const controller = new AbortController();
    void Promise.all([
      api.getBatchReconstruction(sourceRunId, controller.signal),
      loadFrozenRun(sourceRunId),
    ]).then(([reconstruction, frozenRun]) => {
      if (
        controller.signal.aborted
        || historicalSourceRunIdRef.current !== sourceRunId
        || projectContextRef.current.selectedProjectId !== requestedProjectId
        || !projectContextRef.current.projectVerified
        || reconstruction.run_id !== sourceRunId
        || frozenRun.run_id !== sourceRunId
        || reconstruction.batch_snapshot.project.id !== requestedProjectId
        || frozenRun.batch_snapshot.project.id !== requestedProjectId
        || frozenRun.batch_snapshot.project.filesystem_key !== formRef.current.projectFilesystemKey
      ) return;
      setForm((current) => restoreHistoricalResourceState(current, reconstruction));
      recoveredHistoricalRun.current = sourceRunId;
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted && historicalSourceRunIdRef.current === sourceRunId) {
        setSessionMessage(`The historical Batch context could not be restored. ${errorMessage(caught)}`);
      }
    });
    return () => controller.abort();
  }, [api, historicalSourceRunId, loadFrozenRun, projectVerified, selectedProjectId, snapshotRecoveryPending]);

  useEffect(() => {
    if (!savedBatchRestorePending) return;
    if (!projectVerified || !selectedProjectId) return;
    if (selectedProjectId !== formRef.current.projectId) return;
    const batchId = initialSession.selectedSavedBatchId;
    if (!batchId) {
      return;
    }
    const baseRevision = initialSession.savedBatchBaseRevision;
    const project = projectSnapshot(formRef.current);
    const controller = new AbortController();
    void (async () => {
      try {
        const detail = await api.getSavedBatch(batchId, controller.signal);
        if (controller.signal.aborted) return;
        if (
          detail.project_id === project.id &&
          baseRevision !== null &&
          detail.revision === baseRevision
        ) {
          const baselineForm = savedBatchToForm(detail, project);
          setSavedBatchLink({
            id: detail.id,
            revision: detail.revision,
            baseline: canonicalBatchIntent(baselineForm),
          });
          setSavedBatchRecoveryPointer({ id: detail.id, revision: detail.revision });
        } else {
          setSavedBatchConflict({ kind: "session", batchId });
        }
      } catch (caught) {
        if (isAbort(caught) || controller.signal.aborted) return;
        if (caught instanceof ApiError && caught.code === "saved_batch_not_found") {
          setSavedBatchRecoveryPointer(null);
          setSessionMessage(
            "The Saved Batch for this browser draft was not found. The draft remains unsaved; use Save As to keep it.",
          );
        } else {
          setSessionMessage(
            `The Saved Batch for this browser draft could not be verified. ${errorMessage(caught)}`,
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          setSavedBatchRestorePending(false);
        }
      }
    })();
    return () => controller.abort();
  }, [api, initialSession, projectVerified, savedBatchRestorePending, selectedProjectId]);

  useEffect(() => {
    const controller = new AbortController();
    let inFlight: Promise<void> | null = null;
    let trailingRevalidation = false;

    async function hydrateRun(runId: string, discoveredActive: boolean, revision: number) {
      try {
        const [restoredRun, execution] = await Promise.all([
          retryTransient(() => api.getRun(runId, controller.signal), controller.signal),
          retryTransient(() => api.getExecution(runId, controller.signal), controller.signal),
        ]);
        if (restoredRun.run_id !== runId || execution.run_id !== runId) {
          throw new ApiError("Run lookup returned invalid identity data", "invalid_run_data", null);
        }
        if (
          controller.signal.aborted
          || revision !== runRevision.current
        ) return;

        cacheFrozenRun(restoredRun);
        const matchesDraft = runMatchesBatch(restoredRun, currentBatchIdentityRef.current);
        monitoredRunIdRef.current = runId;
        setRun(restoredRun);
        setRunStatus(execution.status);
        setRunSnapshotIdentity({ runId, snapshot: restoredRun.batch_snapshot });
        setRestoredRunSeed({ runId, execution, results: [], resultsError: null });
        setRunRestoreUnresolved(false);

        if (matchesDraft) {
          setCurrentRunId(runId);
        } else {
          setSessionMessage(
            discoveredActive
              ? "An active Run from another Project or Batch is being monitored. The current draft and saved Run pointer were left unchanged."
              : "The previous Run belongs to another Project or Batch and is being monitored independently. Its pointer and the current draft were retained.",
          );
        }

      } catch (caught) {
        if (isAbort(caught) || controller.signal.aborted || revision !== runRevision.current) return;
        const definitive = caught instanceof ApiError && (
          caught.code === "run_not_found" || caught.code === "invalid_run_data"
        );
        if (definitive && currentRunIdRef.current === runId) {
          setCurrentRunId(null);
        } else if (!definitive) {
          setRunRestoreUnresolved(true);
        }
        setSessionMessage(`The Run monitor could not be restored. ${errorMessage(caught)}`);
      }
    }

    function revalidate() {
      if (inFlight) {
        trailingRevalidation = true;
        return;
      }
      const revision = runRevision.current;
      setRestoringRun(true);
      inFlight = (async () => {
        try {
          const active = await retryTransient(
            () => api.getActiveExecution(controller.signal),
            controller.signal,
          );
          if (controller.signal.aborted || revision !== runRevision.current) return;
          const runId = active.run_id ?? currentRunIdRef.current ?? monitoredRunIdRef.current;
          if (runId) {
            await hydrateRun(runId, active.run_id === runId, revision);
          } else {
            setRunRestoreUnresolved(false);
          }
        } catch (caught) {
          if (!isAbort(caught) && !controller.signal.aborted && revision === runRevision.current) {
            setRunRestoreUnresolved(true);
            setSessionMessage(`Active Run discovery could not be completed. ${errorMessage(caught)}`);
          }
        } finally {
          inFlight = null;
          if (!controller.signal.aborted && revision === runRevision.current) {
            if (trailingRevalidation) {
              trailingRevalidation = false;
              revalidate();
            } else {
              setRestoringRun(false);
            }
          }
        }
      })();
    }

    const onPageShow = () => revalidate();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") revalidate();
    };
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibilityChange);
    revalidate();
    return () => {
      controller.abort();
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [api, cacheFrozenRun]);

  function changeForm(next: BatchFormState) {
    batchReplacementGeneration.current += 1;
    formRevision.current += 1;
    setForm(next);
    setPreviewSnapshot(null);
    setPreviewRunAssociation(null);
    setBatchError(null);
    setCreateError(null);
  }

  function changeHistoricalResourceForm(next: BatchFormState) {
    batchReplacementGeneration.current += 1;
    formRevision.current += 1;
    setForm(next);
    setPreviewSnapshot(null);
    setPreviewRunAssociation(null);
    setBatchError(null);
    setCreateError(null);
  }

  function changePromptMetadata(prompts: BatchFormState["prompts"]) {
    setForm((current) => ({ ...current, prompts }));
  }

  function changeWorkflowMetadata(next: BatchFormState) {
    setForm(next);
  }

  function reconnectProject(project: ProjectResponse) {
    setSelectedProjectId(project.id);
    setProjectVerified(true);
    setForm((current) => ({
      ...current,
      projectId: project.id,
      projectFilesystemKey: project.filesystem_key,
      projectName: project.name,
    }));
  }

  function markProjectUnresolved() {
    setProjectVerified(false);
    if (selectedProjectId) {
      setSessionMessage(
        "The draft Project is temporarily unavailable. Its draft and Run references were retained.",
      );
    }
  }

  function selectProject(project: ProjectResponse) {
    if (
      form.projectId.trim() === project.id &&
      form.projectFilesystemKey.trim() === project.filesystem_key
    ) {
      reconnectProject(project);
      return;
    }

    navigation.changeQuery({}, true);
    batchReplacementGeneration.current += 1;
    runRevision.current += 1;
    setSelectedProjectId(project.id);
    setProjectVerified(true);
    setCurrentRunId(null);
    setRun(null);
    setRunStatus(null);
    setRunSnapshotIdentity(null);
    setRestoredRunSeed(null);
    setRestoringRun(false);
    setRunRestoreUnresolved(false);
    setConsistencyError(null);
    setSessionMessage(null);
    setSavedBatchLink(null);
    setSavedBatchRecoveryPointer(null);
    setSavedBatchConflict(null);
    setSavedBatchRestorePending(false);
    setHistoricalSourceRunId(null);
    const fresh = initialBatchForm();
    changeForm({
      ...form,
      projectId: project.id,
      projectFilesystemKey: project.filesystem_key,
      projectName: project.name,
      batchId: fresh.batchId,
      batchFilesystemKey: fresh.batchFilesystemKey,
      batchName: fresh.batchName,
      batchDescription: fresh.batchDescription,
      prompts: [],
      imageBindings: [],
      parameterBindings: [],
      linkedParameterSets: [],
      workflowJson: "{}",
      workflowProfileJson: "{}",
      workflowLibraryProjectId: null,
      workflowId: null,
      workflowName: "",
      workflowVersionId: null,
      workflowVersionNumber: null,
      workflowContentSha256: null,
      workflowProfileId: null,
      workflowProfileName: "",
      workflowProfileVersionId: null,
      workflowProfileVersionNumber: null,
      workflowProfileWorkflowVersionId: null,
      workflowProfileContentSha256: null,
    });
  }

  function loadSavedBatchDetail(detail: SavedBatchDetail) {
    runRevision.current += 1;
    setRun(null);
    setRunStatus(null);
    setRunSnapshotIdentity(null);
    setCurrentRunId(null);
    setRestoredRunSeed(null);
    setRestoringRun(false);
    setRunRestoreUnresolved(false);
    setPreviewRunAssociation(null);
    setConsistencyError(null);
    setHistoricalSourceRunId(null);
    const nextForm = savedBatchToForm(detail, projectSnapshot(form));
    setSavedBatchLink({
      id: detail.id,
      revision: detail.revision,
      baseline: canonicalBatchIntent(nextForm),
    });
    setSavedBatchRecoveryPointer({ id: detail.id, revision: detail.revision });
    setSavedBatchConflict(null);
    changeForm(nextForm);
  }

  async function selectSavedBatch(batchId: string) {
    const requestedGeneration = ++batchReplacementGeneration.current;
    const requestedProjectId = formRef.current.projectId;
    const detail = await api.getSavedBatch(batchId);
    if (requestedGeneration !== batchReplacementGeneration.current) return;
    if (detail.project_id !== requestedProjectId || formRef.current.projectId !== requestedProjectId) {
      throw new Error("That Saved Batch belongs to another Project.");
    }
    loadSavedBatchDetail(detail);
  }

  async function createEmptySavedBatch(input: SavedBatchCreateInput) {
    const requestedGeneration = ++batchReplacementGeneration.current;
    const base: BatchFormState = {
      ...initialBatchForm(),
      projectId: form.projectId,
      projectFilesystemKey: form.projectFilesystemKey,
      projectName: form.projectName,
      batchName: input.name,
      batchDescription: input.description ?? "",
    };
    const detail = await api.createSavedBatch(
      form.projectId,
      buildSavedBatchCreate(base, input.filesystemKey),
    );
    if (requestedGeneration !== batchReplacementGeneration.current) return;
    setSavedBatchListRefresh((token) => token + 1);
    loadSavedBatchDetail(detail);
  }

  async function createFromCurrentSavedBatch(input: SavedBatchCreateInput) {
    const requestedGeneration = ++batchReplacementGeneration.current;
    const source: BatchFormState = {
      ...form,
      batchName: input.name,
      batchDescription: input.description ?? "",
    };
    const detail = await api.createSavedBatch(
      form.projectId,
      buildSavedBatchCreate(source, input.filesystemKey),
    );
    if (requestedGeneration !== batchReplacementGeneration.current) return;
    setSavedBatchListRefresh((token) => token + 1);
    loadSavedBatchDetail(detail);
  }

  async function saveCurrentSavedBatch() {
    const link = savedBatchLink;
    if (!link) return;
    const sentForm = form;
    setSavingBatch(true);
    setBatchError(null);
    try {
      const detail = await api.updateSavedBatch(
        link.id,
        buildSavedBatchUpdate(sentForm, link.revision),
      );
      setSavedBatchLink({
        id: detail.id,
        revision: detail.revision,
        baseline: canonicalBatchIntent(sentForm),
      });
      setSavedBatchRecoveryPointer({ id: detail.id, revision: detail.revision });
      setSavedBatchConflict(null);
      setSavedBatchListRefresh((token) => token + 1);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "saved_batch_revision_conflict") {
        setSavedBatchConflict({ kind: "save", batchId: link.id });
        return;
      }
      throw caught;
    } finally {
      setSavingBatch(false);
    }
  }

  async function archiveSavedBatch() {
    const link = savedBatchLink;
    if (!link) return;
    await api.archiveSavedBatch(link.id);
    setSavedBatchLink(null);
    setSavedBatchRecoveryPointer(null);
    setSavedBatchListRefresh((token) => token + 1);
    setSessionMessage("Saved Batch archived. The current editor content remains as an unsaved draft.");
  }

  function reloadConflictBatch() {
    const conflict = savedBatchConflict;
    if (!conflict) return;
    void selectSavedBatch(conflict.batchId).catch((caught) => {
      setBatchError(errorMessage(caught));
    });
  }

  async function previewBatch() {
    const requestedRevision = formRevision.current;
    setPreviewing(true);
    setBatchError(null);
    try {
      if (!projectVerified || selectedProjectId !== form.projectId) {
        throw new Error("Reconnect or select the exact Project before Preview.");
      }
      if (
        historicalSourceRunId
        && recoveredHistoricalRun.current !== historicalSourceRunId
      ) {
        throw new Error("Wait for the historical Run context to finish restoring before Preview.");
      }
      const request = buildBatchRequest(form, {
        sourceSavedBatch: savedBatchLink
          ? { id: savedBatchLink.id, revision: savedBatchLink.revision }
          : null,
      });
      const availableAssets = await api.listProjectAssets(request.project.filesystem_key);
      const availableAssetIds = new Set(availableAssets.assets.map((asset) => asset.asset_id));
      const selectedAssetIds = request.image_bindings.flatMap((binding) =>
        binding.values.filter((value): value is string => value !== null)
      );
      const missingAssetIds = [...new Set(selectedAssetIds)]
        .filter((assetId) => !availableAssetIds.has(assetId));
      if (missingAssetIds.length > 0) {
        throw new Error(
          `Selected Image Input assets are no longer available in this Project: ${missingAssetIds.join(", ")}`,
        );
      }
      const nextPreview = await api.previewBatch(request);
      if (requestedRevision === formRevision.current) {
        const inspectedRequest = withMaterializedRandomSeeds(
          request,
          nextPreview.jobs.map((job) => job.seed),
        );
        setPreviewSnapshot({
          request: inspectedRequest,
          response: nextPreview,
          formRevision: requestedRevision,
          singleUse: form.seedMode === "random",
        });
        setPreviewRunAssociation(null);
        setSessionMessage((message) => message === RESTORED_DRAFT_MESSAGE ? null : message);
        setRunName("");
        setRunDescription("");
      }
    } catch (caught) {
      if (requestedRevision === formRevision.current) {
        setPreviewSnapshot(null);
        setBatchError(errorMessage(caught));
      }
    } finally {
      setPreviewing(false);
    }
  }

  async function loadRunAsBatch(runId: string, signal?: AbortSignal) {
    if (signal?.aborted) return;
    if (projectSwitchingBlocked) {
      throw new Error("Finish or release the current Run before loading another Run as a Batch.");
    }
    const requestedGeneration = ++batchReplacementGeneration.current;
    const requestedProjectId = projectContextRef.current.selectedProjectId;
    const [reconstruction, frozenRun] = await Promise.all([
      api.getBatchReconstruction(runId, signal),
      loadFrozenRun(runId),
    ]);
    if (
      signal?.aborted
      || requestedGeneration !== batchReplacementGeneration.current
      || !projectContextRef.current.projectVerified
      || projectContextRef.current.selectedProjectId !== requestedProjectId
      || formRef.current.projectId !== requestedProjectId
    ) return;
    if (reconstruction.run_id !== runId || frozenRun.run_id !== runId) {
      throw new Error("The reconstructed Batch did not match the selected Run.");
    }
    if (!requestedProjectId || reconstruction.batch_snapshot.project.id !== requestedProjectId) {
      throw new Error("The reconstructed Batch belongs to another Project.");
    }
    if (
      frozenRun.batch_snapshot.project.id !== requestedProjectId
      || frozenRun.batch_snapshot.project.filesystem_key !== formRef.current.projectFilesystemKey
    ) {
      throw new Error("The frozen Run belongs to another Project.");
    }
    const nextForm = editableBatchSnapshotToForm(reconstruction);

    runRevision.current += 1;
    formRevision.current += 1;
    setForm(nextForm);
    setHistoricalSourceRunId(runId);
    recoveredHistoricalRun.current = runId;
    setPreviewSnapshot(null);
    setPreviewRunAssociation(null);
    setRun(null);
    setRunStatus(null);
    setCurrentRunId(null);
    setRunSnapshotIdentity(null);
    setRestoredRunSeed(null);
    setRestoringRun(false);
    setRunRestoreUnresolved(false);
    setCreatedUnavailableRunId(null);
    setExecutionControlUnavailableRunId(null);
    setSavedBatchLink(null);
    setSavedBatchRecoveryPointer(null);
    setSavedBatchConflict(null);
    setSavedBatchRestorePending(false);
    setRunName("");
    setRunDescription("");
    setBatchError(null);
    setCreateError(null);
    setConsistencyError(null);
    setSessionMessage(`Run ${frozenRun.run_number} loaded as an unsaved Batch draft. Preview to verify the Job plan.`);
    navigation.navigate("batch");
  }

  async function createRun() {
    const snapshot = previewSnapshot;
    const requestedBatchIdentity = snapshot ? batchRequestIdentity(snapshot.request) : null;
    const currentRunAllowsReplacement = run?.run_id === createdUnavailableRunId
      || run?.run_id === executionControlUnavailableRunId
      || (runStatus !== null && TERMINAL_RUN_STATUSES.has(runStatus));
    if (
      !snapshot ||
      creating ||
      restoringRun ||
      runRestoreUnresolved ||
      (run !== null && !currentRunAllowsReplacement)
    ) {
      return;
    }
    setCreating(true);
    setCreateError(null);
    setConsistencyError(null);
    try {
      const nextRun = await api.createRun({
        ...snapshot.request,
        run_name: runName.trim() || null,
        run_description: runDescription.trim() || null,
      });
      if (requestedBatchIdentity !== currentBatchIdentityRef.current) {
        onHistoryChange(nextRun.project_id);
        return;
      }
      const consistent = nextRun.job_count === snapshot.response.job_count;
      runRevision.current += 1;
      setRun(nextRun);
      setRunName("");
      setRunDescription("");
      setRunStatus("created");
      setRunSnapshotIdentity({ runId: nextRun.run_id, snapshot: snapshot.request.batch_snapshot });
      setRestoredRunSeed(null);
      setCurrentRunId(nextRun.run_id);
      saveWorkingSessionRecovery(
        formRef.current,
        nextRun.run_id,
        selectedProjectId,
        undefined,
        savedBatchRecoveryPointer?.id ?? null,
        savedBatchRecoveryPointer?.revision ?? null,
        historicalSourceRunId,
      );
      if (snapshot.singleUse) {
        setPreviewSnapshot((current) => current === snapshot ? null : current);
        setPreviewRunAssociation(null);
      } else if (snapshot.formRevision === formRevision.current) {
        setPreviewRunAssociation({
          runId: nextRun.run_id,
          runNumber: nextRun.run_number,
          consistent,
        });
      }
      if (!consistent) {
        setConsistencyError(
          `Run ${nextRun.run_number} was created with ${nextRun.job_count} Jobs, but the inspected Preview has ${snapshot.response.job_count}. The durable Run is preserved and does not match this Preview.`,
        );
      }
      try {
        const frozenRun = await loadFrozenRun(nextRun.run_id);
        if (
          frozenRun.run_id !== nextRun.run_id ||
          frozenRun.run_number !== nextRun.run_number ||
          frozenRun.job_count !== nextRun.job_count
        ) {
          return;
        }
        if (requestedBatchIdentity === currentBatchIdentityRef.current) {
          setRun(frozenRun);
          setRunSnapshotIdentity({ runId: frozenRun.run_id, snapshot: frozenRun.batch_snapshot });
        }
      } catch (caught) {
        setCreateError(
          `Run ${nextRun.run_number} was created, but its frozen plan could not be loaded. ${errorMessage(caught)}`,
        );
      }
    } catch (caught) {
      setCreateError(errorMessage(caught));
    } finally {
      setCreating(false);
    }
  }

  const currentRunCreatedUnavailable = run?.run_id === createdUnavailableRunId;
  const currentRunExecutionControlUnavailable = run?.run_id === executionControlUnavailableRunId;
  const currentRunAllowsReplacement = currentRunCreatedUnavailable
    || currentRunExecutionControlUnavailable
    || (runStatus !== null && TERMINAL_RUN_STATUSES.has(runStatus));
  const currentIntent = canonicalBatchIntent(form);
  const [pristineIntent] = useState(() => canonicalBatchIntent(initialBatchForm()));
  const savedBatchDirty = savedBatchLink !== null && currentIntent !== savedBatchLink.baseline;
  const hasUnsavedChanges = savedBatchLink
    ? savedBatchDirty
    : currentIntent !== pristineIntent;
  const projectSwitchingBlocked =
    restoringRun ||
    runRestoreUnresolved ||
    savingBatch ||
    (runStatus === "created" && !currentRunCreatedUnavailable) ||
    (runStatus === "running" && !currentRunExecutionControlUnavailable);
  const canCreateRun =
    previewSnapshot !== null &&
    !restoringRun &&
    !runRestoreUnresolved &&
    (run === null || currentRunAllowsReplacement);
  const creationBlockedMessage = restoringRun
    ? "Restoring the previous Run before another Run can be created."
    : runRestoreUnresolved
      ? "The previous Run state is unknown. Refresh after the backend is available before creating another Run."
      : currentRunCreatedUnavailable
        ? "The current Run cannot be started or discarded. Create another immutable Run from this Preview."
      : currentRunExecutionControlUnavailable
        ? "This backend no longer controls the current Run. Create another immutable Run from this Preview."
      : runStatus === "created"
        ? "Start the current Run before creating another one."
        : runStatus === "running"
          ? "The current Run is still running."
          : null;
  const matchingRestoredRunSeed =
    restoredRunSeed?.runId === run?.run_id ? restoredRunSeed : null;
  const currentRunSnapshot = runSnapshotIdentity && runSnapshotIdentity.runId === run?.run_id
    ? runSnapshotIdentity.snapshot
    : null;
  const currentSnapshotIdentity = (() => {
    try {
      return editableBatchSnapshotIdentity(buildEditableBatchSnapshot(form, {
        sourceSavedBatch: savedBatchLink
          ? { id: savedBatchLink.id, revision: savedBatchLink.revision }
          : null,
      }));
    } catch {
      return null;
    }
  })();
  const batchDiverged = currentRunSnapshot !== null && (
    currentSnapshotIdentity === null ||
    currentSnapshotIdentity !== editableBatchSnapshotIdentity(currentRunSnapshot)
  );

  return (
    <>
      <header className="app-header">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">BC</span>
          <div>
            <h1>batchcraft</h1>
            <p>ComfyUI experiment runner</p>
          </div>
        </div>
        <div className="header-tools">
          <ComfyUIStatus api={api} />
          <SettingsMenu />
        </div>
      </header>

      <main>
        <div className="workspace-navigation">
          <nav aria-label="Workspace">
            {(["batch", "gallery", "runs"] as const).map((view) => (
              <button
                key={view}
                type="button"
                aria-current={navigation.view === view ? "page" : undefined}
                onClick={() => navigation.navigate(view)}
              >
                {view === "batch" ? "Batch" : view === "gallery" ? "Gallery" : "Runs"}
              </button>
            ))}
          </nav>
          <div className="workspace-project">
            <span>Project</span>
            <strong>{projectVerified ? form.projectName : selectedProjectId ? "Reconnecting..." : "Not selected"}</strong>
            {navigation.view !== "batch" ? <button type="button" className="button-link" onClick={() => navigation.navigate("batch")}>Change in Batch</button> : null}
          </div>
        </div>
        {import.meta.env.VITE_BATCHCRAFT_INSTANCE ? (
          <p className="session-note" role="status">{import.meta.env.VITE_BATCHCRAFT_INSTANCE}</p>
        ) : null}
        {sessionMessage ? (
          <div className="session-note dismissible-note">
            <span role="status">{sessionMessage}</span>
            <button
              className="button-secondary compact"
              type="button"
              aria-label="Dismiss session notification"
              onClick={() => setSessionMessage(null)}
            >
              Dismiss
            </button>
          </div>
        ) : null}
        <div hidden={navigation.view !== "batch"} className="workspace-batch">
        {savedBatchConflict ? (
          <div className="operation-error" role="alert">
            <p>
              {savedBatchConflict.kind === "session"
                ? "This Batch changed since this browser draft was saved."
                : "This Batch changed in another session."}
            </p>
            <div className="action-row">
              <button className="button-secondary compact" type="button" onClick={reloadConflictBatch}>
                {savedBatchConflict.kind === "session" ? "Use saved Batch" : "Reload saved version"}
              </button>
              <button
                className="button-secondary compact"
                type="button"
                onClick={() => setSaveAsRequest(true)}
              >
                {savedBatchConflict.kind === "session"
                  ? "Recover browser draft as new Batch"
                  : "Save as new Batch"}
              </button>
            </div>
          </div>
        ) : null}
        <BatchEditor
          api={api}
          form={form}
          historicalSourceRunId={historicalSourceRunId}
          selectedProjectId={selectedProjectId}
          projectVerified={projectVerified}
          projectSwitchingBlocked={projectSwitchingBlocked}
          hasUnsavedChanges={hasUnsavedChanges}
          savedBatchDirty={savedBatchDirty}
          savedBatchId={savedBatchLink?.id ?? null}
          savedBatchRevision={savedBatchLink?.revision ?? null}
          savedBatchListRefresh={savedBatchListRefresh}
          savingBatch={savingBatch}
          saveAsRequest={saveAsRequest}
          error={batchError}
          previewing={previewing}
          onChange={changeForm}
          onHistoricalResourceChange={changeHistoricalResourceForm}
          onPromptMetadataChange={changePromptMetadata}
          onWorkflowMetadataChange={changeWorkflowMetadata}
          onProjectReconnect={reconnectProject}
          onProjectUnresolved={markProjectUnresolved}
          onProjectSelect={selectProject}
          onPreview={previewBatch}
          onSavedBatchSelect={selectSavedBatch}
          onSavedBatchCreateEmpty={createEmptySavedBatch}
          onSavedBatchCreateFromCurrent={createFromCurrentSavedBatch}
          onSavedBatchSave={saveCurrentSavedBatch}
          onSavedBatchArchive={archiveSavedBatch}
          onSaveAsRequestHandled={() => setSaveAsRequest(false)}
        />
        <PreviewPanel
          preview={previewSnapshot?.response ?? null}
          batchSnapshot={previewSnapshot?.request.batch_snapshot ?? null}
          creating={creating}
          currentRun={run}
          currentRunStatus={runStatus}
          canCreateRun={canCreateRun}
          creationBlockedMessage={creationBlockedMessage}
          association={previewRunAssociation}
          error={createError}
          runName={runName}
          runDescription={runDescription}
          onRunNameChange={setRunName}
          onRunDescriptionChange={setRunDescription}
          onCreateRun={createRun}
        />
        {consistencyError ? (
          <p className="consistency-error" role="alert">{consistencyError}</p>
        ) : null}
        </div>
        <RunWorkspace
          key={run?.run_id ?? "no-run"}
          api={api}
          run={run}
          pollIntervalMs={pollIntervalMs}
          initialExecution={matchingRestoredRunSeed?.execution ?? null}
          initialResults={matchingRestoredRunSeed?.results ?? EMPTY_RESULTS}
          initialResultsError={matchingRestoredRunSeed?.resultsError ?? null}
          onStatusChange={setRunStatus}
          onHistoryChange={onHistoryChange}
          onCreatedUnavailableChange={changeCreatedUnavailable}
          onExecutionControlUnavailableChange={changeExecutionControlUnavailable}
          getCachedRun={getCachedFrozenRun}
          loadRun={loadFrozenRun}
          batchDiverged={batchDiverged}
          visible={navigation.view === "batch"}
          onOpenRun={() => {
            navigation.navigate("batch");
            requestAnimationFrame(() => document.getElementById("current-run-workspace")?.scrollIntoView({ block: "start" }));
          }}
        />
        {navigation.filterError && navigation.view !== "batch" ? (
          <div className="operation-error" role="alert">
            <p>{navigation.filterError}</p>
            <button type="button" className="button-secondary" onClick={() => navigation.changeQuery({ ...navigation.query, filters: null }, true)}>Clear invalid filters</button>
          </div>
        ) : null}
        <ProjectBrowser
          api={api}
          projectId={projectVerified ? selectedProjectId : null}
          projectName={form.projectName}
          active={navigation.view !== "batch" && !navigation.filterError}
          view={navigation.view === "runs" ? "runs" : "gallery"}
          query={navigation.query}
          onQueryChange={navigation.changeQuery}
          onViewChange={navigation.navigate}
          onOpenBatch={() => navigation.navigate("batch")}
          historyRevision={selectedProjectId ? historyRevisions[selectedProjectId] ?? 0 : 0}
          getCachedRun={getCachedFrozenRun}
          loadRun={loadFrozenRun}
          loadRunAsBatch={loadRunAsBatch}
          loadRunAsBatchDisabled={projectSwitchingBlocked}
          hasUnsavedChanges={hasUnsavedChanges}
        />
      </main>
    </>
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function retryTransient<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const delays = [0, 50, 150];
  let lastError: unknown;
  for (const delay of delays) {
    if (delay) await abortableDelay(delay, signal);
    try {
      return await operation();
    } catch (caught) {
      if (isAbort(caught) || signal.aborted || !isTransient(caught)) throw caught;
      lastError = caught;
    }
  }
  throw lastError;
}

function isTransient(error: unknown): boolean {
  return !(error instanceof ApiError) || error.code === "network_error" || (
    error.status !== null && error.status >= 500
  );
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function projectSnapshot(form: BatchFormState): ProjectResponse {
  return {
    id: form.projectId,
    name: form.projectName,
    filesystem_key: form.projectFilesystemKey,
    description: null,
    created_at: "",
    updated_at: "",
    archived_at: null,
  };
}

function batchIdentity(form: BatchFormState): string {
  return JSON.stringify([
    form.projectId.trim(),
    form.projectFilesystemKey.trim(),
    form.batchId.trim(),
    form.batchFilesystemKey.trim(),
  ]);
}

function batchRequestIdentity(request: BatchRequest): string {
  return JSON.stringify([
    request.project.id,
    request.project.filesystem_key,
    request.batch.id,
    request.batch.filesystem_key,
  ]);
}

function runMatchesBatch(run: RunCreatedResponse, identity: string): boolean {
  const [projectId, projectFilesystemKey, batchId, batchFilesystemKey] = JSON.parse(identity) as string[];
  if (run.project_id !== projectId || run.batch_id !== batchId) return false;
  if (!("batch_snapshot" in run)) return true;
  const snapshot = (run as RunResponse).batch_snapshot;
  return (
    snapshot.project.id === projectId &&
    snapshot.project.filesystem_key === projectFilesystemKey &&
    snapshot.batch.id === batchId &&
    snapshot.batch.filesystem_key === batchFilesystemKey
  );
}
