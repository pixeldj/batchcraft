import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, type BatchcraftApi } from "../../api/client";
import type {
  HistoryResultItemResponse,
  HistoryResultPageResponse,
  HistoryRunSummaryResponse,
  HistoryProvenanceFilters,
  ParameterValueType,
  ProjectImportResponse,
  ResultsResponse,
  RunResponse,
} from "../../api/types";
import { ProjectBrowser, type ProjectBrowserProps } from "./ProjectBrowser";
import { ResultDetailsDialog } from "../results/ResultDetailsDialog";

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    }),
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) {
      this.open = false;
    }),
  });
});

describe("ProjectBrowser", () => {
  it.each([
    ["boolean", false], ["integer", 0], ["float", 0], ["string", ""], ["float", null],
  ] as const)("filters Details using frozen %s %j and preserves conjunction", async (valueType, value) => {
    const run = frozenRun("original");
    run.plan.jobs[0].resolved_parameters = [{ parameter_key: "target", label: "Frozen value", value }];
    run.batch_snapshot.workflow_selection.workflow_profile = { parameters: [
      { key: "target", label: "Other label", node_id: "1", input_name: "value", value_type: valueType },
    ] };
    const api = makeApi({ getRun: vi.fn(async () => run), getResults: vi.fn(async () => resultResponse("original")) });
    const p = props(api);
    p.query = { q: "study", sort: "oldest", execution_status: "succeeded", execution_available: false,
      run_id: "original", batch_id: "batch", filters: { seed: 0, asset_id: "other-asset", parameters: [
        { key: "target", value_type: valueType, mode: "override" },
        { key: "target", value_type: valueType === "string" ? "integer" : "string", mode: "base" },
      ] } };
    render(<ProjectBrowser {...p} />);
    fireEvent.click(await screen.findByRole("button", { name: /^View original/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Image Details" }));
    fireEvent.click(await screen.findByRole("button", { name: `Filter Gallery by Frozen value (${valueType})` }));
    expect(p.onViewChange).toHaveBeenCalledExactlyOnceWith("gallery", { ...p.query, cursor: null, filters: {
      ...p.query.filters, parameters: [p.query.filters!.parameters![1], {
        key: "target", value_type: valueType, mode: value === null ? "base" : "equals",
        ...(value === null ? {} : { value }),
      }],
    } });
    expect(p.onQueryChange).not.toHaveBeenCalled();
    expect(p.loadRunAsBatch).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
  });

  it.each([
    ["Seed", { seed: 4 }],
    ["Prompt revision", { prompt_version_id: "prompt" }],
    ["Workflow revision", { workflow_version_id: "historical-workflow-version" }],
    ["Profile revision", { profile_version_id: "historical-profile-version" }],
    ["Reference slot", { image_inputs: [{ slot_key: "reference", mode: "asset", asset_id: "historical-asset" }] }],
    ["Reference Asset in any slot", { asset_id: "historical-asset" }],
    ["Base image slot", { image_inputs: [{ slot_key: "base_image", mode: "base" }] }],
  ] satisfies Array<[string, HistoryProvenanceFilters]>)("filters %s without current library ancestry", async (label, filter: HistoryProvenanceFilters) => {
    const run = frozenRun("original");
    Object.assign(run.batch_snapshot.workflow_selection, {
      workflow_version_id: "historical-workflow-version", workflow_profile_version_id: "historical-profile-version",
    });
    run.plan.jobs[0].resolved_image_inputs = [
      { slot_key: "reference", label: "Reference", asset_id: "historical-asset", filename: "same-label.png" },
      { slot_key: "base_image", label: "Base image", asset_id: null, filename: null },
    ];
    const api = makeApi({ getRun: vi.fn(async () => run), getResults: vi.fn(async () => resultResponse("original")) });
    const p = props(api);
    p.query = { filters: { prompt_id: "existing-ancestry", image_inputs: [{ slot_key: "reference", mode: "base" }] } };
    render(<ProjectBrowser {...p} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Details for/ }));
    fireEvent.click(await screen.findByRole("button", { name: `Filter Gallery by ${label}` }));
    const images = filter.image_inputs
      ? [...p.query.filters!.image_inputs!.filter((image) => image.slot_key !== filter.image_inputs![0].slot_key), ...filter.image_inputs]
      : p.query.filters!.image_inputs;
    expect(p.onViewChange).toHaveBeenCalledExactlyOnceWith("gallery", {
      ...p.query, cursor: null, filters: { ...p.query.filters, ...filter, image_inputs: images },
    });
    expect(api.getHistoryChoices).not.toHaveBeenCalled();
  });

  it.each(["parameter", "image"] as const)("allows replacement at the %s cap but rejects a new predicate without truncation", async (kind) => {
    const run = frozenRun("original");
    run.plan.jobs[0].resolved_parameters = ["existing", "new"].map((key) => ({ parameter_key: key, label: key, value: 0 }));
    run.batch_snapshot.workflow_selection.workflow_profile = { parameters: ["existing", "new"].map((key) => ({
      key, label: key, node_id: "1", input_name: key, value_type: "integer",
    })) };
    run.plan.jobs[0].resolved_image_inputs = ["existing", "new"].map((key) => ({ slot_key: key, label: key, asset_id: null, filename: null }));
    const api = makeApi({ getRun: vi.fn(async () => run), getResults: vi.fn(async () => resultResponse("original")) });
    const p = props(api);
    p.query = { filters: kind === "parameter" ? { parameters: Array.from({ length: 8 }, (_, i) => ({
      key: i ? `key${i}` : "existing", value_type: "integer" as ParameterValueType, mode: "base" as const,
    })) } : { image_inputs: Array.from({ length: 4 }, (_, i) => ({ slot_key: i ? `slot${i}` : "existing", mode: "asset" as const, asset_id: "old" })) } };
    const before = structuredClone(p.query);
    render(<ProjectBrowser {...p} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Details for/ }));
    const suffix = kind === "parameter" ? "(integer)" : "slot";
    fireEvent.click(await screen.findByRole("button", { name: `Filter Gallery by new ${suffix}` }));
    expect(screen.getByRole("alert")).toHaveTextContent(kind === "parameter" ? "at most 8" : "at most 4");
    expect(p.onViewChange).not.toHaveBeenCalled();
    expect(p.query).toEqual(before);
    fireEvent.click(screen.getByRole("button", { name: `Filter Gallery by existing ${suffix}` }));
    expect(p.onViewChange).toHaveBeenCalledTimes(1);
    const next = vi.mocked(p.onViewChange).mock.calls[0][1]!.filters!;
    expect(kind === "parameter" ? next.parameters : next.image_inputs).toHaveLength(kind === "parameter" ? 8 : 4);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("offers no actions for unsupported or missing provenance, or without an optional callback", () => {
    const run = frozenRun("original");
    run.plan.jobs[0].prompt_version_id = "";
    run.plan.jobs[0].seed = Number.MAX_SAFE_INTEGER + 1;
    run.plan.jobs[0].resolved_parameters = [
      { parameter_key: "missing", label: "Missing", value: false },
      { parameter_key: "unsupported", label: "Unsupported", value: "text" },
    ];
    run.batch_snapshot.workflow_selection.workflow_profile = { parameters: [
      { key: "unsupported", label: "Unsupported", node_id: "1", input_name: "x", value_type: "enum" },
    ] };
    const p = { runId: "original", result: resultResponse("original").results[0], execution: null,
      restoreTarget: null, getCachedRun: () => run, loadRun: vi.fn(), onClose: vi.fn() };
    const ui = render(<ResultDetailsDialog {...p} onFilter={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /^Filter Gallery/ })).not.toBeInTheDocument();
    run.plan.jobs[0].seed = 0;
    ui.rerender(<ResultDetailsDialog {...p} />);
    expect(screen.queryByRole("button", { name: /^Filter Gallery/ })).not.toBeInTheDocument();
    run.plan.jobs = [];
    ui.rerender(<ResultDetailsDialog {...p} onFilter={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Frozen Job 1 is unavailable");
    expect(screen.queryByRole("button", { name: /^Filter Gallery/ })).not.toBeInTheDocument();
  });

  it("rejects a Result hash mismatch before offering frozen filter actions", async () => {
    const api = makeApi({ getRun: vi.fn(async () => frozenRun("original")), getResults: vi.fn(async () => resultResponse("wrong-hash")) });
    const response = resultResponse("wrong-hash");
    response.run_id = "original";
    vi.mocked(api.getResults).mockResolvedValue(response);
    render(<ProjectBrowser {...props(api)} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Details for/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be matched to its frozen Job");
    expect(screen.queryByRole("button", { name: /^Filter Gallery/ })).not.toBeInTheDocument();
  });

  it("reads a bounded index before scanning, with no per-Run fanout or legacy history", async () => {
    const first = deferred<HistoryResultPageResponse>();
    const api = makeApi({ browseProjectResults: vi.fn(() => first.promise) });
    render(<ProjectBrowser {...props(api)} />);
    expect(api.browseProjectResults).toHaveBeenCalledWith(
      "project",
      { limit: 48, cursor: null },
      expect.any(AbortSignal),
    );
    expect(api.reindexProject).not.toHaveBeenCalled();
    await act(async () => first.resolve(page([item("second"), item("first")])));
    await waitFor(() => expect(api.reindexProject).toHaveBeenCalledTimes(1));
    expect(
      screen
        .getAllByRole("article")
        .map((node) => node.getAttribute("data-run-id")),
    ).toEqual(["second", "first"]);
    expect(screen.getByText("2 Results on this page")).toBeInTheDocument();
    expect(api.getResults).not.toHaveBeenCalled();
    expect(api.getRun).not.toHaveBeenCalled();
    expect(api.listProjectRuns).not.toHaveBeenCalled();
    for (const image of screen.getAllByRole("img")) {
      expect(image).toHaveAttribute("loading", "lazy");
      expect(image).toHaveAttribute("decoding", "async");
    }
  });

  it("does no work while inactive and joins a dispatched scan before activation rescans", async () => {
    const scan = deferred<ProjectImportResponse>();
    const api = makeApi({ reindexProject: vi.fn(() => scan.promise) });
    const p = props(api);
    const ui = render(
      <StrictMode>
        <ProjectBrowser {...p} active={false} />
      </StrictMode>,
    );
    expect(api.browseProjectResults).not.toHaveBeenCalled();
    ui.rerender(
      <StrictMode>
        <ProjectBrowser {...p} />
      </StrictMode>,
    );
    await waitFor(() => expect(api.reindexProject).toHaveBeenCalledTimes(1));
    ui.rerender(
      <StrictMode>
        <ProjectBrowser {...p} active={false} />
      </StrictMode>,
    );
    const calls = vi.mocked(api.browseProjectResults).mock.calls.length;
    ui.rerender(
      <StrictMode>
        <ProjectBrowser {...p} />
      </StrictMode>,
    );
    await waitFor(() =>
      expect(api.browseProjectResults).toHaveBeenCalledTimes(calls + 1),
    );
    expect(api.reindexProject).toHaveBeenCalledTimes(1);
    await act(async () => scan.resolve(scanResponse()));
    await waitFor(() => expect(api.reindexProject).toHaveBeenCalledTimes(2));
  });

  it("submits Run-name/notes search without scanning on every filter or density change", async () => {
    const api = makeApi();
    const p = props(api);
    const ui = render(<ProjectBrowser {...p} />);
    await screen.findByRole("article");
    await waitFor(() => expect(api.reindexProject).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Run names and notes"), {
      target: { value: "portrait" },
    });
    expect(p.onQueryChange).not.toHaveBeenCalled();
    fireEvent.submit(
      screen.getByLabelText("Run names and notes").closest("form")!,
    );
    expect(p.onQueryChange).toHaveBeenCalledWith({
      q: "portrait",
      cursor: null,
    });
    ui.rerender(
      <ProjectBrowser
        {...p}
        query={{ q: "portrait", execution_available: false }}
      />,
    );
    await waitFor(() =>
      expect(api.browseProjectResults).toHaveBeenLastCalledWith(
        "project",
        { q: "portrait", execution_available: false, limit: 48, cursor: null },
        expect.any(AbortSignal),
      ),
    );
    const reads = vi.mocked(api.browseProjectResults).mock.calls.length;
    fireEvent.change(screen.getByLabelText("Image size"), {
      target: { value: "spacious" },
    });
    expect(api.browseProjectResults).toHaveBeenCalledTimes(reads);
    expect(api.reindexProject).toHaveBeenCalledTimes(1);
  });

  it("ignores late query and cross-Project responses", async () => {
    const old = deferred<HistoryResultPageResponse>();
    const api = makeApi({
      browseProjectResults: vi.fn((projectId, query) =>
        query?.q === "old"
          ? old.promise
          : Promise.resolve({ ...page([item("new")]), project_id: projectId }),
      ),
    });
    const p = props(api);
    const ui = render(<ProjectBrowser {...p} query={{ q: "old" }} />);
    ui.rerender(<ProjectBrowser {...p} query={{ q: "new" }} />);
    expect(await screen.findByText("new")).toBeInTheDocument();
    ui.rerender(
      <ProjectBrowser {...p} projectId="other" query={{ q: "new" }} />,
    );
    await act(async () => old.resolve(page([item("old")])));
    expect(screen.queryByText("old")).not.toBeInTheDocument();
    expect(screen.getByText("new")).toBeInTheDocument();
  });

  it("retains a single page, rejects mixed generations, and Refresh restarts without a cursor", async () => {
    const api = makeApi({
      browseProjectResults: vi.fn(async (_id, query) =>
        query?.cursor
          ? page([item("new-generation")], "g2")
          : {
              ...page([item("original")]),
              has_more: true,
              next_cursor: "next",
            },
      ),
    });
    render(<ProjectBrowser {...props(api)} />);
    await screen.findByText("original");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "History changed",
    );
    expect(screen.queryByText("new-generation")).not.toBeInTheDocument();
    expect(screen.getByText("original")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(api.browseProjectResults).toHaveBeenLastCalledWith(
        "project",
        { limit: 48, cursor: null },
        expect.any(AbortSignal),
      ),
    );
    expect(await screen.findByText("Page 1")).toBeInTheDocument();
  });

  it("replaces rather than appends pages and can go back with bounded bookmarks", async () => {
    const api = makeApi({
      browseProjectResults: vi.fn(async (_id, query) =>
        query?.cursor
          ? page([item("page-two")])
          : {
              ...page([item("page-one")]),
              has_more: true,
              next_cursor: "next",
            },
      ),
    });
    render(<ProjectBrowser {...props(api)} />);
    await screen.findByText("page-one");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("page-two");
    expect(screen.queryByText("page-one")).not.toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    await screen.findByText("page-one");
    expect(screen.queryByText("page-two")).not.toBeInTheDocument();
  });

  it("preserves independent Gallery and Runs pages and bookmarks without extra scans on view switches", async () => {
    const api = makeApi({
      browseProjectResults: vi.fn(async (_id, query) => ({
        ...page([item(query?.cursor ? "gallery-two" : "gallery-one")]),
        has_more: !query?.cursor,
        next_cursor: query?.cursor ? null : "gallery-next",
      })),
      browseProjectRuns: vi.fn(async (_id, query) => ({
        ...page([]),
        items: [
          {
            run: summary(query?.cursor ? "runs-two" : "runs-one"),
            result_count: 1,
          },
        ],
        has_more: !query?.cursor,
        next_cursor: query?.cursor ? null : "runs-next",
      })),
    });
    const p = props(api);
    const ui = render(<ProjectBrowser {...p} />);
    await screen.findByText("gallery-one");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("gallery-two");
    ui.rerender(<ProjectBrowser {...p} view="runs" />);
    await screen.findByText("runs-one");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("runs-two");
    ui.rerender(
      <ProjectBrowser
        {...p}
        query={{ sort: "newest", q: "", execution_available: null }}
      />,
    );
    expect(screen.getByText("gallery-two")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Previous page" }),
      ).toBeEnabled(),
    );
    expect(api.browseProjectResults).toHaveBeenLastCalledWith(
      "project",
      expect.objectContaining({ cursor: "gallery-next", limit: 48 }),
      expect.any(AbortSignal),
    );
    expect(screen.getByText("Page 2")).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(1);
    ui.rerender(<ProjectBrowser {...p} view="runs" />);
    expect(screen.getByText("runs-two")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Previous page" }),
      ).toBeEnabled(),
    );
    expect(api.browseProjectRuns).toHaveBeenLastCalledWith(
      "project",
      expect.objectContaining({ cursor: "runs-next", limit: 25 }),
      expect.any(AbortSignal),
    );
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    await screen.findByText("runs-one");
    expect(api.reindexProject).toHaveBeenCalledTimes(1);
  });

  it("keeps a cached Gallery page on stale-cursor revalidation but disables every retained download", async () => {
    const api = makeApi({
      browseProjectResults: vi
        .fn()
        .mockResolvedValueOnce({
          ...page([item("first")]),
          has_more: true,
          next_cursor: "g1-next",
        })
        .mockResolvedValueOnce(
          page([
            item("second"),
            { ...item("file"), content_type: "application/json" },
          ]),
        )
        .mockRejectedValueOnce(
          new ApiError("Refresh history", "history_generation_changed", 409),
        )
        .mockResolvedValue(page([item("new-first")], "g2")),
    });
    const p = props(api);
    const ui = render(<ProjectBrowser {...p} />);
    await screen.findByText("first");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("second");
    ui.rerender(<ProjectBrowser {...p} view="runs" />);
    await screen.findByRole("article");
    ui.rerender(<ProjectBrowser {...p} />);
    expect(screen.getByText("Page 2")).toBeInTheDocument();
    await screen.findByRole("alert");
    expect(screen.getAllByText("Awaiting history refresh")).toHaveLength(2);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open original" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument();
    expect(screen.getByText("file")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("new-first");
    expect(screen.getByText("Page 1")).toBeInTheDocument();
    expect(screen.getByRole("img")).toBeInTheDocument();
  });

  it("evicts the older query for each view rather than accumulating query pages", async () => {
    const api = makeApi({
      browseProjectResults: vi.fn(async (_id, query) => ({
        ...page([item(query?.cursor ? "second" : query?.q || "first")]),
        has_more: !query?.cursor,
        next_cursor: query?.cursor ? null : "next",
      })),
    });
    const p = props(api);
    const ui = render(<ProjectBrowser {...p} />);
    await screen.findByText("first");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("second");
    ui.rerender(<ProjectBrowser {...p} view="runs" />);
    await screen.findByRole("article");
    ui.rerender(<ProjectBrowser {...p} query={{ q: "new-query" }} />);
    await screen.findByText("new-query", { selector: "strong" });
    ui.rerender(
      <ProjectBrowser {...p} view="runs" query={{ q: "new-query" }} />,
    );
    await screen.findByRole("article");
    ui.rerender(<ProjectBrowser {...p} />);
    expect(screen.queryByText("second")).not.toBeInTheDocument();
    await screen.findByText("first");
    expect(screen.getByText("Page 1")).toBeInTheDocument();
    expect(api.browseProjectResults).toHaveBeenLastCalledWith(
      "project",
      { limit: 48, cursor: null },
      expect.any(AbortSignal),
    );
  });

  it("starts at the first page when filters change, including returning to an earlier filter", async () => {
    const api = makeApi({
      browseProjectResults: vi.fn(async (_id, query) =>
        query?.cursor
          ? page([item("page-two")])
          : {
              ...page([item(query?.q ?? "page-one")]),
              has_more: true,
              next_cursor: "next",
            },
      ),
    });
    const p = props(api);
    const ui = render(<ProjectBrowser {...p} />);
    await screen.findByText("page-one");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("page-two");
    ui.rerender(<ProjectBrowser {...p} query={{ q: "filtered" }} />);
    await screen.findByText("filtered", { selector: "strong" });
    ui.rerender(<ProjectBrowser {...p} />);
    await screen.findByText("page-one");
    expect(api.browseProjectResults).toHaveBeenLastCalledWith(
      "project",
      { limit: 48, cursor: null },
      expect.any(AbortSignal),
    );
    expect(screen.getByText("Page 1")).toBeInTheDocument();
  });

  it("keeps an inspected collection stable when scanning finds a new generation", async () => {
    const scan = deferred<ProjectImportResponse>();
    const api = makeApi({
      reindexProject: vi.fn(() => scan.promise),
      browseProjectResults: vi
        .fn()
        .mockResolvedValueOnce(page([item("original")]))
        .mockResolvedValue(page([item("latest"), item("original")], "g2")),
    });
    render(<ProjectBrowser {...props(api)} />);
    const opener = await screen.findByRole("button", {
      name: /^View original/,
    });
    opener.focus();
    fireEvent.click(opener);
    expect(document.body.style.overflow).toBe("hidden");
    await act(async () => scan.resolve(scanResponse()));
    await screen.findByText("History updated. Refresh when you are ready.");
    expect(screen.getByRole("dialog")).toHaveTextContent("original");
    expect(screen.queryByText("latest")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(document.body.style.overflow).toBe("");
    expect(opener).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("latest")).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("article")
        .map((node) => node.getAttribute("data-run-id")),
    ).toEqual(["latest", "original"]);
    expect(api.reindexProject).toHaveBeenCalledTimes(1);
  });

  it.each(["gallery", "runs"] as const)(
    "adopts identical first-page %s metadata and uses the new generation cursor",
    async (view) => {
      const scan = deferred<ProjectImportResponse>();
      const first = {
        ...page([item("original")]),
        has_more: true,
        next_cursor: "g1-next",
      };
      const next = {
        ...first,
        generation: "g2",
        next_cursor: "g2-next",
        scanned_at: "2026-09-08T12:00:00Z",
      };
      const read = vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(next)
        .mockResolvedValue(page([item("second-page")], "g2"));
      const readRuns = vi
        .fn()
        .mockResolvedValueOnce({
          ...first,
          items: [{ run: summary("original"), result_count: 2 }],
        })
        .mockResolvedValueOnce({
          ...next,
          items: [{ run: summary("original"), result_count: 2 }],
        })
        .mockResolvedValue({
          ...page([], "g2"),
          items: [{ run: summary("second-page"), result_count: 1 }],
        });
      const api = makeApi({
        browseProjectResults: read,
        browseProjectRuns: readRuns,
        reindexProject: vi.fn(() => scan.promise),
      });
      render(<ProjectBrowser {...props(api)} view={view} />);
      const article = await screen.findByRole("article");
      const thumbnail =
        view === "gallery" ? within(article).getByRole("img") : null;
      if (view === "gallery")
        fireEvent.click(screen.getByRole("button", { name: /^View original/ }));
      const viewerImage =
        view === "gallery"
          ? within(screen.getByRole("dialog")).getByRole("img")
          : null;
      await act(async () => scan.resolve(scanResponse()));
      await waitFor(() =>
        expect(
          screen.queryByText("Checking Project history..."),
        ).not.toBeInTheDocument(),
      );
      expect(
        screen.queryByText("History updated. Refresh when you are ready."),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("article")).toBe(article);
      if (view === "gallery") {
        expect(within(article).getByRole("img")).toBe(thumbnail);
        expect(within(screen.getByRole("dialog")).getByRole("img")).toBe(
          viewerImage,
        );
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
      }
      expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Next page" }));
      await screen.findByText("second-page");
      expect(view === "gallery" ? read : readRuns).toHaveBeenLastCalledWith(
        "project",
        { limit: view === "gallery" ? 48 : 25, cursor: "g2-next" },
        expect.any(AbortSignal),
      );
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("does not retry failed images when adopting generation-only metadata", async () => {
    const scan = deferred<ProjectImportResponse>();
    const api = makeApi({
      reindexProject: vi.fn(() => scan.promise),
      browseProjectResults: vi
        .fn()
        .mockResolvedValueOnce(page([item("original")]))
        .mockResolvedValue(page([item("original")], "g2")),
    });
    render(<ProjectBrowser {...props(api)} />);
    fireEvent.error(await screen.findByRole("img"));
    expect(screen.getByText("Image unavailable")).toBeInTheDocument();
    await act(async () => scan.resolve(scanResponse()));
    expect(screen.getByText("Image unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(
      screen.queryByText("History updated. Refresh when you are ready."),
    ).not.toBeInTheDocument();
  });

  it("does not adopt first-page generation metadata onto a later page even when items match", async () => {
    const scan = deferred<ProjectImportResponse>();
    const api = makeApi({
      reindexProject: vi.fn(() => scan.promise),
      browseProjectResults: vi
        .fn()
        .mockResolvedValueOnce({
          ...page([item("first")]),
          has_more: true,
          next_cursor: "g1-page2",
        })
        .mockResolvedValueOnce({
          ...page([item("second")]),
          has_more: true,
          next_cursor: "g1-page3",
        })
        .mockResolvedValue({
          ...page([item("second")], "g2"),
          has_more: true,
          next_cursor: "g2-page2",
        }),
    });
    render(<ProjectBrowser {...props(api)} />);
    await screen.findByText("first");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("second");
    await act(async () => scan.resolve(scanResponse()));
    await screen.findByText("History updated. Refresh when you are ready.");
    expect(screen.getByText("Page 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Previous page" }),
    ).toBeDisabled();
  });

  it("retains metadata but removes thumbnail and viewer URLs when reindex removes all Result rows", async () => {
    const scan = deferred<ProjectImportResponse>();
    const api = makeApi({
      reindexProject: vi.fn(() => scan.promise),
      browseProjectResults: vi
        .fn()
        .mockResolvedValueOnce(page([item("original")]))
        .mockResolvedValue(page([], "g2")),
    });
    render(<ProjectBrowser {...props(api)} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /^View original/ }),
    );
    await act(async () => scan.resolve(scanResponse()));
    expect(
      await screen.findByText("Awaiting history refresh", {
        selector: "strong",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("article")).toHaveTextContent("original");
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Awaiting history refresh",
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open original" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Execution unavailable")).not.toBeInTheDocument();
    expect(api.getResults).not.toHaveBeenCalled();
    expect(api.listProjectRuns).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("No Results to show yet.");
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });

  it.each([
    { integrity_status: "missing" },
    { integrity_status: "corrupt" },
    { download_url: null },
    { job_id: "different-job" },
    { sha256: "changed-content" },
    { download_url: "/different-original" },
  ])(
    "suspends unsafe retained Result downloads after reindex: %j",
    async (change) => {
      const api = makeApi({
        reindexProject: vi.fn(async () => scanResponse()),
        browseProjectResults: vi
          .fn()
          .mockResolvedValueOnce(page([item("original"), item("healthy")]))
          .mockResolvedValue(
            page([{ ...item("original"), ...change }, item("healthy")], "g2"),
          ),
      });
      render(<ProjectBrowser {...props(api)} />);
      await screen.findByText("Awaiting history refresh");
      const articles = screen.getAllByRole("article");
      expect(articles.map((node) => node.getAttribute("data-run-id"))).toEqual([
        "original",
        "healthy",
      ]);
      expect(within(articles[0]).queryByRole("img")).not.toBeInTheDocument();
      expect(within(articles[0]).queryByRole("link")).not.toBeInTheDocument();
      expect(within(articles[1]).getByRole("img")).toHaveAttribute(
        "src",
        "/results/healthy",
      );
      expect(
        screen.queryByText("Execution unavailable"),
      ).not.toBeInTheDocument();
      expect(api.getResults).not.toHaveBeenCalled();
    },
  );

  it("reports failed scans without asserting an uninitialized index is empty", async () => {
    const api = makeApi({
      browseProjectResults: vi.fn(async () => page([], null)),
      reindexProject: vi.fn(async () => {
        throw new Error("Storage offline");
      }),
    });
    render(<ProjectBrowser {...props(api)} view="gallery" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Storage offline",
    );
    expect(
      screen.queryByText("No Results to show yet."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Your first experiment starts in Batch."),
    ).not.toBeInTheDocument();
    expect(api.listProjectRuns).not.toHaveBeenCalled();
  });

  it("adopts the first confirmed scan from a null-generation empty index and reports diagnostics", async () => {
    const api = makeApi({
      browseProjectResults: vi
        .fn()
        .mockResolvedValueOnce(page([], null))
        .mockResolvedValue(page([item("found")])),
      reindexProject: vi.fn(async () => ({
        ...scanResponse(),
        diagnostic_count: 3,
      })),
    });
    render(<ProjectBrowser {...props(api)} />);
    expect(await screen.findByText("found")).toBeInTheDocument();
    expect(screen.getByText(/3 records need attention/)).toBeInTheDocument();
    expect(api.listProjectRuns).not.toHaveBeenCalled();
  });

  it("opens bounded diagnostics without scanning and closes on workspace navigation", async () => {
    const api = makeApi({ reindexProject: vi.fn(async () => scanResponse()) });
    const p = props(api);
    const ui = render(<ProjectBrowser {...p} />);
    await screen.findByText("original");
    await waitFor(() => expect(screen.getByRole("button", { name: "Reindex Project" })).toBeEnabled());
    const scans = vi.mocked(api.reindexProject).mock.calls.length;
    expect(api.browseProjectDiagnostics).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
    expect(await screen.findByRole("dialog", { name: "History diagnostics" })).toBeInTheDocument();
    await waitFor(() => expect(api.browseProjectDiagnostics).toHaveBeenCalledWith(
      p.projectId, { limit: 25, cursor: undefined }, expect.any(AbortSignal),
    ));
    expect(api.reindexProject).toHaveBeenCalledTimes(scans);
    ui.rerender(<ProjectBrowser {...p} active={false} />);
    expect(screen.queryByRole("dialog", { name: "History diagnostics" })).not.toBeInTheDocument();
    expect(vi.mocked(api.browseProjectDiagnostics).mock.calls[0][2]?.aborted).toBe(true);
  });

  it.each(["gallery", "runs"] as const)("shows discovered history in an already-indexed empty %s page without another Refresh", async (view) => {
    const api = makeApi({
      browseProjectResults: vi.fn().mockResolvedValueOnce(page([], "g1")).mockResolvedValue(page([item("imported")], "g2")),
      browseProjectRuns: vi.fn().mockResolvedValueOnce(page([], "g1")).mockResolvedValue({ ...page([], "g2"), items: [{ run: summary("imported"), result_count: 1 }] }),
      reindexProject: vi.fn(async () => scanResponse()),
    });
    render(<ProjectBrowser {...props(api)} view={view} />);
    expect(await screen.findByText("imported")).toBeInTheDocument();
    expect(screen.queryByText("History updated. Refresh when you are ready.")).not.toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });

  it.each(["gallery", "runs"] as const)("explicit Reindex adopts the refreshed %s page but later background scans preserve the collection", async (view) => {
    const api = makeApi({ reindexProject: vi.fn(async () => scanResponse()) });
    const p = { ...props(api), view };
    const ui = render(<ProjectBrowser {...p} />);
    await screen.findByText("original");
    await waitFor(() => expect(screen.getByRole("button", { name: "Reindex Project" })).toBeEnabled());
    vi.mocked(api.browseProjectResults).mockResolvedValue(page([item("imported")], "g2"));
    vi.mocked(api.browseProjectRuns).mockResolvedValue({ ...page([], "g2"), items: [{ run: summary("imported"), result_count: 1 }] });
    fireEvent.click(screen.getByRole("button", { name: "Reindex Project" }));
    expect(await screen.findByText("imported")).toBeInTheDocument();
    expect(screen.queryByText("original")).not.toBeInTheDocument();
    expect(screen.queryByText("History updated. Refresh when you are ready.")).not.toBeInTheDocument();
    vi.mocked(api.browseProjectResults).mockResolvedValue(page([item("later")], "g3"));
    vi.mocked(api.browseProjectRuns).mockResolvedValue({ ...page([], "g3"), items: [{ run: summary("later"), result_count: 1 }] });
    ui.rerender(<ProjectBrowser {...p} historyRevision={1} />);
    await screen.findByText("History updated. Refresh when you are ready.");
    expect(screen.getByText("imported")).toBeInTheDocument();
    expect(screen.queryByText("later")).not.toBeInTheDocument();
  });

  it("disables retained images when a scan reports unavailable execution", async () => {
    const unavailable = item("original");
    unavailable.run.execution_available = false;
    unavailable.download_url = null;
    const api = makeApi({
      browseProjectResults: vi
        .fn()
        .mockResolvedValueOnce(page([item("original")]))
        .mockResolvedValue(page([unavailable], "g2")),
      reindexProject: vi.fn(async () => scanResponse()),
    });
    render(<ProjectBrowser {...props(api)} />);
    expect(
      await screen.findByText("Execution unavailable"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("original")).toBeInTheDocument();
  });

  it("keeps exact cross-Run identity and loads only the selected Result's actual producer metadata", async () => {
    const api = makeApi({
      browseProjectResults: vi.fn(async () =>
        page([item("alpha"), item("beta")]),
      ),
      getRun: vi.fn(async (id) => frozenRun(id)),
      getResults: vi.fn(async (id) => ({
        run_id: id,
        results: [
          {
            job_ordinal: 1,
            artifact_ordinal: 1,
            producing_node_id: "actual-producer",
            output_name: "images",
            remote_filename: `${id}-full.png`,
            content_type: "image/png",
            byte_size: 12,
            sha256: id,
            integrity_status: "verified" as const,
            download_url: `/results/${id}`,
          },
        ],
      })),
    });
    render(<ProjectBrowser {...props(api)} />);
    const first = await screen.findByRole("button", { name: /^View alpha/ });
    fireEvent.click(first);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
    expect(within(screen.getByRole("dialog")).getByRole("img")).toHaveAttribute(
      "src",
      "/results/beta",
    );
    expect(api.getResults).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Image Details",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Job 001 · Artifact 1",
    });
    expect(dialog).toHaveTextContent("prompt for beta");
    fireEvent.click(within(dialog).getByText("Technical details"));
    expect(dialog).toHaveTextContent("actual-producer");
    expect(dialog).toHaveTextContent("beta-full.png");
    expect(api.getResults).toHaveBeenCalledExactlyOnceWith("beta");
    expect(api.getRun).toHaveBeenCalledExactlyOnceWith("beta");
    expect(screen.getAllByRole("article")[0]).not.toHaveAttribute(
      "data-result-identity",
      screen.getAllByRole("article")[1].getAttribute("data-result-identity"),
    );
  });

  it("rejects wrong owning Runs and removes pending inspections on inactivity", async () => {
    const pending = deferred<RunResponse>();
    const api = makeApi({ getRun: vi.fn(() => pending.promise) });
    const p = props(api);
    const ui = render(<ProjectBrowser {...p} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /^Details for/ }),
    );
    ui.rerender(<ProjectBrowser {...p} active={false} />);
    await act(async () =>
      pending.resolve({ ...frozenRun("original"), project_id: "wrong" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.getResults).not.toHaveBeenCalled();
    ui.rerender(<ProjectBrowser {...p} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /^Details for/ }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "did not match this Project and Run",
    );
  });

  it("shows named Runs, bounded counts, owning filters, and native unsaved-Batch confirmation", async () => {
    const api = makeApi({ getRun: vi.fn(async (id) => frozenRun(id)) });
    const p = props(api);
    render(<ProjectBrowser {...p} view="runs" hasUnsavedChanges />);
    const row = await screen.findByRole("article", { name: "original" });
    expect(api.browseProjectRuns).toHaveBeenCalledWith(
      "project",
      { limit: 25, cursor: null },
      expect.any(AbortSignal),
    );
    expect(row).toHaveTextContent("2 Results");
    fireEvent.click(within(row).getByRole("button", { name: "Experiment" }));
    expect(p.onQueryChange).toHaveBeenLastCalledWith({
      batch_id: "batch",
      cursor: null,
    });
    fireEvent.click(within(row).getByRole("button", { name: "Show Results" }));
    expect(p.onQueryChange).toHaveBeenCalledTimes(1);
    expect(p.onViewChange).toHaveBeenCalledExactlyOnceWith("gallery", {
      run_id: "original",
      cursor: null,
    });
    fireEvent.click(within(row).getByRole("button", { name: "View Run Plan" }));
    expect(
      await screen.findByRole("dialog", { name: "original Plan" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(
      within(row).getByRole("button", { name: "Load Run as Batch" }),
    );
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalled();
    expect(p.loadRunAsBatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(p.loadRunAsBatch).not.toHaveBeenCalled();
    fireEvent.click(
      within(row).getByRole("button", { name: "Load Run as Batch" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Replace Batch" }));
    await waitFor(() =>
      expect(p.loadRunAsBatch).toHaveBeenCalledExactlyOnceWith(
        "original",
        expect.any(AbortSignal),
      ),
    );
    expect(p.onOpenBatch).not.toHaveBeenCalled();
  });

  it("releases the Batch-loading guard after closing a pending frozen-Run lookup", async () => {
    const run = deferred<RunResponse>();
    const api = makeApi({ getRun: vi.fn(() => run.promise) });
    const p = props(api);
    render(<ProjectBrowser {...p} view="runs" />);
    const load = await screen.findByRole("button", {
      name: "Load Run as Batch",
    });
    fireEvent.click(load);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await act(async () => run.resolve(frozenRun("original")));
    expect(load).toBeEnabled();
    expect(p.loadRunAsBatch).not.toHaveBeenCalled();
    fireEvent.click(load);
    await waitFor(() =>
      expect(p.loadRunAsBatch).toHaveBeenCalledExactlyOnceWith(
        "original",
        expect.any(AbortSignal),
      ),
    );
  });

  it.each(["close", "inactive", "query", "unmount"] as const)(
    "aborts an in-flight reconstruction on %s before the callback applies it",
    async (action) => {
      const reconstruction = deferred<void>();
      const applied = vi.fn();
      const api = makeApi({ getRun: vi.fn(async (id) => frozenRun(id)) });
      const p = props(api);
      p.loadRunAsBatch = vi.fn(async (_id, signal) => {
        await reconstruction.promise;
        if (!signal.aborted) applied();
      });
      const ui = render(<ProjectBrowser {...p} view="runs" />);
      fireEvent.click(
        await screen.findByRole("button", { name: "Load Run as Batch" }),
      );
      await waitFor(() => expect(p.loadRunAsBatch).toHaveBeenCalledTimes(1));
      const signal = vi.mocked(p.loadRunAsBatch).mock.calls[0][1];
      expect(signal.aborted).toBe(false);
      if (action === "close") {
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(
          screen.getByRole("button", { name: "Load Run as Batch" }),
        ).toBeEnabled();
      } else if (action === "inactive")
        ui.rerender(<ProjectBrowser {...p} view="runs" active={false} />);
      else if (action === "query")
        ui.rerender(
          <ProjectBrowser {...p} view="runs" query={{ q: "changed" }} />,
        );
      else ui.unmount();
      expect(signal.aborted).toBe(true);
      await act(async () => reconstruction.resolve());
      expect(applied).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    },
  );

  it("ignores late aborted reconstruction completion while a newer restore is pending", async () => {
    const older = deferred<void>();
    const newer = deferred<void>();
    const api = makeApi({ getRun: vi.fn(async (id) => frozenRun(id)) });
    const p = props(api);
    p.loadRunAsBatch = vi
      .fn()
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    render(<ProjectBrowser {...p} view="runs" />);
    const button = await screen.findByRole("button", {
      name: "Load Run as Batch",
    });
    fireEvent.click(button);
    await waitFor(() => expect(p.loadRunAsBatch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(p.loadRunAsBatch).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(p.loadRunAsBatch).mock.calls;
    expect(calls[0][1].aborted).toBe(true);
    expect(calls[1][1].aborted).toBe(false);
    await act(async () => older.resolve());
    expect(button).toBeDisabled();
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Loading Run as Batch",
    );
    await act(async () => newer.resolve());
    expect(button).toBeEnabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("uses one compact viewer toolbar, bounds navigation, and links only available images", async () => {
    const api = makeApi({
      browseProjectResults: vi.fn(async () => page(Array.from({ length: 48 }, (_, i) => item(`image-${i}`)))),
    });
    render(<ProjectBrowser {...props(api)} />);
    fireEvent.click(await screen.findByRole("button", { name: /^View image-0,/ }));
    const viewer = screen.getByRole("dialog", { name: "Project Result image" });
    const controls = within(viewer);
    const toolbar = viewer.querySelector<HTMLElement>(".pb-modal-heading")!;
    expect(viewer.querySelectorAll(".pb-modal-heading")).toHaveLength(1);
    expect(controls.queryByRole("heading")).not.toBeInTheDocument();
    expect(controls.queryByText("Project Result image")).not.toBeInTheDocument();
    expect(within(toolbar).getAllByRole("button").map((button) => button.textContent))
      .toEqual(["Previous", "Next", "Image Details", "Close"]);
    expect(controls.getAllByRole("button")).toHaveLength(4);
    const previous = controls.getByRole("button", { name: "Previous" });
    const next = controls.getByRole("button", { name: "Next" });
    expect(previous).toBeDisabled();
    expect(next).toBeEnabled();
    expect(controls.getByText("1/48", { exact: true })).toBeInTheDocument();
    fireEvent.keyDown(viewer, { key: "ArrowLeft" });
    expect(controls.getByText("1/48", { exact: true })).toBeInTheDocument();
    const link = controls.getByRole("link", { name: "Open original image in a new tab" });
    expect(link).toHaveAttribute("href", "/results/image-0");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
    expect(within(link).getByRole("img")).toHaveAttribute("src", "/results/image-0");
    expect(controls.getAllByRole("link")).toHaveLength(1);
    for (let i = 1; i < 48; i++) fireEvent.click(next);
    expect(controls.getByText("48/48", { exact: true })).toBeInTheDocument();
    expect(next).toBeDisabled();
    expect(previous).toBeEnabled();
    fireEvent.keyDown(viewer, { key: "ArrowRight" });
    expect(controls.getByText("48/48", { exact: true })).toBeInTheDocument();
    fireEvent.click(previous);
    expect(controls.getByText("47/48", { exact: true })).toBeInTheDocument();
    expect(controls.getByRole("link")).toHaveAttribute("href", "/results/image-46");
    fireEvent.error(controls.getByRole("img"));
    expect(controls.queryByRole("link")).not.toBeInTheDocument();
    expect(controls.queryByRole("img")).not.toBeInTheDocument();
    expect(controls.getByRole("status")).toHaveTextContent("This image is no longer available");
  });

  it("keeps the selected image under loading and Details, restores focus, and closes only the topmost dialog", async () => {
    const details = deferred<ResultsResponse>();
    const api = makeApi({
      getRun: vi.fn(async (id) => frozenRun(id)),
      getResults: vi.fn(() => details.promise),
    });
    render(<ProjectBrowser {...props(api)} />);
    const opener = await screen.findByRole("button", {
      name: /^View original/,
    });
    fireEvent.click(opener);
    const viewer = screen.getByRole("dialog", { name: "Project Result image" });
    const image = within(viewer).getByRole("img");
    const detailsButton = within(viewer).getByRole("button", {
      name: "Image Details",
    });
    fireEvent.click(detailsButton);
    await waitFor(() => expect(api.getResults).toHaveBeenCalledTimes(1));
    expect(within(viewer).getByRole("img")).toBe(image);
    expect(
      screen.getByRole("dialog", { name: "History inspection" }),
    ).toHaveTextContent("Loading Result details");
    await act(async () => details.resolve(resultResponse("original")));
    const dialog = await screen.findByRole("dialog", {
      name: "Job 001 · Artifact 1",
    });
    expect(within(viewer).getByRole("img")).toBe(image);
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(viewer, { key: "Escape" });
    expect(dialog).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(dialog).not.toBeInTheDocument();
    expect(viewer).toBeInTheDocument();
    expect(within(viewer).getByRole("img")).toBe(image);
    expect(detailsButton).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(viewer, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(document.body.style.overflow).toBe("");
  });

  it("returns to the viewer after a failed Details lookup, but card Details returns to the grid", async () => {
    const api = makeApi({
      getRun: vi.fn(async (id) => frozenRun(id)),
      getResults: vi.fn(async () => {
        throw new Error("Metadata offline");
      }),
    });
    render(<ProjectBrowser {...props(api)} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /^View original/ }),
    );
    const viewer = screen.getByRole("dialog", { name: "Project Result image" });
    const button = within(viewer).getByRole("button", { name: "Image Details" });
    fireEvent.click(button);
    await screen.findByText("Metadata offline");
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "History inspection" }),
      ).getByRole("button", { name: "Close" }),
    );
    expect(button).toHaveFocus();
    expect(within(viewer).getByRole("img")).toBeInTheDocument();
    fireEvent.click(within(viewer).getByRole("button", { name: "Close" }));
    const cardDetails = screen.getByRole("button", { name: /^Details for/ });
    fireEvent.click(cardDetails);
    await screen.findByText("Metadata offline");
    expect(
      screen.queryByRole("dialog", { name: "Project Result image" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(cardDetails).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("retains known content on failed repair and retries scans only on explicit repair or revision", async () => {
    const api = makeApi({
      reindexProject: vi.fn(async () => {
        throw new Error("Storage offline");
      }),
    });
    const p = props(api);
    const ui = render(<ProjectBrowser {...p} />);
    await screen.findByRole("alert");
    expect(screen.getByText("original")).toBeInTheDocument();
    expect(screen.getByRole("img")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reindex Project" }));
    await waitFor(() => expect(api.reindexProject).toHaveBeenCalledTimes(2));
    ui.rerender(<ProjectBrowser {...p} historyRevision={1} />);
    await waitFor(() => expect(api.reindexProject).toHaveBeenCalledTimes(3));
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });

  it("does not let a late background check supersede an explicit Refresh", async () => {
    const check = deferred<HistoryResultPageResponse>();
    const api = makeApi({
      reindexProject: vi.fn(async () => scanResponse()),
      browseProjectResults: vi
        .fn()
        .mockResolvedValueOnce(page([item("original")]))
        .mockImplementationOnce(() => check.promise)
        .mockResolvedValue(page([item("current")], "g3")),
    });
    render(<ProjectBrowser {...props(api)} />);
    await waitFor(() =>
      expect(api.browseProjectResults).toHaveBeenCalledTimes(2),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("current");
    await act(async () => check.resolve(page([item("older")], "g2")));
    expect(screen.queryByText("older")).not.toBeInTheDocument();
    expect(
      screen.queryByText("History updated. Refresh when you are ready."),
    ).not.toBeInTheDocument();
  });

  it("bounds cursor history to twenty Previous bookmarks", async () => {
    const api = makeApi({
      browseProjectResults: vi.fn(async (_id, query) => {
        const number = Number(query?.cursor ?? 1);
        return {
          ...page([item(`page-${number}`)]),
          next_cursor: String(number + 1),
          has_more: true,
        };
      }),
    });
    render(<ProjectBrowser {...props(api)} />);
    await screen.findByText("page-1");
    for (let number = 2; number <= 23; number++) {
      fireEvent.click(screen.getByRole("button", { name: "Next page" }));
      await screen.findByText(`page-${number}`);
      expect(screen.getAllByRole("article")).toHaveLength(1);
    }
    for (let number = 22; number >= 3; number--) {
      fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
      await screen.findByText(`page-${number}`);
    }
    expect(
      screen.getByRole("button", { name: "Previous page" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "First page" }));
    await screen.findByText("page-1");
  });

  it("keeps non-image and unavailable artifacts visible without claiming verified thumbnails", async () => {
    const file = { ...item("file"), content_type: "application/json" };
    const missing = {
      ...item("missing"),
      download_url: null,
      integrity_status: "missing",
    };
    const api = makeApi({
      browseProjectResults: vi.fn(async () => page([file, missing])),
    });
    render(<ProjectBrowser {...props(api)} />);
    await screen.findByText("File Result");
    expect(screen.getByText("Artifact unavailable")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open original" })).toHaveAttribute(
      "href",
      "/results/file",
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByText(/verified/i)).not.toBeInTheDocument();
    expect(api.getResults).not.toHaveBeenCalled();
  });

  it("retains known content when continuation returns the backend stale-cursor error", async () => {
    const api = makeApi({
      browseProjectResults: vi.fn(async (_id, query) => {
        if (query?.cursor)
          throw new ApiError(
            "Refresh history",
            "history_generation_changed",
            409,
          );
        return {
          ...page([item("original")]),
          has_more: true,
          next_cursor: "next",
        };
      }),
    });
    render(<ProjectBrowser {...props(api)} />);
    await screen.findByText("original");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Refresh history",
    );
    expect(screen.getByText("original")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  });
});

function props(api: BatchcraftApi): ProjectBrowserProps {
  return {
    api,
    projectId: "project",
    projectName: "Studio",
    active: true,
    view: "gallery",
    query: {},
    onQueryChange: vi.fn(),
    onViewChange: vi.fn(),
    onOpenBatch: vi.fn(),
    historyRevision: 0,
    getCachedRun: () => null,
    loadRun: (id) => api.getRun(id),
    loadRunAsBatch: vi.fn(async () => {}),
    loadRunAsBatchDisabled: false,
    hasUnsavedChanges: false,
  };
}
function makeApi(overrides: Partial<BatchcraftApi> = {}): BatchcraftApi {
  return {
    getHistoryChoices: vi.fn(async (projectId: string) => ({ project_id: projectId, generation: null, items: [], has_more: false })),
    browseProjectDiagnostics: vi.fn(async (projectId: string) => ({ ...page([]), project_id: projectId })),
    browseProjectResults: vi.fn(async () => page([item("original")])),
    browseProjectRuns: vi.fn(async () => ({
      ...page([]),
      items: [{ run: summary("original"), result_count: 2 }],
    })),
    reindexProject: vi.fn(() => new Promise<ProjectImportResponse>(() => {})),
    listProjectRuns: vi.fn(),
    getRun: vi.fn(),
    getResults: vi.fn(),
    resultUrl: (url: string) => url,
    ...overrides,
  } as BatchcraftApi;
}
function page(
  items: HistoryResultItemResponse[],
  generation: string | null = "g1",
): HistoryResultPageResponse {
  return {
    project_id: "project",
    generation,
    scanned_at: generation ? "2026-09-07T12:00:00Z" : null,
    items,
    next_cursor: null,
    has_more: false,
  };
}
function summary(runId: string): HistoryRunSummaryResponse {
  return {
    run_id: runId,
    run_number: 1,
    run_name: runId,
    run_description_excerpt: "A study in light",
    display_truncated: false,
    batch_id: "batch",
    batch_name: "Experiment",
    created_at: "2026-09-07T12:00:00Z",
    job_count: 1,
    execution_status: "succeeded",
    execution_available: true,
    integrity_status: "verified",
    replayable: true,
  };
}
function item(runId: string): HistoryResultItemResponse {
  return {
    run: summary(runId),
    job_id: `${runId}-job`,
    job_ordinal: 1,
    artifact_ordinal: 1,
    filename_excerpt: "image.png",
    filename_truncated: false,
    content_type: "image/png",
    byte_size: 12,
    sha256: runId,
    integrity_status: "verified",
    download_url: `/results/${runId}`,
    download_unavailable_reason: null,
  };
}
function resultResponse(runId: string): ResultsResponse {
  return {
    run_id: runId,
    results: [
      {
        job_ordinal: 1,
        artifact_ordinal: 1,
        producing_node_id: "producer",
        output_name: "images",
        remote_filename: "image.png",
        content_type: "image/png",
        byte_size: 12,
        sha256: runId,
        integrity_status: "verified",
        download_url: `/results/${runId}`,
      },
    ],
  };
}
function scanResponse(): ProjectImportResponse {
  return {
    project_id: "project",
    filesystem_key: "project",
    name: "Studio",
    batch_count: 1,
    asset_count: 0,
    run_count: 2,
    diagnostic_count: 0,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function frozenRun(id: string): RunResponse {
  const project = { id: "project", name: "Studio", filesystem_key: "project" };
  const batch = {
    id: "batch",
    name: "Experiment",
    filesystem_key: "batch",
    description: null,
  };
  return {
    run_id: id,
    project_id: "project",
    project_name: "Studio",
    batch_id: "batch",
    batch_name: "Experiment",
    run_name: id,
    run_number: 1,
    run_description: null,
    filesystem_key: `001-${id}`,
    job_count: 1,
    durable_status: "created",
    created_at: "2026-09-07T12:00:00Z",
    prompt_versions: [],
    jobs: [{ ordinal: 1, prompt_version_id: "prompt" }],
    plan: {
      job_count: 1,
      warnings: [],
      jobs: [
        {
          ordinal: 1,
          prompt_version_id: "prompt",
          prompt_version_name: "Prompt",
          resolved_prompt: `prompt for ${id}`,
          resolved_variables: [],
          resolved_image_inputs: [],
          resolved_parameters: [],
          resolved_parameter_sets: [],
          seed: 4,
        },
      ],
    },
    batch_snapshot: {
      format: "batchcraft.batch-snapshot",
      format_version: 1,
      project,
      batch,
      source_saved_batch: null,
      prompt_versions: [],
      variable_bindings: [],
      image_bindings: [],
      parameter_bindings: [],
      linked_parameter_sets: [],
      seed_intent: { mode: "fixed", values: [4], random_seed_count: null },
      workflow_selection: {
        workflow_id: null,
        workflow_version_id: null,
        workflow_name: null,
        workflow_version_number: null,
        workflow_profile_id: null,
        workflow_profile_version_id: null,
        workflow_profile_name: null,
        workflow_profile_version_number: null,
        workflow: {},
        workflow_profile: {},
      },
    },
    execution: {
      run_id: id,
      status: "succeeded",
      execution_task_active: false,
      started_at: null,
      completed_at: null,
      current_job_ordinal: null,
      error: null,
      diagnostics: [],
      jobs: [],
    },
  };
}
