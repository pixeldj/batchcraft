import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, BatchcraftApiClient } from "./client";
import type { HistoryQuery, HistoryResultPageResponse, HistoryRunPageResponse, HistoryRunSummaryResponse } from "./types";

describe("BatchcraftApiClient", () => {
  it("requests bounded diagnostic pages with encoded Project and cursor and cancellation", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const controller = new AbortController();
    const api = new BatchcraftApiClient("");
    await api.browseProjectDiagnostics("project #1", { limit: 25, cursor: "a+/=" }, controller.signal);
    expect(fetcher).toHaveBeenCalledWith("/api/projects/project%20%231/history/diagnostics?limit=25&cursor=a%2B%2F%3D", expect.objectContaining({ signal: controller.signal }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("encodes historical choice searches literally and forwards cancellation", async () => {
    const response = { project_id: "p /?", generation: "g", items: [], has_more: false };
    const fetchMock = successfulFetch(response);
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    await expect(new BatchcraftApiClient().getHistoryChoices("p /?", "parameter", "a &%_+?", controller.signal)).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/p%20%2F%3F/history/choices?kind=parameter&q=a+%26%25_%2B%3F&limit=30", { signal: controller.signal });
  });

  it("rejects oversized choice searches without fetching", async () => {
    const fetchMock = successfulFetch({});
    vi.stubGlobal("fetch", fetchMock);
    await expect(new BatchcraftApiClient().getHistoryChoices("p", "asset", "x".repeat(201))).rejects.toMatchObject({ code: "invalid_history_search" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves AbortError for historical choices", async () => {
    const error = new DOMException("Aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
    await expect(new BatchcraftApiClient().getHistoryChoices("p", "prompt")).rejects.toBe(error);
  });

  it("explains an older backend's missing choices route", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 })));
    await expect(new BatchcraftApiClient().getHistoryChoices("p", "asset")).rejects.toMatchObject({ status: 404, message: expect.stringContaining("Restart the backend") });
  });

  it("distinguishes a missing diagnostics route from a missing Project", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "project_not_found", message: "Project was not found" } }), { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new BatchcraftApiClient();
    await expect(client.browseProjectDiagnostics("p")).rejects.toMatchObject({
      code: "history_browser_unavailable", message: expect.stringContaining("Restart the backend"),
    });
    await expect(client.browseProjectDiagnostics("missing")).rejects.toMatchObject({
      code: "project_not_found", message: "Project was not found",
    });
  });

  it.each(["runs", "results"] as const)("serializes advanced %s filters as typed JSON without mutating the query", async (kind) => {
    const fetchMock = successfulFetch({ items: [] });
    vi.stubGlobal("fetch", fetchMock);
    const query: HistoryQuery = {
      q: "a & b", run_id: "r", execution_available: false, limit: 25,
      filters: { seed: 0, prompt_id: "prompt/?", parameters: [
        { key: "text", value_type: "string", mode: "equals", value: "" },
        { key: "flag", value_type: "boolean", mode: "equals", value: false },
        { key: "count", value_type: "integer", mode: "equals", value: 0 },
        { key: "scale", value_type: "float", mode: "equals", value: 1.5 },
        { key: "base", value_type: "string", mode: "base" },
      ], image_inputs: [{ slot_key: "ref", mode: "base" }] },
    };
    const before = structuredClone(query);
    const client = new BatchcraftApiClient();
    await (kind === "runs" ? client.browseProjectRuns("p", query) : client.browseProjectResults("p", query));
    const params = new URL(String(fetchMock.mock.calls[0][0]), "http://test").searchParams;
    expect(JSON.parse(params.get("filters")!)).toEqual(query.filters);
    expect(params.get("execution_available")).toBe("false");
    expect(params.get("q")).toBe("a & b");
    expect(query).toEqual(before);
  });

  it.each(["runs", "results"] as const)("explains a missing %s browsing route on an older backend", async (kind) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 })));
    const client = new BatchcraftApiClient();
    const pending = kind === "runs" ? client.browseProjectRuns("project") : client.browseProjectResults("project");
    await expect(pending).rejects.toMatchObject({
      status: 404,
      code: "history_browser_unavailable",
      message: expect.stringContaining("Restart the backend"),
    });
  });

  it("does not confuse a missing Project with a missing browsing route", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "project_not_found", message: "Project was not found" } }), { status: 404 })));
    await expect(new BatchcraftApiClient().browseProjectRuns("missing")).rejects.toMatchObject({
      code: "project_not_found", message: "Project was not found", status: 404,
    });
  });

  it.each([
    [undefined, 1000], ["garbage", 1000], ["-1", 1000], ["0", 1000],
    ["2", 2000], ["999999999999", 5000],
    ["Sat, 05 Sep 2026 12:00:03 GMT", 3000],
  ])("retries capacity GETs using bounded Retry-After %s", async (retryAfter, delay) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => capacityResponse(retryAfter))
      .mockResolvedValue(new Response(JSON.stringify({ run_id: "run-1", results: [] })));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const pending = new BatchcraftApiClient().getResults("run-1", controller.signal);
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(pending).resolves.toEqual({ run_id: "run-1", results: [] });
    expect(fetchMock.mock.calls).toEqual(Array.from({ length: 2 }, () => [
      "/api/runs/run-1/results", { signal: controller.signal },
    ]));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops after three capacity failures and preserves the final error", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => capacityResponse());
    vi.stubGlobal("fetch", fetchMock);
    const assertion = expect(new BatchcraftApiClient().getRun("run-1")).rejects.toMatchObject({
      code: "read_capacity_exceeded", status: 503, message: "Read capacity is busy; retry later",
    });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts during the retry delay without another request", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => capacityResponse());
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const assertion = expect(new BatchcraftApiClient().getRun("run-1", controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["execute", "create", "reindex", "patch"])("never retries capacity failures for %s", async (operation) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => capacityResponse());
    vi.stubGlobal("fetch", fetchMock);
    const client = new BatchcraftApiClient();
    const pending = operation === "execute" ? client.startRun("run-1")
      : operation === "create" ? client.createRun({ ...batchRequest(), run_name: null, run_description: null })
      : operation === "reindex" ? client.reindexProject("project-1")
      : client.updateProject("project-1", { name: "Renamed", description: null });
    await expect(pending).rejects.toMatchObject({ code: "read_capacity_exceeded" });
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [503, { error: { code: "unavailable", message: "Busy" } }],
    [503, { error: { code: "read_capacity_exceeded" } }],
    [503, "not JSON"],
    [404, { error: { code: "not_found", message: "Missing" } }],
    [422, { error: { code: "corrupt_run", message: "Corrupt" } }],
    [429, { error: { code: "read_capacity_exceeded", message: "Busy" } }],
  ])("does not retry other errors: %s %j", async (status, body) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => new Response(
      typeof body === "string" ? body : JSON.stringify(body), { status },
    ));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new BatchcraftApiClient().getRun("run-1")).rejects.toMatchObject({ status });
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "", "/"])("uses same-origin API and images with API override %s", async (baseUrl) => {
    vi.stubEnv("VITE_BATCHCRAFT_API_URL", baseUrl);
    const fetchMock = successfulFetch({ projects: [] });
    vi.stubGlobal("fetch", fetchMock);
    const client = new BatchcraftApiClient();

    await client.listProjects();

    expect(fetchMock).toHaveBeenCalledWith("/api/projects", { signal: undefined });
    expect(client.assetUrl("/api/projects/p/assets/a/content")).toBe("/api/projects/p/assets/a/content");
    expect(client.resultUrl("api/runs/r/results/image")).toBe("/api/runs/r/results/image");
  });

  it("keeps an explicit development API origin for requests and images", async () => {
    vi.stubEnv("VITE_BATCHCRAFT_API_URL", "http://127.0.0.1:8001/");
    const fetchMock = successfulFetch({ projects: [] });
    vi.stubGlobal("fetch", fetchMock);
    const client = new BatchcraftApiClient();

    await client.listProjects();

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8001/api/projects", { signal: undefined });
    expect(client.assetUrl("/api/assets/a")).toBe("http://127.0.0.1:8001/api/assets/a");
    expect(client.resultUrl("/api/results/r")).toBe("http://127.0.0.1:8001/api/results/r");
  });

  it("parses a successful API response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ reachable: true, version: "0.31.0", devices: ["GPU"], diagnostic: null }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new BatchcraftApiClient("http://api.test/");
    const status = await client.getComfyUIStatus();

    expect(status).toEqual({
      reachable: true,
      version: "0.31.0",
      devices: ["GPU"],
      diagnostic: null,
    });
    expect(fetchMock).toHaveBeenCalledWith("http://api.test/api/comfyui/status", {
      signal: undefined,
    });
  });

  it("preserves the API error envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: "invalid_batch", message: "Binding is invalid" } }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const client = new BatchcraftApiClient("http://api.test");

    await expect(client.previewBatch(batchRequest())).rejects.toMatchObject({
      name: "ApiError",
      code: "invalid_batch",
      message: "Binding is invalid",
      status: 422,
    } satisfies Partial<ApiError>);
  });

  it("normalizes network failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const client = new BatchcraftApiClient("http://api.test");

    await expect(client.getComfyUIStatus()).rejects.toMatchObject({
      name: "ApiError",
      code: "network_error",
      message: "Cannot reach the batchcraft API",
      status: null,
    } satisfies Partial<ApiError>);
  });

  it("uploads Project images as multipart without setting a JSON content type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ assets: [] }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new BatchcraftApiClient("http://api.test");
    const file = new File(["image"], "portrait.png", { type: "image/png" });

    await client.uploadProjectAssets("project key", [file]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/api/projects/project%20key/assets");
    expect(init.method).toBe("POST");
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).getAll("files")).toEqual([file]);
  });

  it("looks up a durable Run by encoded ID", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ run_id: "run 1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await new BatchcraftApiClient("http://api.test").getRun("run 1");

    expect(fetchMock).toHaveBeenCalledWith("http://api.test/api/runs/run%201", {
      signal: undefined,
    });
  });

  it("discovers the active execution", async () => {
    const fetchMock = successfulFetch({ run_id: "run-live" });
    vi.stubGlobal("fetch", fetchMock);

    await new BatchcraftApiClient("http://api.test").getActiveExecution();

    expect(fetchMock).toHaveBeenCalledWith("http://api.test/api/executions/active", {
      signal: undefined,
    });
  });

  it("loads Batch reconstruction for an encoded Run ID", async () => {
    const fetchMock = successfulFetch({ run_id: "run/one" });
    vi.stubGlobal("fetch", fetchMock);

    await new BatchcraftApiClient("http://api.test").getBatchReconstruction("run/one");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/api/runs/run%2Fone/batch-reconstruction",
      { signal: undefined },
    );
  });

  it("imports Run-scoped Prompt, Workflow, and Profile snapshots as copies", async () => {
    const fetchMock = repeatedSuccessfulFetch({});
    vi.stubGlobal("fetch", fetchMock);
    const client = new BatchcraftApiClient("http://api.test");
    const metadata = {
      import_request_id: "historical-copy-request",
      name: "Historical copy",
      description: null,
      note: "Recovered",
    };

    await client.importRunPromptVersion("run/one", 3, metadata);
    await client.importRunWorkflowVersion("run/one", metadata);
    await client.importRunWorkflowProfileVersion("run/one", {
      ...metadata,
      workflow_version_id: "workflow version",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1,
      "http://api.test/api/runs/run%2Fone/batch-reconstruction/prompt-versions/3/import-copy",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(metadata) },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2,
      "http://api.test/api/runs/run%2Fone/batch-reconstruction/workflow-version/import-copy",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(metadata) },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(3,
      "http://api.test/api/runs/run%2Fone/batch-reconstruction/workflow-profile-version/import-copy",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...metadata, workflow_version_id: "workflow version" }),
      },
    );
  });

  it("creates a Run with metadata separate from the Preview Batch request", async () => {
    const fetchMock = successfulFetch({ run_id: "run-1" });
    vi.stubGlobal("fetch", fetchMock);
    const request = {
      ...batchRequest(),
      run_name: "Baseline",
      run_description: "First stable settings.",
    };

    await new BatchcraftApiClient("http://api.test").createRun(request);

    expect(fetchMock).toHaveBeenCalledWith("http://api.test/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  });

  it("discards a Run with POST and an encoded ID", async () => {
    const fetchMock = successfulFetch({ run_id: "run/one", status: "cancelled" });
    vi.stubGlobal("fetch", fetchMock);

    await new BatchcraftApiClient("http://api.test").discardRun("run/one");

    expect(fetchMock).toHaveBeenCalledWith("http://api.test/api/runs/run%2Fone/discard", {
      method: "POST",
    });
  });

  it("requests stop after the current Job with the typed cancellation body", async () => {
    const response = {
      run_id: "run/one",
      mode: "after_current_job",
      requested_at: "2026-09-01T12:00:00Z",
      created: true,
      state: "stopping_after_current_job",
    };
    const fetchMock = successfulFetch(response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await new BatchcraftApiClient("http://api.test").cancelRun("run/one");

    expect(result).toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith("http://api.test/api/runs/run%2Fone/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "after_current_job" }),
    });
  });

  it("requests local detach without implying remote cancellation", async () => {
    const response = {
      run_id: "run/one",
      mode: "detach",
      requested_at: "2026-09-01T12:00:00Z",
      created: true,
      state: "detach_requested",
    };
    const fetchMock = successfulFetch(response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await new BatchcraftApiClient("http://api.test").detachRun("run/one");

    expect(result).toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith("http://api.test/api/runs/run%2Fone/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "detach" }),
    });
  });

  it("lists active Projects without an archived query by default", async () => {
    const fetchMock = successfulFetch({ projects: [] });
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    await new BatchcraftApiClient("http://api.test").listProjects(false, signal);

    expect(fetchMock).toHaveBeenCalledWith("http://api.test/api/projects", { signal });
  });

  it("lists archived Projects only when requested", async () => {
    const fetchMock = successfulFetch({ projects: [] });
    vi.stubGlobal("fetch", fetchMock);

    await new BatchcraftApiClient("http://api.test").listProjects(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/api/projects?include_archived=true",
      { signal: undefined },
    );
  });

  it("creates a Project with a JSON body", async () => {
    const fetchMock = successfulFetch({});
    vi.stubGlobal("fetch", fetchMock);
    const body = {
      name: "Portrait studies",
      filesystem_key: "portrait-studies",
      description: null,
    };

    await new BatchcraftApiClient("http://api.test").createProject(body);

    expect(fetchMock).toHaveBeenCalledWith("http://api.test/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  });

  it("gets a Project with an encoded ID and AbortSignal", async () => {
    const fetchMock = successfulFetch({});
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    await new BatchcraftApiClient("http://api.test").getProject("project/one", signal);

    expect(fetchMock).toHaveBeenCalledWith("http://api.test/api/projects/project%2Fone", { signal });
  });

  it("updates a Project with PATCH and a JSON body", async () => {
    const fetchMock = successfulFetch({});
    vi.stubGlobal("fetch", fetchMock);
    const body = { name: "Updated Project", description: "Revised" };

    await new BatchcraftApiClient("http://api.test").updateProject("project one", body);

    expect(fetchMock).toHaveBeenCalledWith("http://api.test/api/projects/project%20one", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  });

  it("adopts a Project with a JSON body", async () => {
    const fetchMock = successfulFetch({});
    vi.stubGlobal("fetch", fetchMock);
    const body = {
      filesystem_key: "existing-project",
      project_id: "project-id",
      name: "Existing Project",
    };

    await new BatchcraftApiClient("http://api.test").adoptProject(body);

    expect(fetchMock).toHaveBeenCalledWith("http://api.test/api/projects/adopt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  });

  it("imports, reindexes, and lists Project history with exact routes", async () => {
    const fetchMock = repeatedSuccessfulFetch({});
    vi.stubGlobal("fetch", fetchMock);
    const client = new BatchcraftApiClient("http://api.test");
    const signal = new AbortController().signal;

    await client.importProject({ filesystem_key: "project folder" });
    await client.reindexProject("project/one", signal);
    await client.listProjectRuns("project/one", signal);

    expect(fetchMock.mock.calls).toEqual([
      ["http://api.test/api/projects/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filesystem_key: "project folder" }),
      }],
      ["http://api.test/api/projects/project%2Fone/reindex", { method: "POST", signal }],
      ["http://api.test/api/projects/project%2Fone/runs", { signal }],
    ]);
  });

  it("lists adoptable Projects with an AbortSignal", async () => {
    const fetchMock = successfulFetch({ projects: [] });
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    await new BatchcraftApiClient("http://api.test").listAdoptableProjects(signal);

    expect(fetchMock).toHaveBeenCalledWith("http://api.test/api/projects/adoptable", { signal });
  });

  describe.each([
    ["browseProjectRuns", "runs"],
    ["browseProjectResults", "results"],
  ] as const)("%s", (method, endpoint) => {
    it("encodes literal filters and opaque cursors without fetching Run details or original Results", async () => {
      const run: HistoryRunSummaryResponse = {
        run_id: "run-1", batch_id: "batch-1", batch_name: "Batch", run_number: 1,
        run_name: null, run_description_excerpt: "Clipped", display_truncated: true,
        created_at: "2026-09-07T12:00:00Z", job_count: 1, execution_available: false,
        execution_status: null, integrity_status: "degraded", replayable: true,
      };
      const metadata = {
        project_id: "project/one", generation: "generation-1", scanned_at: null,
        next_cursor: "next+/=", has_more: true,
      };
      const page: HistoryRunPageResponse | HistoryResultPageResponse = endpoint === "runs"
        ? { ...metadata, items: [{ run, result_count: 0 }] }
        : { ...metadata, items: [{
          run, job_id: "job-1", job_ordinal: 1, artifact_ordinal: 1,
          filename_excerpt: "image.png", filename_truncated: false, content_type: null,
          byte_size: 0, sha256: "abc", integrity_status: "missing", download_url: null,
          download_unavailable_reason: "execution_unavailable",
        }] };
      const fetchMock = successfulFetch(page);
      vi.stubGlobal("fetch", fetchMock);
      const client = new BatchcraftApiClient("http://api.test/");
      const getResults = vi.spyOn(client, "getResults");
      const getRun = vi.spyOn(client, "getRun");
      const signal = new AbortController().signal;
      const query: HistoryQuery = {
        limit: 25, cursor: "opaque+/=?&%", sort: "oldest", q: "  100%_ 'a' &+/#?  ",
        run_id: "run/one?&", batch_id: "batch +%", execution_status: "failed",
        execution_available: false,
      };

      await expect(client[method]("project/one", query, signal)).resolves.toEqual(page);

      expect(fetchMock.mock.calls).toEqual([[
        `http://api.test/api/projects/project%2Fone/history/${endpoint}`
          + "?limit=25&cursor=opaque%2B%2F%3D%3F%26%25&sort=oldest"
          + "&q=++100%25_+%27a%27+%26%2B%2F%23%3F++&run_id=run%2Fone%3F%26"
          + "&batch_id=batch+%2B%25&execution_status=failed&execution_available=false",
        { signal },
      ]]);
      expect(getResults).not.toHaveBeenCalled();
      expect(getRun).not.toHaveBeenCalled();
    });

    it.each([
      undefined,
      {},
      { limit: undefined, cursor: null, run_id: null, batch_id: null, execution_status: null, execution_available: null },
    ])("omits absent query values without a trailing question mark: %j", async (query) => {
      const page = { project_id: "p", generation: null, scanned_at: null, items: [], next_cursor: null, has_more: false };
      const fetchMock = successfulFetch(page);
      vi.stubGlobal("fetch", fetchMock);

      await expect(new BatchcraftApiClient("http://api.test")[method]("p", query)).resolves.toEqual(page);

      expect(fetchMock.mock.calls).toEqual([[
        `http://api.test/api/projects/p/history/${endpoint}`, { signal: undefined },
      ]]);
    });

    it("preserves zero, empty text, and false for backend validation", async () => {
      const fetchMock = successfulFetch({});
      vi.stubGlobal("fetch", fetchMock);

      await new BatchcraftApiClient("http://api.test")[method]("p", { limit: 0, q: "", execution_available: false });

      expect(fetchMock).toHaveBeenCalledWith(
        `http://api.test/api/projects/p/history/${endpoint}?limit=0&q=&execution_available=false`,
        { signal: undefined },
      );
    });

    it.each([
      [409, "history_generation_changed"],
      [422, "invalid_history_query"],
      [404, "project_not_found"],
    ])("preserves HTTP %s errors without retrying or resetting the cursor", async (status, code) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        error: { code, message: "History request rejected" },
      }), { status }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(new BatchcraftApiClient()[method]("p", { cursor: "stale" })).rejects.toMatchObject({
        name: "ApiError", status, code, message: "History request rejected",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not fetch with an already aborted signal", async () => {
      const fetchMock = successfulFetch({});
      vi.stubGlobal("fetch", fetchMock);
      const controller = new AbortController();
      controller.abort();

      await expect(new BatchcraftApiClient()[method]("p", undefined, controller.signal))
        .rejects.toBe(controller.signal.reason);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("preserves an in-flight fetch abort", async () => {
      const controller = new AbortController();
      const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }));
      vi.stubGlobal("fetch", fetchMock);
      const pending = new BatchcraftApiClient()[method]("p", undefined, controller.signal);
      controller.abort(new DOMException("Browse aborted", "AbortError"));

      await expect(pending).rejects.toBe(controller.signal.reason);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it("lists Project Prompts with an encoded ID and AbortSignal", async () => {
    const fetchMock = successfulFetch({ prompts: [] });
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    await new BatchcraftApiClient("http://api.test").listPrompts("project/one", signal);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/api/projects/project%2Fone/prompts",
      { signal },
    );
  });

  it("creates a Prompt with a JSON body", async () => {
    const fetchMock = successfulFetch({});
    vi.stubGlobal("fetch", fetchMock);
    const body = {
      name: "Portrait",
      description: "Studio portraits",
      text: "A portrait of {{subject}}",
      note: "Initial version",
    };

    await new BatchcraftApiClient("http://api.test").createPrompt("project one", body);

    expect(fetchMock).toHaveBeenCalledWith("http://api.test/api/projects/project%20one/prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  });

  it("gets a logical Prompt with an encoded ID and AbortSignal", async () => {
    const fetchMock = successfulFetch({});
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    await new BatchcraftApiClient("http://api.test").getPrompt("prompt/one", signal);

    expect(fetchMock).toHaveBeenCalledWith("http://api.test/api/prompts/prompt%2Fone", { signal });
  });

  it("updates a Prompt with PATCH and a JSON body", async () => {
    const fetchMock = successfulFetch({});
    vi.stubGlobal("fetch", fetchMock);
    const body = { name: "Updated portrait", description: null };

    await new BatchcraftApiClient("http://api.test").updatePrompt("prompt one", body);

    expect(fetchMock).toHaveBeenCalledWith("http://api.test/api/prompts/prompt%20one", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  });

  it("lists archived PromptVersion history with the query and AbortSignal", async () => {
    const fetchMock = successfulFetch({ prompt_versions: [] });
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    await new BatchcraftApiClient("http://api.test").listPromptVersions(
      "prompt/one",
      true,
      signal,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/api/prompts/prompt%2Fone/versions?include_archived=true",
      { signal },
    );
  });

  it("creates a PromptVersion with a JSON body", async () => {
    const fetchMock = successfulFetch({});
    vi.stubGlobal("fetch", fetchMock);
    const body = { text: "A revised portrait", note: null };

    await new BatchcraftApiClient("http://api.test").createPromptVersion("prompt one", body);

    expect(fetchMock).toHaveBeenCalledWith("http://api.test/api/prompts/prompt%20one/versions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  });

  it("gets a PromptVersion with an encoded ID and AbortSignal", async () => {
    const fetchMock = successfulFetch({});
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    await new BatchcraftApiClient("http://api.test").getPromptVersion("version/one", signal);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/api/prompt-versions/version%2Fone",
      { signal },
    );
  });

  it("uses the Project-scoped Workflow and Workflow Profile routes", async () => {
    const fetchMock = repeatedSuccessfulFetch({ workflows: [] });
    vi.stubGlobal("fetch", fetchMock);
    const client = new BatchcraftApiClient("http://api.test");
    const signal = new AbortController().signal;

    await client.listWorkflows("project/one", signal);
    await client.createWorkflow("project one", { name: "Portrait", workflow: { node: 1 } });
    await client.createWorkflowVersion("workflow one", { workflow: { node: 2 }, note: null });
    await client.listWorkflowProfiles("workflow/one", undefined, signal);
    await client.createWorkflowProfile("workflow one", { name: "Default", workflow_version_id: "version-1", mappings: { prompt: {} }, image_inputs: [], parameters: [] });
    await client.createWorkflowProfileVersion("profile one", { workflow_version_id: "version-2", mappings: { prompt: {} }, image_inputs: [], parameters: [] });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://api.test/api/projects/project%2Fone/workflows",
      "http://api.test/api/projects/project%20one/workflows",
      "http://api.test/api/workflows/workflow%20one/versions",
      "http://api.test/api/workflows/workflow%2Fone/profiles",
      "http://api.test/api/workflows/workflow%20one/profiles",
      "http://api.test/api/workflow-profiles/profile%20one/versions",
    ]);
    expect(fetchMock.mock.calls[4][1]).toMatchObject({ method: "POST" });
  });

  it("archives logical and immutable Workflow records with POST subresources", async () => {
    const fetchMock = repeatedSuccessfulFetch({});
    vi.stubGlobal("fetch", fetchMock);
    const client = new BatchcraftApiClient("http://api.test");

    await client.archiveWorkflow("workflow/one");
    await client.archiveWorkflowVersion("workflow-version/one");
    await client.archiveWorkflowProfile("profile/one");
    await client.archiveWorkflowProfileVersion("profile-version/one");

    expect(fetchMock.mock.calls).toEqual([
      ["http://api.test/api/workflows/workflow%2Fone/archive", { method: "POST" }],
      ["http://api.test/api/workflow-versions/workflow-version%2Fone/archive", { method: "POST" }],
      ["http://api.test/api/workflow-profiles/profile%2Fone/archive", { method: "POST" }],
      ["http://api.test/api/workflow-profile-versions/profile-version%2Fone/archive", { method: "POST" }],
    ]);
  });
});

function successfulFetch(body: unknown) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function capacityResponse(retryAfter?: string) {
  return new Response(JSON.stringify({
    error: { code: "read_capacity_exceeded", message: "Read capacity is busy; retry later" },
  }), { status: 503, headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter } });
}

function repeatedSuccessfulFetch(body: unknown) {
  return vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
}

function batchRequest() {
  const project = { id: "project", filesystem_key: "project", name: "Project" };
  const batch = { id: "batch", filesystem_key: "batch", name: "Batch" };
  const promptVersions = [{ id: "prompt", name: "Portrait", text: "Portrait" }];
  const imageBindings = [{ slot_key: "source", values: ["asset"] as [string] }];
  const parameterBindings: [] = [];
  const linkedParameterSets: [] = [];
  const seeds = { mode: "fixed" as const, values: [1] };
  const workflow = {};
  const workflowProfile = {};
  return {
    project,
    batch,
    prompt_versions: promptVersions,
    variable_bindings: [],
    image_bindings: imageBindings,
    parameter_bindings: parameterBindings,
    linked_parameter_sets: linkedParameterSets,
    seeds,
    workflow,
    workflow_profile: workflowProfile,
    batch_snapshot: {
      format: "batchcraft.batch-snapshot" as const,
      format_version: 1 as const,
      project,
      source_saved_batch: null,
      batch: { ...batch, description: null },
      prompt_versions: promptVersions.map((prompt) => ({
        ...prompt,
        prompt_id: null,
        version_number: null,
      })),
      variable_bindings: [],
      image_bindings: imageBindings,
      parameter_bindings: parameterBindings,
      linked_parameter_sets: linkedParameterSets,
      seed_intent: { mode: "fixed" as const, values: [1], random_seed_count: null },
      workflow_selection: {
        workflow_id: null,
        workflow_version_id: null,
        workflow_name: null,
        workflow_version_number: null,
        workflow_profile_id: null,
        workflow_profile_version_id: null,
        workflow_profile_name: null,
        workflow_profile_version_number: null,
        workflow,
        workflow_profile: workflowProfile,
      },
    },
  };
}
