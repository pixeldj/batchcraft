import { useCallback, useEffect, useRef, useState } from "react";

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
  editableBatchSnapshotIdentity,
  initialBatchForm,
  reconcileFormBindings,
  type BatchFormState,
} from "./features/batch/form";
import {
  buildSavedBatchCreate,
  buildSavedBatchUpdate,
  canonicalBatchIntent,
  savedBatchToForm,
} from "./features/batch/savedBatch";
import type { SavedBatchCreateInput } from "./features/batch/SavedBatchSelector";
import {
  BatchResultsGallery,
  type BatchGalleryRun,
} from "./features/results/BatchResultsGallery";
import { RunWorkspace } from "./features/run/RunWorkspace";
import {
  loadWorkingSessionRecovery,
  saveWorkingSessionRecovery,
} from "./features/session/workingSessionRecovery";
import { ComfyUIStatus } from "./features/status/ComfyUIStatus";
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

export default function App({ api = apiClient, pollIntervalMs = 1000 }: Props) {
  const [initialSession] = useState(loadWorkingSessionRecovery);
  const [form, setForm] = useState<BatchFormState>(initialSession.form);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    initialSession.selectedProjectId,
  );
  const [projectVerified, setProjectVerified] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | null>(initialSession.currentRunId);
  const [sessionRunIds, setSessionRunIds] = useState<string[]>(initialSession.sessionRunIds);
  const [galleryRunsById, setGalleryRunsById] = useState<Record<string, BatchGalleryRun>>(() =>
    Object.fromEntries(
      initialSession.sessionRunIds.map((runId) => [runId, loadingGalleryRun(runId)]),
    ),
  );
  const [previewSnapshot, setPreviewSnapshot] = useState<PreviewSnapshot | null>(null);
  const [run, setRun] = useState<RunCreatedResponse | RunResponse | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [createdUnavailableRunId, setCreatedUnavailableRunId] = useState<string | null>(null);
  const [runSnapshotIdentity, setRunSnapshotIdentity] = useState<RunSnapshotIdentity | null>(null);
  const [restoredRunSeed, setRestoredRunSeed] = useState<RestoredRunSeed | null>(null);
  const [previewRunAssociation, setPreviewRunAssociation] =
    useState<PreviewRunAssociation | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [restoringRun, setRestoringRun] = useState(initialSession.currentRunId !== null);
  const [runRestoreUnresolved, setRunRestoreUnresolved] = useState(false);
  const [sessionMessage, setSessionMessage] = useState<string | null>(
    initialSession.draftRestored
      ? "Draft restored from this browser. Preview to verify the Job plan."
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
  const runRevision = useRef(0);
  const frozenRunCache = useRef(new Map<string, RunResponse>());
  const frozenRunRequests = useRef(new Map<string, Promise<RunResponse>>());
  const initialBatchIdentity = useRef(batchIdentity(initialSession.form));
  const batchIdentityChanged = useRef(false);
  const currentBatchIdentity = batchIdentity(form);
  const currentBatchIdentityRef = useRef(currentBatchIdentity);
  currentBatchIdentityRef.current = currentBatchIdentity;

  const cacheFrozenRun = useCallback((frozenRun: RunResponse) => {
    frozenRunCache.current.set(frozenRun.run_id, frozenRun);
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
    sessionRunIds,
    selectedProjectId,
    savedBatchRecoveryPointer,
  });
  recoveryStateRef.current = {
    form,
    currentRunId,
    sessionRunIds,
    selectedProjectId,
    savedBatchRecoveryPointer,
  };
  const persistRecovery = useCallback(() => {
    const state = recoveryStateRef.current;
    saveWorkingSessionRecovery(
      state.form,
      state.currentRunId,
      state.sessionRunIds,
      state.selectedProjectId,
      undefined,
      state.savedBatchRecoveryPointer?.id ?? null,
      state.savedBatchRecoveryPointer?.revision ?? null,
    );
  }, []);

  useEffect(() => {
    persistRecovery();
  }, [currentRunId, form, persistRecovery, savedBatchRecoveryPointer, selectedProjectId, sessionRunIds]);

  useEffect(() => {
    window.addEventListener("pagehide", persistRecovery);
    return () => window.removeEventListener("pagehide", persistRecovery);
  }, [persistRecovery]);

  const formRef = useRef(form);
  formRef.current = form;

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
    if (!savedBatchRestorePending) return;
    if (!projectVerified || !selectedProjectId) return;
    if (selectedProjectId !== formRef.current.projectId) return;
    const batchId = initialSession.selectedSavedBatchId;
    if (!batchId) {
      setSavedBatchRestorePending(false);
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
    if (
      !projectVerified ||
      !selectedProjectId ||
      batchIdentityChanged.current ||
      currentBatchIdentity !== initialBatchIdentity.current
    ) {
      return;
    }
    const historicalRunIds = initialSession.sessionRunIds.filter(
      (runId) => runId !== initialSession.currentRunId,
    );
    if (historicalRunIds.length === 0) {
      return;
    }
    const controller = new AbortController();

    for (const runId of historicalRunIds) {
      void restoreHistoricalGalleryRun(runId, controller.signal);
    }

    async function restoreHistoricalGalleryRun(runId: string, signal: AbortSignal) {
      try {
        const restoredRun = cacheFrozenRun(await api.getRun(runId, signal));
        if (!runMatchesBatch(restoredRun, currentBatchIdentityRef.current)) {
          setSessionRunIds((current) => current.filter((candidate) => candidate !== runId));
          setGalleryRunsById((current) => withoutGalleryRun(current, runId));
          return;
        }
        const restoredResults = await api.getResults(runId, signal);
        if (signal.aborted) {
          return;
        }
        setGalleryRunsById((current) => ({
          ...current,
          [runId]: {
            runId,
            runNumber: restoredRun.run_number,
            results: restoredResults.results,
            execution: restoredRun.execution,
            loading: false,
            error: null,
          },
        }));
      } catch (caught) {
        if (isAbort(caught) || signal.aborted) {
          return;
        }
        if (caught instanceof ApiError && caught.code === "run_not_found") {
          setSessionRunIds((current) => current.filter((candidate) => candidate !== runId));
          setGalleryRunsById((current) => withoutGalleryRun(current, runId));
          return;
        }
        setGalleryRunsById((current) => ({
          ...current,
          [runId]: {
            ...(current[runId] ?? loadingGalleryRun(runId)),
            loading: false,
            error: errorMessage(caught),
          },
        }));
      }
    }

    return () => controller.abort();
  }, [api, cacheFrozenRun, currentBatchIdentity, initialSession, projectVerified, selectedProjectId]);

  useEffect(() => {
    const restoredRunId = initialSession.currentRunId;
    if (!restoredRunId) {
      setRestoringRun(false);
      return;
    }
    if (!projectVerified) {
      return;
    }
    if (!selectedProjectId) {
      setRestoringRun(false);
      return;
    }
    const controller = new AbortController();
    const requestedRunRevision = runRevision.current;

    async function restoreRun(runId: string) {
      try {
        const restoredRun = cacheFrozenRun(await api.getRun(runId, controller.signal));
        if (!runMatchesBatch(restoredRun, currentBatchIdentityRef.current)) {
          setCurrentRunId(null);
          setSessionRunIds((current) => current.filter((candidate) => candidate !== runId));
          setGalleryRunsById((current) => withoutGalleryRun(current, runId));
          setSessionMessage("The previous Run belongs to another Project or Batch and was not restored.");
          return;
        }
        const execution = await api.getExecution(runId, controller.signal);
        let results: ResultResponse[] = [];
        let resultsError: string | null = null;
        try {
          results = (await api.getResults(runId, controller.signal)).results;
        } catch (caught) {
          if (isAbort(caught)) {
            return;
          }
          resultsError = errorMessage(caught);
        }
        if (controller.signal.aborted || requestedRunRevision !== runRevision.current) {
          return;
        }
        setRun(restoredRun);
        setRunStatus(execution.status);
        setRunSnapshotIdentity({
          runId: restoredRun.run_id,
          snapshot: restoredRun.batch_snapshot,
        });
        setRestoredRunSeed({ runId, execution, results, resultsError });
        if (
          !batchIdentityChanged.current &&
          initialSession.sessionRunIds.includes(runId)
        ) {
          setGalleryRunsById((current) => ({
            ...current,
            [runId]: {
              runId,
              runNumber: restoredRun.run_number,
              results,
              execution,
              loading: false,
              error: resultsError,
            },
          }));
        }
        setRunRestoreUnresolved(false);
      } catch (caught) {
        if (isAbort(caught) || requestedRunRevision !== runRevision.current) {
          return;
        }
        const definitive =
          caught instanceof ApiError &&
          (caught.code === "run_not_found" || caught.code === "invalid_run_data");
        if (definitive) {
          setCurrentRunId(null);
          setSessionRunIds((current) => current.filter((candidate) => candidate !== runId));
          setGalleryRunsById((current) => withoutGalleryRun(current, runId));
        } else {
          setRunRestoreUnresolved(true);
          if (
            !batchIdentityChanged.current &&
            initialSession.sessionRunIds.includes(runId)
          ) {
            setGalleryRunsById((current) => ({
              ...current,
              [runId]: {
                ...(current[runId] ?? loadingGalleryRun(runId)),
                loading: false,
                error: errorMessage(caught),
              },
            }));
          }
        }
        setSessionMessage(`The previous Run could not be restored. ${errorMessage(caught)}`);
      } finally {
        if (!controller.signal.aborted && requestedRunRevision === runRevision.current) {
          setRestoringRun(false);
        }
      }
    }

    void restoreRun(restoredRunId);
    return () => controller.abort();
  }, [api, cacheFrozenRun, initialSession, projectVerified, selectedProjectId]);

  function changeForm(next: BatchFormState) {
    formRevision.current += 1;
    if (batchIdentity(form) !== batchIdentity(next)) {
      batchIdentityChanged.current = true;
      setSessionRunIds([]);
      setGalleryRunsById({});
    }
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
    runRevision.current += 1;
    setSelectedProjectId(null);
    setProjectVerified(true);
    setCurrentRunId(null);
    setSessionRunIds([]);
    setGalleryRunsById({});
    setRun(null);
    setRunStatus(null);
    setRunSnapshotIdentity(null);
    setRestoredRunSeed(null);
    setRestoringRun(false);
    setRunRestoreUnresolved(false);
    setSavedBatchLink(null);
    setSavedBatchRecoveryPointer(null);
    setSavedBatchConflict(null);
    setSavedBatchRestorePending(false);
  }

  function selectProject(project: ProjectResponse) {
    if (
      form.projectId.trim() === project.id &&
      form.projectFilesystemKey.trim() === project.filesystem_key
    ) {
      reconnectProject(project);
      return;
    }

    runRevision.current += 1;
    setSelectedProjectId(project.id);
    setProjectVerified(true);
    setCurrentRunId(null);
    setSessionRunIds([]);
    setGalleryRunsById({});
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
    const detail = await api.getSavedBatch(batchId);
    if (detail.project_id !== formRef.current.projectId) {
      throw new Error("That Saved Batch belongs to another Project.");
    }
    loadSavedBatchDetail(detail);
  }

  async function createEmptySavedBatch(input: SavedBatchCreateInput) {
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
    setSavedBatchListRefresh((token) => token + 1);
    loadSavedBatchDetail(detail);
  }

  async function createFromCurrentSavedBatch(input: SavedBatchCreateInput) {
    const source: BatchFormState = {
      ...form,
      batchName: input.name,
      batchDescription: input.description ?? "",
    };
    const detail = await api.createSavedBatch(
      form.projectId,
      buildSavedBatchCreate(source, input.filesystemKey),
    );
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
        setPreviewSnapshot({
          request,
          response: nextPreview,
          formRevision: requestedRevision,
          singleUse: form.seedMode === "random",
        });
        setPreviewRunAssociation(null);
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

  async function createRun() {
    const snapshot = previewSnapshot;
    const requestedBatchIdentity = snapshot ? batchRequestIdentity(snapshot.request) : null;
    const currentRunAllowsReplacement = run?.run_id === createdUnavailableRunId
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
      const nextRun = await api.createRun(snapshot.request);
      if (requestedBatchIdentity !== currentBatchIdentityRef.current) {
        return;
      }
      const consistent = nextRun.job_count === snapshot.response.job_count;
      runRevision.current += 1;
      setRun(nextRun);
      setRunStatus("created");
      setRunSnapshotIdentity({ runId: nextRun.run_id, snapshot: snapshot.request.batch_snapshot });
      setRestoredRunSeed(null);
      setCurrentRunId(nextRun.run_id);
      const nextSessionRunIds = sessionRunIds.includes(nextRun.run_id)
        ? sessionRunIds
        : [...sessionRunIds, nextRun.run_id];
      saveWorkingSessionRecovery(
        formRef.current,
        nextRun.run_id,
        nextSessionRunIds,
        selectedProjectId,
        undefined,
        savedBatchRecoveryPointer?.id ?? null,
        savedBatchRecoveryPointer?.revision ?? null,
      );
      setSessionRunIds(nextSessionRunIds);
      setGalleryRunsById((current) => ({
        ...current,
        [nextRun.run_id]: {
          runId: nextRun.run_id,
          runNumber: nextRun.run_number,
          results: [],
          execution: null,
          loading: false,
          error: null,
        },
      }));
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
  const currentRunIsTerminal = currentRunCreatedUnavailable
    || (runStatus !== null && TERMINAL_RUN_STATUSES.has(runStatus));
  const currentIntent = canonicalBatchIntent(form);
  const pristineIntent = useRef(canonicalBatchIntent(initialBatchForm()));
  const savedBatchDirty = savedBatchLink !== null && currentIntent !== savedBatchLink.baseline;
  const hasUnsavedChanges = savedBatchLink
    ? savedBatchDirty
    : currentIntent !== pristineIntent.current;
  const projectSwitchingBlocked =
    restoringRun ||
    runRestoreUnresolved ||
    savingBatch ||
    (runStatus === "created" && !currentRunCreatedUnavailable) ||
    runStatus === "running";
  const canCreateRun =
    previewSnapshot !== null &&
    !restoringRun &&
    !runRestoreUnresolved &&
    (run === null || currentRunIsTerminal);
  const creationBlockedMessage = restoringRun
    ? "Restoring the previous Run before another Run can be created."
    : runRestoreUnresolved
      ? "The previous Run state is unknown. Refresh after the backend is available before creating another Run."
      : currentRunCreatedUnavailable
        ? "The current Run cannot be started or discarded. Create another immutable Run from this Preview."
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

  function updateCurrentRunGalleryResults(
    runId: string,
    execution: ExecutionResponse | null,
    results: ResultResponse[],
    error: string | null,
  ) {
    if (!sessionRunIds.includes(runId)) {
      return;
    }
    setGalleryRunsById((current) => {
      const existing = current[runId] ?? loadingGalleryRun(runId);
      if (
        existing.execution === execution &&
        existing.results === results &&
        !existing.loading &&
        existing.error === error
      ) {
        return current;
      }
      return {
        ...current,
        [runId]: {
          ...existing,
          runNumber: existing.runNumber ?? (run?.run_id === runId ? run.run_number : null),
          results,
          execution,
          loading: false,
          error,
        },
      };
    });
  }

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
        <ComfyUIStatus api={api} />
      </header>

      <main>
        {sessionMessage ? <p className="session-note" role="status">{sessionMessage}</p> : null}
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
          creating={creating}
          currentRun={run}
          currentRunStatus={runStatus}
          canCreateRun={canCreateRun}
          creationBlockedMessage={creationBlockedMessage}
          association={previewRunAssociation}
          error={createError}
          onCreateRun={createRun}
        />
        {consistencyError ? (
          <p className="consistency-error" role="alert">{consistencyError}</p>
        ) : null}
        <RunWorkspace
          key={run?.run_id ?? "no-run"}
          api={api}
          run={run}
          pollIntervalMs={pollIntervalMs}
          initialExecution={matchingRestoredRunSeed?.execution ?? null}
          initialResults={matchingRestoredRunSeed?.results ?? []}
          initialResultsError={matchingRestoredRunSeed?.resultsError ?? null}
          onStatusChange={setRunStatus}
          onCreatedUnavailableChange={changeCreatedUnavailable}
          onResultsChange={updateCurrentRunGalleryResults}
          getCachedRun={getCachedFrozenRun}
          loadRun={loadFrozenRun}
          batchDiverged={batchDiverged}
        />
        <BatchResultsGallery
          api={api}
          runIds={sessionRunIds}
          runsById={galleryRunsById}
          getCachedRun={getCachedFrozenRun}
          loadRun={loadFrozenRun}
        />
      </main>
    </>
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
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

function loadingGalleryRun(runId: string): BatchGalleryRun {
  return { runId, runNumber: null, results: [], execution: null, loading: true, error: null };
}

function withoutGalleryRun(
  runsById: Record<string, BatchGalleryRun>,
  runId: string,
): Record<string, BatchGalleryRun> {
  const next = { ...runsById };
  delete next[runId];
  return next;
}
