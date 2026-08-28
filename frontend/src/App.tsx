import { useRef, useState } from "react";

import { apiClient, type BatchcraftApi } from "./api/client";
import type { PreviewResponse, RunCreatedResponse } from "./api/types";
import { BatchEditor } from "./features/batch/BatchEditor";
import { PreviewPanel } from "./features/batch/PreviewPanel";
import {
  buildBatchRequest,
  initialBatchForm,
  type BatchFormState,
} from "./features/batch/form";
import { RunWorkspace } from "./features/run/RunWorkspace";
import { ComfyUIStatus } from "./features/status/ComfyUIStatus";
import { errorMessage } from "./utils/errors";

interface Props {
  api?: BatchcraftApi;
  pollIntervalMs?: number;
}

export default function App({ api = apiClient, pollIntervalMs = 1000 }: Props) {
  const [form, setForm] = useState<BatchFormState>(initialBatchForm);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [run, setRun] = useState<RunCreatedResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const formRevision = useRef(0);

  function changeForm(next: BatchFormState) {
    formRevision.current += 1;
    setForm(next);
    setPreview(null);
    setBatchError(null);
    setCreateError(null);
  }

  async function previewBatch() {
    const requestedRevision = formRevision.current;
    setPreviewing(true);
    setBatchError(null);
    try {
      const request = buildBatchRequest(form);
      const nextPreview = await api.previewBatch(request);
      if (requestedRevision === formRevision.current) {
        setPreview(nextPreview);
      }
    } catch (caught) {
      if (requestedRevision === formRevision.current) {
        setPreview(null);
        setBatchError(errorMessage(caught));
      }
    } finally {
      setPreviewing(false);
    }
  }

  async function createRun() {
    setCreating(true);
    setCreateError(null);
    try {
      const request = buildBatchRequest(form);
      setRun(await api.createRun(request));
    } catch (caught) {
      setCreateError(errorMessage(caught));
    } finally {
      setCreating(false);
    }
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
          <span>Local session</span>
        </div>
        <BatchEditor
          form={form}
          error={batchError}
          previewing={previewing}
          onChange={changeForm}
          onPreview={previewBatch}
        />
        <PreviewPanel
          preview={preview}
          creating={creating}
          runCreated={run !== null}
          error={createError}
          onCreateRun={createRun}
        />
        <RunWorkspace
          key={run?.run_id ?? "no-run"}
          api={api}
          run={run}
          pollIntervalMs={pollIntervalMs}
        />
      </main>
    </>
  );
}
