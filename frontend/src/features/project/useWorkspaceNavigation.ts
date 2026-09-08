import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { HistoryQuery, RunStatus } from "../../api/types";

export type WorkspaceView = "batch" | "gallery" | "runs";
const statuses = new Set<RunStatus>(["created", "running", "succeeded", "failed", "blocked", "cancelled"]);

function readLocation(): { view: WorkspaceView; query: HistoryQuery } {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("view");
  const status = params.get("status") as RunStatus | null;
  return {
    view: requested === "gallery" || requested === "runs" ? requested : "batch",
    query: {
      q: (params.get("q") ?? "").slice(0, 200),
      sort: params.get("sort") === "oldest" ? "oldest" : "newest",
      run_id: params.get("run") || undefined,
      batch_id: params.get("batch") || undefined,
      execution_status: status && statuses.has(status) ? status : undefined,
      execution_available: params.get("available") === "true" ? true : params.get("available") === "false" ? false : undefined,
    },
  };
}

export function useWorkspaceNavigation() {
  const [location, setLocation] = useState(readLocation);
  const previousView = useRef(location.view);
  const scrollPositions = useRef<Partial<Record<WorkspaceView, number>>>({});
  useEffect(() => {
    const previousRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    const pop = () => {
      scrollPositions.current[previousView.current] = window.scrollY;
      setLocation(readLocation());
    };
    window.addEventListener("popstate", pop);
    return () => {
      window.removeEventListener("popstate", pop);
      window.history.scrollRestoration = previousRestoration;
    };
  }, []);
  useLayoutEffect(() => {
    const previous = previousView.current;
    if (previous === location.view) return;
    previousView.current = location.view;
    // Back/Forward can navigate even while a body-portaled editor dialog is open.
    for (const dialog of Array.from(document.querySelectorAll("dialog[open]")).reverse()) {
      dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    }
    const top = scrollPositions.current[location.view] ?? 0;
    let observer: ResizeObserver | undefined;
    let stopped = false;
    function stop() {
      stopped = true;
      observer?.disconnect();
    }
    function restore() {
      if (stopped) return;
      window.scrollTo({ top, behavior: "instant" });
      if (document.documentElement.scrollHeight - window.innerHeight >= top) stop();
    }
    // Cached pages can still grow while lazy images decode; do not clamp away their saved position.
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(restore);
      observer.observe(document.querySelector("main") ?? document.body);
    }
    const timeout = window.setTimeout(stop, 3000);
    window.addEventListener("wheel", stop, { passive: true });
    window.addEventListener("touchstart", stop, { passive: true });
    window.addEventListener("keydown", stop);
    restore();
    return () => {
      stop();
      window.clearTimeout(timeout);
      window.removeEventListener("wheel", stop);
      window.removeEventListener("touchstart", stop);
      window.removeEventListener("keydown", stop);
    };
  }, [location.view]);

  function navigate(view: WorkspaceView, query?: HistoryQuery) {
    if (previousView.current !== view) scrollPositions.current[previousView.current] = window.scrollY;
    const url = new URL(window.location.href);
    if (query) writeQuery(url, query);
    if (view === "batch") url.searchParams.delete("view");
    else url.searchParams.set("view", view);
    if (url.href !== window.location.href) window.history.pushState(null, "", url);
    setLocation(readLocation());
  }

  function changeQuery(query: HistoryQuery, replace = false) {
    const url = new URL(window.location.href);
    writeQuery(url, query);
    if (url.href !== window.location.href) {
      if (replace) window.history.replaceState(null, "", url);
      else window.history.pushState(null, "", url);
    }
    setLocation(readLocation());
  }

  return { ...location, navigate, changeQuery };
}

function writeQuery(url: URL, query: HistoryQuery) {
  for (const key of ["q", "sort", "run", "batch", "status", "available"]) url.searchParams.delete(key);
  if (query.q) url.searchParams.set("q", query.q.slice(0, 200));
  if (query.sort === "oldest") url.searchParams.set("sort", query.sort);
  if (query.run_id) url.searchParams.set("run", query.run_id);
  if (query.batch_id) url.searchParams.set("batch", query.batch_id);
  if (query.execution_status) url.searchParams.set("status", query.execution_status);
  if (query.execution_available != null) url.searchParams.set("available", String(query.execution_available));
}
