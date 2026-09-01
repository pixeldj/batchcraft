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

  it("discards a Run with POST and an encoded ID", async () => {
    const fetchMock = successfulFetch({ run_id: "run/one", status: "cancelled" });
    vi.stubGlobal("fetch", fetchMock);

    await new BatchcraftApiClient("http://api.test").discardRun("run/one");

    expect(fetchMock).toHaveBeenCalledWith("http://api.test/api/runs/run%2Fone/discard", {
      method: "POST",
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

  it("lists adoptable Projects with an AbortSignal", async () => {
    const fetchMock = successfulFetch({ projects: [] });
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    await new BatchcraftApiClient("http://api.test").listAdoptableProjects(signal);

    expect(fetchMock).toHaveBeenCalledWith("http://api.test/api/projects/adoptable", { signal });
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
    await client.createWorkflowProfile("workflow one", { name: "Default", workflow_version_id: "version-1", mappings: { prompt: {} } });
    await client.createWorkflowProfileVersion("profile one", { workflow_version_id: "version-2", mappings: { prompt: {} } });

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
  const references = [{ asset_id: "asset" }];
  const seeds = { mode: "fixed" as const, values: [1] };
  const workflow = {};
  const workflowProfile = {};
  return {
    project,
    batch,
    prompt_versions: promptVersions,
    variable_bindings: [],
    references,
    seeds,
    workflow,
    workflow_profile: workflowProfile,
    batch_snapshot: {
      snapshot_version: 2 as const,
      project,
      source_saved_batch: null,
      batch: { ...batch, description: null },
      prompt_versions: promptVersions.map((prompt) => ({
        ...prompt,
        prompt_id: null,
        version_number: null,
      })),
      variable_bindings: [],
      references,
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
