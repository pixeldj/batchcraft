import { useEffect, useState } from "react";

import type { BatchcraftApi } from "../../api/client";
import { errorMessage } from "../../utils/errors";
import type { ComfyUIStatusResponse } from "../../api/types";

interface Props {
  api: BatchcraftApi;
}

export function ComfyUIStatus({ api }: Props) {
  const [status, setStatus] = useState<ComfyUIStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api
      .getComfyUIStatus(controller.signal)
      .then(setStatus)
      .catch((caught: unknown) => {
        if (!(caught instanceof DOMException && caught.name === "AbortError")) {
          setStatus(null);
          setError(errorMessage(caught));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [api, refreshToken]);

  const reachable = status?.reachable === true;
  return (
    <div className="comfy-status" aria-live="polite">
      <div>
        <span className={`status-dot ${reachable ? "online" : "offline"}`} aria-hidden="true" />
        <strong>ComfyUI {loading ? "Checking" : reachable ? "Online" : "Offline"}</strong>
        {status?.version ? <span className="status-detail">{status.version}</span> : null}
      </div>
      {status?.devices.length ? (
        <span className="status-detail">{status.devices.join(", ")}</span>
      ) : null}
      {!reachable && status?.diagnostic ? (
        <span className="status-diagnostic">{status.diagnostic}</span>
      ) : null}
      {error ? <span className="status-diagnostic">API: {error}</span> : null}
      <button
        className="button-link"
        type="button"
        disabled={loading}
        onClick={() => {
          setLoading(true);
          setError(null);
          setRefreshToken((token) => token + 1);
        }}
      >
        Refresh
      </button>
    </div>
  );
}
