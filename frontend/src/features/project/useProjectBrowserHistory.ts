import { useEffect, useEffectEvent, useRef, useState } from "react";

import { ApiError, type BatchcraftApi } from "../../api/client";
import type {
  HistoryQuery,
  HistoryResultItemResponse,
  HistoryResultPageResponse,
  HistoryRunPageResponse,
} from "../../api/types";
import { errorMessage } from "../../utils/errors";

type View = "gallery" | "runs";
type Page =
  | { view: "gallery"; response: HistoryResultPageResponse }
  | { view: "runs"; response: HistoryRunPageResponse };
type Position = {
  key: string;
  cursor: string | null;
  number: number;
  previous: Array<string | null>;
};

// A dispatched scan must finish before another scan starts, even across Project remounts.
const scanQueues = new WeakMap<BatchcraftApi, Promise<void>>();

export function useProjectBrowserHistory(
  api: BatchcraftApi,
  projectId: string,
  active: boolean,
  view: View,
  query: HistoryQuery,
  historyRevision: number,
) {
  const queryKey = JSON.stringify([
    projectId,
    view,
    query.q ?? "",
    query.sort ?? "newest",
    query.run_id ?? null,
    query.batch_id ?? null,
    query.execution_status ?? null,
    query.execution_available ?? null,
  ]);
  const [page, setPage] = useState<{
    key: string;
    position: Position;
    data: Page;
  } | null>(null);
  const publishedPage = useRef<typeof page>(null);
  function publishPage(next: typeof page) {
    publishedPage.current = next;
    setPage(next);
  }
  const [position, setPosition] = useState<Position>({
    key: queryKey,
    cursor: null,
    number: 1,
    previous: [],
  });
  const [reload, setReload] = useState(0);
  const [repair, setRepair] = useState(0);
  const adoptedRepair = useRef(0);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [updated, setUpdated] = useState(false);
  const [diagnostics, setDiagnostics] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [unavailableRuns, setUnavailableRuns] = useState<Set<string>>(
    new Set(),
  );
  const [awaitingResults, setAwaitingResults] = useState<Set<string>>(
    new Set(),
  );
  const [scope, setScope] = useState({ key: queryKey, view });
  // One inactive-view snapshot plus the active state: never more than two pages.
  const [cachedView, setCachedView] = useState<{
    key: string;
    view: View;
    page: typeof page;
    position: Position;
    error: string | null;
    updated: boolean;
    unavailableRuns: Set<string>;
    awaitingResults: Set<string>;
  } | null>(null);
  if (scope.key !== queryKey) {
    const restored = cachedView?.key === queryKey ? cachedView : null;
    if (scope.view !== view) {
      setCachedView({
        ...scope,
        page,
        position,
        error,
        updated,
        unavailableRuns,
        awaitingResults,
      });
    }
    setScope({ key: queryKey, view });
    setPage(restored?.page ?? null);
    setPosition(
      restored?.position ?? {
        key: queryKey,
        cursor: null,
        number: 1,
        previous: [],
      },
    );
    setError(restored?.error ?? null);
    setUpdated(restored?.updated ?? false);
    setUnavailableRuns(restored?.unavailableRuns ?? new Set());
    setAwaitingResults(restored?.awaitingResults ?? new Set());
  }
  const initialRead = useRef<Promise<void>>(Promise.resolve());
  const readSequence = useRef(0);
  const visible = page?.key === queryKey ? page : null;
  const target =
    position.key === queryKey
      ? position
      : { key: queryKey, cursor: null, number: 1, previous: [] };
  const cursor = target.cursor;
  const syncPublishedPage = useEffectEvent(() => {
    publishedPage.current = visible;
  });

  const reconcile = useEffectEvent((data: Page, key: string, adopt = false) => {
    if (key !== queryKey) return;
    // An immediate scan can finish before React commits the initial read.
    const visible =
      publishedPage.current?.key === key ? publishedPage.current : null;
    if (
      adopt || !visible || !visible.data.response.items.length
    ) {
      const first = { key, cursor: null, number: 1, previous: [] };
      publishPage({ key, position: first, data });
      setPosition(first);
      setError(null);
      setUpdated(false);
      setUnavailableRuns(new Set());
      setAwaitingResults(new Set());
      return;
    }
    if (data.response.generation !== visible.data.response.generation) {
      const current = visible.data;
      const identical =
        current.view === data.view &&
        current.response.items.length === data.response.items.length &&
        current.response.items.every((item, index) => {
          const { run, ...fields } = item;
          const { run: nextRun, ...nextFields } = data.response.items[index];
          return sameFields(run, nextRun) && sameFields(fields, nextFields);
        });
      if (visible.position.cursor === null && identical) {
        // Only page one can adopt a new generation without retaining old bookmarks.
        // Keep the item objects so images, failures, and viewer identity stay in place.
        const metadata = {
          generation: data.response.generation,
          scanned_at: data.response.scanned_at,
          next_cursor: data.response.next_cursor,
          has_more: data.response.has_more,
        };
        publishPage({
          ...visible,
          data:
            current.view === "gallery"
              ? {
                  view: "gallery",
                  response: { ...current.response, ...metadata },
                }
              : {
                  view: "runs",
                  response: { ...current.response, ...metadata },
                },
        });
        setError(null);
        setUpdated(false);
        setUnavailableRuns(new Set());
        setAwaitingResults(new Set());
        return;
      }
      setUpdated(true);
      // Retain the page, but never keep serving an image known to have lost execution.
      const availability = new Map(
        data.response.items.map((item) => [
          item.run.run_id,
          item.run.execution_available,
        ]),
      );
      setUnavailableRuns(
        (old) =>
          new Set([
            ...old,
            ...visible.data.response.items
              .filter((item) => availability.get(item.run.run_id) === false)
              .map((item) => item.run.run_id),
          ]),
      );
      if (current.view === "gallery" && data.view === "gallery") {
        const latest = new Map(
          data.response.items.map((item) => [
            historyResultIdentity(item),
            item,
          ]),
        );
        setAwaitingResults(
          new Set(
            current.response.items.flatMap((item) => {
              const identity = historyResultIdentity(item);
              const next = latest.get(identity);
              // Absence from a bounded page is not evidence of deletion. It does mean
              // the retained download cannot be confirmed by this generation.
              const healthy =
                next?.run.execution_available &&
                next.integrity_status === "verified" &&
                next.download_unavailable_reason === null &&
                !!next.download_url &&
                next.download_url === item.download_url &&
                next.sha256 === item.sha256 &&
                next.job_ordinal === item.job_ordinal &&
                next.content_type === item.content_type &&
                next.byte_size === item.byte_size;
              return healthy ? [] : [identity];
            }),
          ),
        );
      }
    }
  });

  const read = useEffectEvent(async (signal: AbortSignal, adopt: boolean) => {
    const sequence = ++readSequence.current;
    const key = queryKey;
    const requestedPosition = target;
    setLoading(true);
    setError(null);
    try {
      const request = {
        ...query,
        limit: view === "gallery" ? 48 : 25,
        cursor: requestedPosition.cursor,
      };
      const data: Page =
        view === "gallery"
          ? {
              view,
              response: await api.browseProjectResults(
                projectId,
                request,
                signal,
              ),
            }
          : {
              view,
              response: await api.browseProjectRuns(projectId, request, signal),
            };
      if (signal.aborted || sequence !== readSequence.current) return;
      if (data.response.project_id !== projectId)
        throw new Error("History did not match the selected Project.");
      if (
        requestedPosition.cursor &&
        visible &&
        data.response.generation !== visible.data.response.generation
      ) {
        throw new ApiError(
          "History changed. Refresh to start a new page sequence.",
          "history_generation_changed",
          409,
        );
      }
      if (
        !adopt &&
        visible &&
        visible.position.cursor === requestedPosition.cursor
      ) {
        reconcile(data, key);
      } else {
        publishPage({ key, position: requestedPosition, data });
        setUpdated(false);
        setUnavailableRuns(new Set());
        setAwaitingResults(new Set());
      }
    } catch (caught) {
      if (signal.aborted || sequence !== readSequence.current) return;
      if (
        caught instanceof ApiError &&
        caught.code === "history_generation_changed"
      ) {
        setUpdated(true);
        const retained = publishedPage.current;
        if (retained?.key === key && retained.data.view === "gallery") {
          setAwaitingResults(
            new Set(retained.data.response.items.map(historyResultIdentity)),
          );
        }
      }
      setError(errorMessage(caught));
    } finally {
      if (!signal.aborted && sequence === readSequence.current)
        setLoading(false);
    }
  });

  const checkLatest = useEffectEvent(async (signal: AbortSignal, adopt = false) => {
    const key = queryKey;
    const sequence = readSequence.current;
    const request = {
      ...query,
      cursor: null,
      limit: view === "gallery" ? 48 : 25,
    };
    try {
      const data: Page =
        view === "gallery"
          ? {
              view,
              response: await api.browseProjectResults(
                projectId,
                request,
                signal,
              ),
            }
          : {
              view,
              response: await api.browseProjectRuns(projectId, request, signal),
            };
      if (signal.aborted || sequence !== readSequence.current) return;
      if (data.response.project_id !== projectId)
        throw new Error("History did not match the selected Project.");
      reconcile(data, key, adopt);
    } catch (caught) {
      if (!signal.aborted && sequence === readSequence.current) throw caught;
    }
  });

  const beginScan = useEffectEvent(() => {
    setScanning(true);
    setScanError(null);
  });
  const finishScan = useEffectEvent((count: number) => {
    setDiagnostics(count);
    setConfirmed(true);
  });
  const previousRead = useRef<number | null>(null);
  useEffect(() => {
    syncPublishedPage();
    if (!active) return;
    const controller = new AbortController();
    const adopt = previousRead.current !== reload;
    previousRead.current = reload;
    initialRead.current = read(controller.signal, adopt);
    return () => {
      controller.abort();
    };
  }, [active, api, projectId, queryKey, cursor, reload]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const queued = (scanQueues.get(api) ?? Promise.resolve()).then(async () => {
      await initialRead.current;
      if (controller.signal.aborted) return;
      beginScan();
      try {
        const response = await api.reindexProject(projectId);
        if (controller.signal.aborted) return;
        if (response.project_id !== projectId)
          throw new Error("Reindex did not match the selected Project.");
        finishScan(response.diagnostic_count);
        await initialRead.current;
        if (controller.signal.aborted) return;
        await checkLatest(controller.signal, repair > adoptedRepair.current);
        if (!controller.signal.aborted) adoptedRepair.current = repair;
      } catch (caught) {
        if (!controller.signal.aborted) setScanError(errorMessage(caught));
      } finally {
        if (!controller.signal.aborted) setScanning(false);
      }
    });
    scanQueues.set(api, queued);
    return () => controller.abort();
  }, [active, api, projectId, historyRevision, repair]);

  function refresh() {
    setPosition({ key: queryKey, cursor: null, number: 1, previous: [] });
    setReload((value) => value + 1);
  }

  function navigate(direction: -1 | 1) {
    if (!visible || loading || updated) return;
    const current = visible.position;
    if (direction === 1 && visible.data.response.next_cursor) {
      setPosition({
        key: queryKey,
        cursor: visible.data.response.next_cursor,
        number: current.number + 1,
        previous: [...current.previous, current.cursor].slice(-20),
      });
    } else if (direction === -1 && current.previous.length) {
      setPosition({
        key: queryKey,
        cursor: current.previous.at(-1) ?? null,
        number: current.number - 1,
        previous: current.previous.slice(0, -1),
      });
    }
  }

  return {
    page: visible?.data ?? null,
    pageNumber: visible?.position.number ?? 1,
    canPrevious: !!visible?.position.previous.length,
    loading,
    scanning,
    error,
    scanError,
    updated,
    diagnostics,
    confirmed,
    unavailableRuns,
    awaitingResults,
    refresh,
    navigate,
    repair: () => setRepair((value) => value + 1),
  };
}

export function historyResultIdentity(item: HistoryResultItemResponse) {
  return JSON.stringify([item.run.run_id, item.job_id, item.artifact_ordinal]);
}

function sameFields(left: object, right: object): boolean {
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.entries(left).every(
      ([key, value]) =>
        Object.hasOwn(right, key) &&
        value === (right as Record<string, unknown>)[key],
    )
  );
}
