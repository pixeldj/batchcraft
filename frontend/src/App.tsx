import { useEffect, useRef, useState } from "react";

import { ApiError, apiClient, type BatchcraftApi } from "./api/client";
import type {
  BatchRequest,
  ExecutionResponse,
  PreviewResponse,
  ProjectResponse,
  ResultResponse,
  RunCreatedResponse,
  RunStatus,
} from "./api/types";
import { BatchEditor } from "./features/batch/BatchEditor";
import { PreviewPanel } from "./features/batch/PreviewPanel";
import {
  buildBatchRequest,
  type BatchFormState,
} from "./features/batch/form";
import {
  BatchResultsGallery,
  type BatchGalleryRun,
} from "./features/results/BatchResultsGallery";
import { RunWorkspace } from "./features/run/RunWorkspace";
import { loadWorkingSession, saveWorkingSession } from "./features/session/workingSession";
import { ComfyUIStatus } from "./features/status/ComfyUIStatus";
import { errorMessage } from "./utils/errors";

interface Props {
  api?: BatchcraftApi;
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

const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "blocked"]);

export default function App({ api = apiClient, pollIntervalMs = 1000 }: Props) {
  const [initialSession] = useState(loadWorkingSession);
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
  const [run, setRun] = useState<RunCreatedResponse | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [restoredRunSeed, setRestoredRunSeed] = useState<RestoredRunSeed | null>(null);
  const [previewRunAssociation, setPreviewRunAssociation] =
    useState<PreviewRunAssociation | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [restoringRun, setRestoringRun] = useState(initialSession.currentRunId !== null);
  const [runRestoreUnresolved, setRunRestoreUnresolved] = useState(false);
  const [sessionMessage, setSessionMessage] = useState<string | null>(
    initialSession.draftRestored
      ? "Draft restored from this browser session. Preview to verify the Job plan."
      : null,
  );
  const [batchError, setBatchError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [consistencyError, setConsistencyError] = useState<string | null>(null);
  const formRevision = useRef(0);
  const runRevision = useRef(0);
  const initialBatchIdentity = useRef(batchIdentity(initialSession.form));
  const batchIdentityChanged = useRef(false);
  const currentBatchIdentity = batchIdentity(form);
  const currentBatchIdentityRef = useRef(currentBatchIdentity);
  currentBatchIdentityRef.current = currentBatchIdentity;

  useEffect(() => {
    saveWorkingSession(form, currentRunId, sessionRunIds, selectedProjectId);
  }, [currentRunId, form, selectedProjectId, sessionRunIds]);

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
        const restoredRun = await api.getRun(runId, signal);
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
  }, [api, currentBatchIdentity, initialSession, projectVerified, selectedProjectId]);

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
        const restoredRun = await api.getRun(runId, controller.signal);
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
  }, [api, initialSession, projectVerified, selectedProjectId]);

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
    setSelectedProjectId(null);
    setProjectVerified(true);
    if (initialSession.currentRunId) {
      setRestoringRun(false);
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

    runRevision.current += 1;
    setSelectedProjectId(project.id);
    setProjectVerified(true);
    setCurrentRunId(null);
    setSessionRunIds([]);
    setGalleryRunsById({});
    setRun(null);
    setRunStatus(null);
    setRestoredRunSeed(null);
    setRestoringRun(false);
    setRunRestoreUnresolved(false);
    setConsistencyError(null);
    setSessionMessage(null);
    changeForm({
      ...form,
      projectId: project.id,
      projectFilesystemKey: project.filesystem_key,
      projectName: project.name,
      prompts: [],
      referenceAssetIds: [],
    });
  }

  async function previewBatch() {
    const requestedRevision = formRevision.current;
    setPreviewing(true);
    setBatchError(null);
    try {
      const request = buildBatchRequest(form);
      const availableAssets = await api.listProjectAssets(request.project.filesystem_key);
      const availableAssetIds = new Set(availableAssets.assets.map((asset) => asset.asset_id));
      const missingAssetIds = request.references
        .map((reference) => reference.asset_id)
        .filter((assetId) => !availableAssetIds.has(assetId));
      if (missingAssetIds.length > 0) {
        throw new Error(
          `Selected Reference Assets are no longer available in this Project: ${missingAssetIds.join(", ")}`,
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
    const currentRunIsTerminal = runStatus !== null && TERMINAL_RUN_STATUSES.has(runStatus);
    if (
      !snapshot ||
      creating ||
      restoringRun ||
      runRestoreUnresolved ||
      (run !== null && !currentRunIsTerminal)
    ) {
      return;
    }
    setCreating(true);
    setCreateError(null);
    setConsistencyError(null);
    try {
      const nextRun = await api.createRun(snapshot.request);
      const consistent = nextRun.job_count === snapshot.response.job_count;
      runRevision.current += 1;
      setRun(nextRun);
      setRunStatus("created");
      setRestoredRunSeed(null);
      setCurrentRunId(nextRun.run_id);
      if (requestedBatchIdentity === currentBatchIdentityRef.current) {
        setSessionRunIds((current) =>
          current.includes(nextRun.run_id) ? current : [...current, nextRun.run_id],
        );
        setGalleryRunsById((current) => ({
          ...current,
          [nextRun.run_id]: {
            runId: nextRun.run_id,
            runNumber: nextRun.run_number,
            results: [],
            loading: false,
            error: null,
          },
        }));
      }
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
    } catch (caught) {
      setCreateError(errorMessage(caught));
    } finally {
      setCreating(false);
    }
  }

  const currentRunIsTerminal = runStatus !== null && TERMINAL_RUN_STATUSES.has(runStatus);
  const projectSwitchingBlocked =
    restoringRun || runRestoreUnresolved || runStatus === "created" || runStatus === "running";
  const canCreateRun =
    previewSnapshot !== null &&
    !restoringRun &&
    !runRestoreUnresolved &&
    (run === null || currentRunIsTerminal);
  const creationBlockedMessage = restoringRun
    ? "Restoring the previous Run before another Run can be created."
    : runRestoreUnresolved
      ? "The previous Run state is unknown. Refresh after the backend is available before creating another Run."
      : runStatus === "created"
        ? "Start the current Run before creating another one."
        : runStatus === "running"
          ? "The current Run is still running."
          : null;
  const matchingRestoredRunSeed =
    restoredRunSeed?.runId === run?.run_id ? restoredRunSeed : null;

  function updateCurrentRunGalleryResults(runId: string, results: ResultResponse[]) {
    if (!sessionRunIds.includes(runId)) {
      return;
    }
    setGalleryRunsById((current) => {
      const existing = current[runId] ?? loadingGalleryRun(runId);
      if (existing.results === results && !existing.loading && existing.error === null) {
        return current;
      }
      return {
        ...current,
        [runId]: {
          ...existing,
          runNumber: existing.runNumber ?? (run?.run_id === runId ? run.run_number : null),
          results,
          loading: false,
          error: null,
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
        <div className="intro-strip">
          <p>One Batch. An explicit Job plan. A durable Run.</p>
          <span>Browser working session</span>
        </div>
        {sessionMessage ? <p className="session-note" role="status">{sessionMessage}</p> : null}
        <BatchEditor
          api={api}
          form={form}
          selectedProjectId={selectedProjectId}
          projectVerified={projectVerified}
          projectSwitchingBlocked={projectSwitchingBlocked}
          error={batchError}
          previewing={previewing}
          onChange={changeForm}
          onPromptMetadataChange={changePromptMetadata}
          onProjectReconnect={reconnectProject}
          onProjectUnresolved={markProjectUnresolved}
          onProjectSelect={selectProject}
          onPreview={previewBatch}
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
          onResultsChange={updateCurrentRunGalleryResults}
        />
        <BatchResultsGallery
          api={api}
          runIds={sessionRunIds}
          runsById={galleryRunsById}
        />
      </main>
    </>
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
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
  const [projectId, , batchId] = JSON.parse(identity) as string[];
  return run.project_id === projectId && run.batch_id === batchId;
}

function loadingGalleryRun(runId: string): BatchGalleryRun {
  return { runId, runNumber: null, results: [], loading: true, error: null };
}

function withoutGalleryRun(
  runsById: Record<string, BatchGalleryRun>,
  runId: string,
): Record<string, BatchGalleryRun> {
  const next = { ...runsById };
  delete next[runId];
  return next;
}
