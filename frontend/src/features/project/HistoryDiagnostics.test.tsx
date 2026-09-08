import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import type { HistoryDiagnosticPageResponse, HistoryDiagnosticQuery } from "../../api/types";
import { HistoryDiagnostics } from "./HistoryDiagnostics";

function page(project = "p", ordinal = 1, next: string | null = null): HistoryDiagnosticPageResponse {
  return { project_id: project, generation: "g", scanned_at: null, next_cursor: next, has_more: !!next,
    items: [{ ordinal, scope: "run", entity_id: `run-${ordinal}`, name_excerpt: `Example ${ordinal}`, display_truncated: false, code: "invalid_run", message: "Run is invalid; check v1 records, ownership, and snapshot integrity" }] };
}

describe("HistoryDiagnostics", () => {
  it("loads one bounded page, navigates, and explicitly refreshes without a cursor", async () => {
    const browseProjectDiagnostics = vi.fn(async (_id: string, query?: HistoryDiagnosticQuery) => page("p", query?.cursor ? 2 : 1, query?.cursor ? null : "next"));
    const onClose = vi.fn();
    render(<HistoryDiagnostics api={{ browseProjectDiagnostics }} projectId="p" onClose={onClose} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading diagnostics");
    await screen.findByText("Run: Example 1");
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(browseProjectDiagnostics).toHaveBeenCalledWith("p", { limit: 25, cursor: undefined }, expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Run: Example 2");
    expect(screen.queryByText("Run: Example 1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await screen.findByText("Run: Example 1");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Run: Example 1");
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("cancels obsolete Project and unmount requests and ignores late responses", async () => {
    const pending: { resolve: (page: HistoryDiagnosticPageResponse) => void; signal?: AbortSignal }[] = [];
    const browseProjectDiagnostics = vi.fn((_id: string, _query?: HistoryDiagnosticQuery, signal?: AbortSignal) => new Promise<HistoryDiagnosticPageResponse>((resolve) => pending.push({ resolve, signal })));
    const api = { browseProjectDiagnostics };
    const view = render(<HistoryDiagnostics api={api} projectId="p" onClose={vi.fn()} />);
    view.rerender(<HistoryDiagnostics api={api} projectId="other" onClose={vi.fn()} />);
    expect(pending[0].signal?.aborted).toBe(true);
    await act(async () => pending[0].resolve(page("p")));
    expect(screen.queryByText("Run: Example 1")).not.toBeInTheDocument();
    await act(async () => pending[1].resolve(page("other", 2)));
    expect(screen.getByText("Run: Example 2")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(pending[1].signal?.aborted).toBe(true);
    view.unmount();
    expect(pending[2].signal?.aborted).toBe(true);
    await act(async () => pending[2].resolve(page("other", 3)));
  });

  it("shows stale-generation guidance, then an honest empty refreshed page", async () => {
    const browseProjectDiagnostics = vi.fn().mockResolvedValueOnce(page("p", 1, "next"))
      .mockRejectedValueOnce(new ApiError("secret", "history_generation_changed", 409))
      .mockResolvedValue({ ...page(), items: [] });
    render(<HistoryDiagnostics api={{ browseProjectDiagnostics }} projectId="p" onClose={vi.fn()} />);
    await screen.findByText("Run: Example 1");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("History changed. Refresh");
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText(/No diagnostics in this indexed page/);
    expect(browseProjectDiagnostics.mock.lastCall?.[1]).toEqual({ limit: 25, cursor: undefined });
  });

  it("explains that missing diagnostics support requires a backend restart, not reindexing", async () => {
    const browseProjectDiagnostics = vi.fn().mockRejectedValue(new ApiError("private detail", "history_browser_unavailable", 404));
    const onReindex = vi.fn();
    render(<HistoryDiagnostics api={{ browseProjectDiagnostics }} projectId="p" onClose={vi.fn()} onReindex={onReindex} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Restart the backend");
    expect(screen.getByRole("alert")).toHaveTextContent("Reindexing cannot fix a missing API route");
    expect(screen.queryByText("private detail")).not.toBeInTheDocument();
    expect(onReindex).not.toHaveBeenCalled();
  });

  it("ignores a late page after Refresh and delegates repair to the owner", async () => {
    let resolve!: (value: HistoryDiagnosticPageResponse) => void;
    const pending = new Promise<HistoryDiagnosticPageResponse>((done) => { resolve = done; });
    const browseProjectDiagnostics = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(page("p", 2));
    const onClose = vi.fn();
    const onReindex = vi.fn();
    render(<HistoryDiagnostics api={{ browseProjectDiagnostics }} projectId="p" onClose={onClose} onReindex={onReindex} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Run: Example 2");
    expect(browseProjectDiagnostics.mock.calls[0][2].aborted).toBe(true);
    await act(async () => resolve(page("p", 1)));
    expect(screen.queryByText("Run: Example 1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reindex Project" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onReindex).toHaveBeenCalledOnce();
  });

  it("reports failures and mismatched responses without claiming emptiness", async () => {
    const browseProjectDiagnostics = vi.fn().mockRejectedValueOnce(new Error("/private/secret"))
      .mockResolvedValue(page("foreign"));
    render(<HistoryDiagnostics api={{ browseProjectDiagnostics }} projectId="p" onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Diagnostics could not be loaded");
    expect(screen.queryByText(/No diagnostics/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("Run: Example 1")).not.toBeInTheDocument();
    expect(screen.queryByText("/private/secret")).not.toBeInTheDocument();
  });

  it("retains at most 20 Previous bookmarks rather than caching pages", async () => {
    const browseProjectDiagnostics = vi.fn(async (_id: string, query?: HistoryDiagnosticQuery) => {
      const ordinal = Number(query?.cursor ?? 1);
      return page("p", ordinal, String(ordinal + 1));
    });
    render(<HistoryDiagnostics api={{ browseProjectDiagnostics }} projectId="p" onClose={vi.fn()} />);
    for (let i = 1; i <= 22; i++) {
      await screen.findByText(`Run: Example ${i}`);
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
    }
    await screen.findByText("Run: Example 23");
    for (let i = 22; i >= 3; i--) {
      fireEvent.click(screen.getByRole("button", { name: "Previous" }));
      await screen.findByText(`Run: Example ${i}`);
    }
    await waitFor(() => expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled());
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });
});
