import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, BatchcraftApiClient } from "./client";

describe("BatchcraftApiClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
});

function batchRequest() {
  return {
    project: { id: "project", filesystem_key: "project", name: "Project" },
    batch: { id: "batch", filesystem_key: "batch", name: "Batch" },
    prompt_version: { id: "prompt", text: "Portrait" },
    variable_bindings: [],
    references: [{ asset_id: "asset" }],
    seeds: { mode: "fixed" as const, values: [1] },
    workflow: {},
    workflow_profile: {},
  };
}
