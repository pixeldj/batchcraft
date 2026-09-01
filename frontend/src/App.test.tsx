import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import { ApiError, type BatchcraftApi, type RunDiscardApi } from "./api/client";
import type {
  AssetResponse,
  ExecutionResponse,
  LibraryPromptVersion,
  PreviewResponse,
  ProjectResponse,
  ProjectPrompt,
  ResultResponse,
  RunCreatedResponse,
  RunResponse,
} from "./api/types";
import { initialBatchForm, newPrompt } from "./features/batch/form";
import { loadWorkingSession, saveWorkingSession } from "./features/session/workingSession";

beforeEach(() => {
  sessionStorage.clear();
  saveWorkingSession(populatedBatchForm(), null, [], "project-1");
});

describe("ComfyUI status", () => {
  it("shows a reachable server and device", async () => {
    const api = makeApi();
    render(<App api={api} />);

    expect(await screen.findByText("ComfyUI Online")).toBeInTheDocument();
    expect(screen.getByText("0.31.0")).toBeInTheDocument();
    expect(screen.getByText("Test GPU")).toBeInTheDocument();
  });

  it("shows an unavailable server without disabling Batch editing", async () => {
    const api = makeApi({
      getComfyUIStatus: vi.fn(async () => ({
        reachable: false,
        version: null,
        devices: [],
        diagnostic: "cannot connect to ComfyUI",
      })),
    });
    render(<App api={api} />);

    expect(await screen.findByText("ComfyUI Offline")).toBeInTheDocument();
    expect(screen.getByText("cannot connect to ComfyUI")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview Batch" })).toBeEnabled();
  });
});

describe("Project selection", () => {
  it("starts unscoped and does not load Prompt or Asset libraries before selection", async () => {
    sessionStorage.clear();
    const api = makeApi({ listProjects: vi.fn(async () => ({ projects: [] })) });
    render(<App api={api} />);

    expect(await screen.findByRole("combobox", { name: "Active Project" })).toHaveValue("");
    expect(screen.getByText("Select a Project to load its Prompt library.")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Image Inputs" })).not.toBeInTheDocument();
    expect(api.listPrompts).not.toHaveBeenCalled();
    expect(api.listProjectAssets).not.toHaveBeenCalled();
  });

  it("clears Workflow links and snapshots when switching Project", async () => {
    const form = populatedBatchForm();
    form.workflowLibraryProjectId = "project-1";
    form.workflowId = "workflow-1";
    form.workflowName = "Portrait";
    form.workflowVersionId = "workflow-v1";
    form.workflowVersionNumber = 1;
    form.workflowProfileId = "profile-1";
    form.workflowProfileName = "Default";
    form.workflowProfileVersionId = "profile-v1";
    form.workflowProfileVersionNumber = 1;
    form.workflowProfileWorkflowVersionId = "workflow-v1";
    form.workflowJson = '{"project":"a"}';
    form.workflowProfileJson = '{"profile":"a"}';
    saveWorkingSession(form, null, [], "project-1");
    const next = projectResponse({ id: "project-2", filesystem_key: "project_2", name: "Next" });
    const api = makeApi({ listProjects: vi.fn(async () => ({ projects: [projectResponse(), next] })) });
    render(<App api={api} />);

    const selector = await screen.findByRole("combobox", { name: "Active Project" });
    fireEvent.change(selector, { target: { value: next.id } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(loadWorkingSession().selectedProjectId).toBe("project-2"));
    const restored = loadWorkingSession().form;
    expect(restored.workflowId).toBeNull();
    expect(restored.workflowProfileId).toBeNull();
    expect(restored.workflowJson).toBe("{}");
    expect(restored.workflowProfileJson).toBe("{}");
  });

  it("confirms before clearing detached Workflow/Profile snapshots", async () => {
    const form = populatedBatchForm();
    form.prompts = [];
    form.imageBindings = [];
    form.workflowLibraryProjectId = null;
    form.workflowId = null;
    form.workflowVersionId = null;
    form.workflowProfileId = null;
    form.workflowProfileVersionId = null;
    form.workflowJson = '{"detached":"workflow"}';
    form.workflowProfileJson = '{"detached":"profile"}';
    saveWorkingSession(form, null, [], "project-1");
    const next = projectResponse({ id: "project-2", filesystem_key: "project_2", name: "Next" });
    const api = makeApi({ listProjects: vi.fn(async () => ({ projects: [projectResponse(), next] })) });
    render(<App api={api} />);

    const selector = await screen.findByRole("combobox", { name: "Active Project" });
    fireEvent.change(selector, { target: { value: next.id } });
    expect(screen.getByRole("dialog", { name: "Change Project?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(loadWorkingSession().form.workflowJson).toBe('{"detached":"workflow"}');
    expect(loadWorkingSession().form.workflowProfileJson).toBe('{"detached":"profile"}');

    fireEvent.change(selector, { target: { value: next.id } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(loadWorkingSession().selectedProjectId).toBe(next.id));
    expect(loadWorkingSession().form.workflowJson).toBe("{}");
    expect(loadWorkingSession().form.workflowProfileJson).toBe("{}");
  });
});

describe("Batch preview", () => {
  it("keeps section titles while omitting decorative workflow chrome", () => {
    render(<App api={makeApi()} />);

    expect(screen.getByRole("heading", { name: "Batch configuration" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Preview" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Run" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Results" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Batch Results" })).toBeInTheDocument();
    expect(screen.queryByText("One Batch. An explicit Job plan. A durable Run.")).not.toBeInTheDocument();
    expect(screen.queryByText(/Working draft/)).not.toBeInTheDocument();
    expect(screen.queryByText(/0[1-5] \/ /)).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Preview" })).toHaveClass("inactive-card");
    expect(screen.getByRole("region", { name: "Run" })).toHaveClass("inactive-card");
    expect(screen.getByRole("region", { name: "Results" })).toHaveClass("inactive-card");
    expect(screen.getByRole("region", { name: "Batch Results" })).toHaveClass("inactive-card");
    expect(screen.getByText("Preview required")).toBeInTheDocument();
    expect(screen.getByText("Create a Run to continue")).toBeInTheDocument();
    expect(screen.getByText("Awaiting a Run")).toBeInTheDocument();
    expect(screen.getByText("No session Results yet")).toBeInTheDocument();
  });

  it("summarizes configured experiment sections before expanding their controls", async () => {
    render(<App api={makeApi()} />);

    const prompts = screen.getByRole("group", { name: "Prompt Versions" });
    const promptEdit = await within(prompts).findByRole("button", { name: "Edit" });
    expect(prompts).toHaveTextContent("1 prompt");
    expect(promptEdit).toHaveAttribute("aria-expanded", "false");
    expect(within(prompts).queryByRole("button", { name: "Add Prompt" })).not.toBeInTheDocument();

    const bindings = screen.getByRole("group", { name: "Variable bindings" });
    expect(bindings).toHaveTextContent("subject: 2 values · cat, dog");
    expect(within(bindings).getByRole("button", { name: "Edit" })).toHaveAttribute("aria-expanded", "false");

    const seeds = screen.getByRole("group", { name: "Seeds" });
    expect(seeds).toHaveTextContent("Fixed · 1");
    expect(within(seeds).getByRole("button", { name: "Edit" })).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(promptEdit);
    expect(within(prompts).getByRole("button", { name: "Add Prompt" })).toBeInTheDocument();
  });

  it("places Prompt and Variable add actions in the shared section action area", async () => {
    render(<App api={makeApi()} />);

    await expandConfiguration("Prompt Versions");
    const prompts = screen.getByRole("group", { name: "Prompt Versions" });
    const addPrompt = within(prompts).getByRole("button", { name: "Add Prompt" });
    expect(addPrompt.closest(".section-summary-actions")).not.toBeNull();

    await expandConfiguration("Variable bindings");
    const bindings = screen.getByRole("group", { name: "Variable bindings" });
    const addBinding = within(bindings).getByRole("button", { name: "Add Binding" });
    expect(addBinding.closest(".section-summary-actions")).not.toBeNull();
    fireEvent.click(addBinding);
    expect(within(bindings).getAllByLabelText("Values")).toHaveLength(2);
  });

  it("edits ordered Variable Binding lines and toggles one exact empty value", async () => {
    render(<App api={makeApi()} />);
    await expandConfiguration("Variable bindings");

    const values = screen.getByLabelText("Values");
    const draft = " fox, silver \n\n wolf  \nfox, silver\n";
    fireEvent.change(values, { target: { value: draft } });

    expect(values).toHaveValue(draft);
    expect(screen.getByText("One value per non-empty line")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add Value/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Move value/i })).not.toBeInTheDocument();

    const includeEmpty = screen.getByRole("checkbox", { name: "Include empty value" });
    fireEvent.click(includeEmpty);
    expect(includeEmpty).toBeChecked();
    expect(values).toHaveValue(draft);
    await waitFor(() => expect(loadWorkingSession().form.variableBindings[0].values).toEqual([
      "",
      " fox, silver ",
      " wolf  ",
      "fox, silver",
    ]));

    fireEvent.click(includeEmpty);
    expect(includeEmpty).not.toBeChecked();
    await waitFor(() => expect(loadWorkingSession().form.variableBindings[0].values).toEqual([
      " fox, silver ",
      " wolf  ",
      "fox, silver",
    ]));
  });

  it("treats an empty value as configured and explains it in the summary", () => {
    const form = populatedBatchForm();
    form.variableBindings[0].values = [""];
    saveWorkingSession(form, null, [], "project-1");

    render(<App api={makeApi()} />);

    const bindings = screen.getByRole("group", { name: "Variable bindings" });
    expect(bindings).toHaveTextContent("subject: 1 value · (empty)");
    expect(within(bindings).getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("preserves an empty value's deterministic position while editing visible lines", async () => {
    const form = populatedBatchForm();
    form.variableBindings[0].values = ["cat", "", "dog"];
    saveWorkingSession(form, null, [], "project-1");
    render(<App api={makeApi()} />);
    await expandConfiguration("Variable bindings");

    const values = screen.getByLabelText("Values");
    fireEvent.change(values, { target: { value: "fox\ndog" } });
    await waitFor(() => expect(loadWorkingSession().form.variableBindings[0].values).toEqual([
      "fox",
      "",
      "dog",
    ]));

    fireEvent.change(values, { target: { value: "dog" } });
    await waitFor(() => expect(loadWorkingSession().form.variableBindings[0].values).toEqual([
      "",
      "dog",
    ]));
  });

  it("ignores whitespace-only values when preserving an empty value's position", async () => {
    const form = populatedBatchForm();
    form.variableBindings[0].values = ["   ", "", "dog"];
    saveWorkingSession(form, null, [], "project-1");
    render(<App api={makeApi()} />);
    await expandConfiguration("Variable bindings");

    const values = screen.getByLabelText("Values");
    expect(values).toHaveValue("dog");
    fireEvent.change(values, { target: { value: "wolf" } });
    await waitFor(() => expect(loadWorkingSession().form.variableBindings[0].values).toEqual([
      "",
      "wolf",
    ]));
  });

  it("places Image Inputs after the Workflow Profile that defines them", () => {
    const api = makeApi();
    render(<App api={api} />);

    const workflow = screen.getByRole("group", { name: "Workflow and Profile" });
    const imageInputs = screen.getByRole("group", { name: "Image Inputs" });

    expect(workflow.compareDocumentPosition(imageInputs) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("builds the API request and renders Jobs and compiler warnings", async () => {
    const api = makeApi({ previewBatch: vi.fn(async () => previewResponse()) });
    render(<App api={api} />);
    await enterAsset();

    await waitFor(() => expect(screen.getByRole("button", { name: "Preview Batch" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));

    expect(await screen.findByText("Compiler warnings")).toBeInTheDocument();
    expect(screen.getByText("Unused binding variable")).toBeInTheDocument();
    expect(screen.getByText("A studio portrait of cat.")).toBeInTheDocument();
    expect(screen.getByText("subject = cat")).toBeInTheDocument();
    expect(screen.getAllByText("Portrait", { selector: ".prompt-identity strong" })).toHaveLength(2);
    expect(screen.queryByText("prompt-v1", { selector: ".prompt-identity code" })).not.toBeInTheDocument();
    const request = vi.mocked(api.previewBatch).mock.calls[0][0];
    expect(request.image_bindings).toEqual([{ slot_key: "source", values: [null, "asset-1"] }]);
    expect(request.seeds).toEqual({ mode: "fixed", values: [1] });
    expect(request.variable_bindings[0]).toEqual(
      { placeholder: "subject", values: ["cat", "dog"] },
    );
  });

  it("previews Base workflow for a named Image Input", async () => {
    const api = makeApi({ previewBatch: vi.fn(async () => previewResponse(2, null)) });
    render(<App api={api} />);
    await screen.findByRole("button", { name: "Add portrait.png to Source image" });

    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));

    await waitFor(() => expect(api.previewBatch).toHaveBeenCalledOnce());
    expect(vi.mocked(api.previewBatch).mock.calls[0][0].image_bindings).toEqual([{ slot_key: "source", values: [null] }]);
    expect(screen.getAllByText("Base workflow").length).toBeGreaterThanOrEqual(2);
  });

  it("renders backend validation errors near the Batch editor", async () => {
    const api = makeApi({
      previewBatch: vi.fn(async () => {
        throw new ApiError("Binding values contain exact duplicates", "invalid_batch", 422);
      }),
    });
    render(<App api={api} />);
    await enterAsset();

    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));

    expect(
      await screen.findByText("Binding values contain exact duplicates"),
    ).toBeInTheDocument();
  });

  it("rejects invalid workflow and Workflow Profile JSON before fetching", async () => {
    const api = makeApi();
    render(<App api={api} />);
    await enterAsset();

    fireEvent.change(screen.getByLabelText("Workflow JSON"), { target: { value: "{" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    expect(await screen.findByText(/Workflow JSON is invalid/)).toBeInTheDocument();
    expect(api.previewBatch).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Workflow JSON"), { target: { value: "{}" } });
    fireEvent.change(screen.getByLabelText("Workflow Profile JSON"), {
      target: { value: "[]" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    expect(await screen.findByText("Workflow Profile JSON must have an object at its root.")).toBeInTheDocument();
    expect(api.previewBatch).not.toHaveBeenCalled();
  });

  it("does not restore a stale preview after the form changes", async () => {
    const pendingPreview = deferred<PreviewResponse>();
    const api = makeApi({ previewBatch: vi.fn(() => pendingPreview.promise) });
    render(<App api={api} />);
    await enterAsset();
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));

    fireEvent.change(screen.getByLabelText("Batch name"), {
      target: { value: "Changed while previewing" },
    });
    pendingPreview.resolve(previewResponse());

    await waitFor(() => expect(screen.getByRole("button", { name: "Preview Batch" })).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Create Run" })).not.toBeInTheDocument();
  });

  it("creates a two-Job Run from the exact BatchRequest stored with its Preview", async () => {
    const assets = [asset("asset-a", "a.png")];
    const api = makeApi({
      listProjectAssets: vi.fn(async () => ({ assets })),
      previewBatch: vi.fn(async () => previewResponse(2)),
      createRun: vi.fn(async () => runResponse("run-two", 2, 2)),
    });
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a.png to Source image" }));

    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    await screen.findByRole("button", { name: "Create Run" });
    const previewRequest = vi.mocked(api.previewBatch).mock.calls[0][0];
    expect(previewRequest.image_bindings).toEqual([{ slot_key: "source", values: [null, "asset-a"] }]);
    expect(screen.getByText("2", { selector: ".count-block strong" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));

    expect(await screen.findByRole("heading", { name: "Run 2" })).toBeInTheDocument();
    expect(vi.mocked(api.createRun).mock.calls[0][0]).toBe(previewRequest);
    expect(screen.getByText("0 / 2 Jobs")).toBeInTheDocument();
  });

  it("materializes Random seeds once and consumes the Preview after successful Run creation", async () => {
    const alternate = projectPrompt("prompt-2", "Editorial", promptVersion({
      id: "prompt-v2",
      prompt_id: "prompt-2",
      name_snapshot: "Editorial",
      text: "A second portrait of {{subject}}.",
    }));
    const api = makeApi({
      listPrompts: vi.fn(async () => ({ prompts: [projectPrompt(), alternate] })),
      previewBatch: vi.fn(async () => previewResponse(3)),
      createRun: vi.fn(async () => runResponse("run-random", 4, 3)),
    });
    render(<App api={api} />);
    await enterAsset();
    await expandConfiguration("Seeds");
    fireEvent.change(screen.getByLabelText("Seed mode"), { target: { value: "random" } });
    fireEvent.change(screen.getByLabelText(/Random seed count/), { target: { value: "3" } });
    await addExistingPrompt("Editorial");

    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    await screen.findByRole("button", { name: "Create Run" });
    const previewRequest = vi.mocked(api.previewBatch).mock.calls[0][0];
    expect(previewRequest.seeds.mode).toBe("explicit");
    expect(previewRequest.seeds.values).toHaveLength(3);
    expect(previewRequest.prompt_versions).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));

    expect(await screen.findByRole("heading", { name: "Run 4" })).toBeInTheDocument();
    expect(vi.mocked(api.createRun).mock.calls[0][0]).toBe(previewRequest);
    expect(screen.getByText(/Preview required/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create Run" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Seed mode")).toHaveValue("random");
    expect(screen.getByLabelText(/Random seed count/)).toHaveValue(3);
  });

  it("retains a Random Preview when Run creation fails", async () => {
    const api = makeApi({
      createRun: vi.fn(async () => {
        throw new ApiError("Run publication failed", "run_publication_failed", 500);
      }),
    });
    render(<App api={api} />);
    await enterAsset();
    await expandConfiguration("Seeds");
    fireEvent.change(screen.getByLabelText("Seed mode"), { target: { value: "random" } });
    fireEvent.change(screen.getByLabelText(/Random seed count/), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    const createRun = await screen.findByRole("button", { name: "Create Run" });
    const previewRequest = vi.mocked(api.previewBatch).mock.calls[0][0];

    fireEvent.click(createRun);

    expect(await screen.findByText("Run publication failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Run" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));
    await waitFor(() => expect(api.createRun).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.createRun).mock.calls[0][0]).toBe(previewRequest);
    expect(vi.mocked(api.createRun).mock.calls[1][0]).toBe(previewRequest);
  });

  it("invalidates Preview after Image Input edits and requires Preview before creation", async () => {
    const assets = [
      asset("asset-a", "a.png"),
      asset("asset-b", "b.png"),
      asset("asset-c", "c.png"),
    ];
    const api = makeApi({
      listProjectAssets: vi.fn(async () => ({ assets })),
      previewBatch: vi
        .fn<BatchcraftApi["previewBatch"]>()
        .mockResolvedValueOnce(previewResponse(2))
        .mockResolvedValueOnce(previewResponse(3)),
      createRun: vi.fn(async () => runResponse("run-three", 3, 3)),
    });
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a.png to Source image" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    await screen.findByRole("button", { name: "Create Run" });

    fireEvent.click(screen.getByRole("button", { name: "Add c.png to Source image" }));

    expect(screen.getByText(/Preview required/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create Run" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    await waitFor(() => expect(api.previewBatch).toHaveBeenCalledTimes(2));
    expect(screen.getByText("3", { selector: ".count-block strong" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));

    expect(await screen.findByRole("heading", { name: "Run 3" })).toBeInTheDocument();
    expect(vi.mocked(api.createRun).mock.calls[0][0].image_bindings).toEqual([{ slot_key: "source", values: [null, "asset-a", "asset-c"] }]);
  });

  it("constructs typed Parameter overrides and invalidates Preview after edits", async () => {
    const form = populatedBatchForm();
    form.workflowProfileJson = JSON.stringify({ mappings: {}, image_inputs: [], parameters: [
      { key: "caption", label: "Caption", node_id: "1", input_name: "caption", value_type: "string" },
      { key: "enabled", label: "Enabled", node_id: "1", input_name: "enabled", value_type: "boolean" },
    ] });
    form.imageBindings = [];
    form.parameterBindings = [
      { parameterKey: "unknown", valueType: "string", alternatives: [{ kind: "override", value: "remove me" }] },
      { parameterKey: "caption", valueType: "string", alternatives: [{ kind: "base" }] },
    ];
    saveWorkingSession(form, null, [], "project-1");
    const parameterPreview = previewResponse();
    parameterPreview.jobs.forEach((job) => {
      job.resolved_parameters = [
        { parameter_key: "caption", label: "Caption", value: "" },
        { parameter_key: "enabled", label: "Enabled", value: false },
      ];
    });
    const api = makeApi({ previewBatch: vi.fn(async () => parameterPreview) });
    render(<App api={api} />);
    await screen.findByText(/Draft restored from this browser session/);

    expect(screen.getByRole("checkbox", { name: "Include Base workflow for Caption" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Include Base workflow for Enabled" })).toBeChecked();
    expect(screen.queryByText("unknown")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add override for Caption" }));
    fireEvent.click(screen.getByRole("button", { name: "Add override for Enabled" }));
    fireEvent.change(screen.getByLabelText("Enabled override 2"), { target: { value: "false" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    await screen.findByRole("button", { name: "Create Run" });

    expect(vi.mocked(api.previewBatch).mock.calls[0][0].parameter_bindings).toEqual([
      { parameter_key: "caption", values: [null, ""] },
      { parameter_key: "enabled", values: [null, false] },
    ]);
    expect(screen.getAllByText('"" (empty string)').length).toBeGreaterThan(0);
    expect(screen.getAllByText("false").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("Caption override 2"), { target: { value: "changed" } });
    expect(screen.getByText(/Preview required/)).toBeInTheDocument();
  });
});

describe("PromptVersion editor", () => {
  it("supports stable library add, reorder, and removal to an empty selection", async () => {
    const alternate = projectPrompt("prompt-2", "Editorial", promptVersion({
      id: "prompt-v2",
      prompt_id: "prompt-2",
      name_snapshot: "Editorial snapshot",
      text: "Editorial {{subject}}",
    }));
    const api = makeApi({
      listPrompts: vi.fn(async () => ({ prompts: [projectPrompt(), alternate] })),
    });
    render(<App api={api} />);

    expect(screen.getByRole("group", { name: "Prompt Versions" })).toBeInTheDocument();
    expect(screen.getByText("A studio portrait of {{subject}}.")).toBeInTheDocument();
    expect(within(promptCards()[0]).getByRole("button", { name: "Remove" })).toBeEnabled();

    await addExistingPrompt("Editorial");
    expect(promptCards()).toHaveLength(2);
    const secondCard = promptCards()[1];
    expect(within(secondCard).getByText("Editorial {{subject}}")).toBeInTheDocument();
    expect(within(secondCard).getByText("Saved as Editorial snapshot")).toBeInTheDocument();
    fireEvent.click(within(secondCard).getByRole("button", { name: "Move up" }));

    expect(within(promptCards()[0]).getByText("Editorial {{subject}}")).toBeInTheDocument();

    fireEvent.click(within(promptCards()[0]).getByRole("button", { name: "Remove" }));
    expect(promptCards()).toHaveLength(1);
    expect(within(promptCards()[0]).getByText("Portrait")).toBeInTheDocument();
    fireEvent.click(within(promptCards()[0]).getByRole("button", { name: "Remove" }));

    expect(promptCards()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Add Prompt" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    expect(await screen.findByText("Add at least one PromptVersion.")).toBeInTheDocument();
    expect(api.previewBatch).not.toHaveBeenCalled();
  });

  it("creates a new PromptVersion through form change and invalidates Preview", async () => {
    const nextVersion = promptVersion({
      id: "prompt-v2",
      version_number: 2,
      text: "Changed {{subject}}",
    });
    const api = makeApi({ createPromptVersion: vi.fn(async () => nextVersion) });
    render(<App api={api} />);
    await expandConfiguration("Prompt Versions");
    const edit = await screen.findByRole("button", { name: "Edit as new version" });
    await reachPreview();
    expect(screen.getByRole("button", { name: "Create Run" })).toBeEnabled();

    fireEvent.click(edit);
    fireEvent.change(screen.getByLabelText("Prompt template"), {
      target: { value: "Changed {{subject}}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create version" }));

    expect(await screen.findByText(/Preview required/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create Run" })).not.toBeInTheDocument();
    expect(api.createPromptVersion).toHaveBeenCalledWith("prompt-1", {
      text: "Changed {{subject}}",
      note: null,
    });
  });

  it("retains Preview when only the logical Prompt name changes", async () => {
    const renamed = { ...projectPrompt(), name: "Renamed" };
    const api = makeApi({ updatePrompt: vi.fn(async () => renamed) });
    render(<App api={api} />);
    await expandConfiguration("Prompt Versions");
    const rename = await screen.findByRole("button", { name: "Rename Prompt" });
    await reachPreview();

    fireEvent.click(rename);
    fireEvent.change(screen.getByLabelText("Prompt name"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    expect(await screen.findByText("Renamed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Run" })).toBeEnabled();
    expect(screen.getByText("Saved as Portrait")).toBeInTheDocument();
  });
});

describe("Browser working-session restoration", () => {
  it("restores ordered named Image Inputs after remount but requires a new Preview", async () => {
    const assets = [asset("asset-a", "a.png"), asset("asset-b", "b.png")];
    const api = makeApi({ listProjectAssets: vi.fn(async () => ({ assets })) });
    const form = populatedBatchForm();
    form.prompts[0].text = "Restored portrait of {{subject}}";
    form.prompts.push({
      ...newPrompt(2),
      versionId: "prompt-editorial",
      promptName: "Editorial",
      snapshotName: "Editorial",
      text: "Editorial image of {{subject}}",
    });
    form.variableBindings[0].values = ["fox", "wolf"];
    form.seedMode = "explicit";
    form.seedValues = "9, 3";
    form.workflowJson = '{"workflow":true}';
    form.workflowProfileJson = profileJson([
      { key: "style", label: "Style", node_id: "1", input_name: "image" },
      { key: "pose", label: "Pose", node_id: "2", input_name: "image" },
    ]);
    form.imageBindings = [
      { slot_key: "style", values: ["asset-b"] },
      { slot_key: "pose", values: ["asset-a"] },
    ];
    saveWorkingSession(form, null, [], "project-1");

    render(<App api={api} />);

    expect(await screen.findByText(/Draft restored from this browser session/)).toBeInTheDocument();
    expect(screen.getByText("Restored portrait of {{subject}}")).toBeInTheDocument();
    expect(screen.getByText("Editorial image of {{subject}}")).toBeInTheDocument();
    await expandConfiguration("Variable bindings");
    await expandConfiguration("Seeds");
    expect(screen.getByLabelText("Values")).toHaveValue("fox\nwolf");
    expect(screen.getByLabelText("Seed mode")).toHaveValue("explicit");
    expect(screen.getByLabelText(/Explicit seeds/)).toHaveValue("9, 3");
    expect(screen.getByLabelText("Workflow JSON")).toHaveValue('{"workflow":true}');
    expect(screen.getByRole("button", { name: "Remove b.png from Style" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Remove a.png from Pose" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/Preview required/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create Run" })).not.toBeInTheDocument();
  });

  it("keeps Preview usable when sessionStorage writes fail", async () => {
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    const api = makeApi();
    render(<App api={api} />);
    await enterAsset();

    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));

    expect(await screen.findByRole("button", { name: "Create Run" })).toBeEnabled();
    expect(api.previewBatch).toHaveBeenCalledOnce();
    write.mockRestore();
  });

  it("surfaces a missing Image Input asset and blocks Preview", async () => {
    const form = populatedBatchForm();
    form.imageBindings = [{ slot_key: "source", values: ["asset-missing"] }];
    saveWorkingSession(form, null, [], "project-1");
    const api = makeApi();
    render(<App api={api} />);

    await waitFor(() => {
      expect(screen.getByText("Missing Project Asset 1")).toBeInTheDocument();
      expect(screen.getByText(/One or more selected Project Assets are missing/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));

    expect(
      await screen.findByText(/Selected Image Input assets are no longer available/),
    ).toBeInTheDocument();
    expect(api.previewBatch).not.toHaveBeenCalled();
  });
});

describe("Image Input controls", () => {
  it("renders one control per slot in Profile order and fetches the library once", async () => {
    const form = populatedBatchForm();
    form.workflowProfileJson = profileJson([
      { key: "style", label: "Style", node_id: "1", input_name: "image" },
      { key: "pose", label: "Pose", node_id: "2", input_name: "image" },
    ]);
    form.imageBindings = [
      { slot_key: "style", values: [null] },
      { slot_key: "pose", values: ["asset-a"] },
    ];
    saveWorkingSession(form, null, [], "project-1");
    const api = makeApi({ listProjectAssets: vi.fn(async () => ({ assets: [asset("asset-a", "a.png")] })) });
    render(<App api={api} />);

    await screen.findAllByRole("button", { name: /a\.png/ });
    const imageInputs = screen.getByRole("group", { name: "Image Inputs" });
    expect(within(imageInputs).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["Style", "Pose"]);
    expect(within(imageInputs).getByRole("button", { name: "Base workflow for Style" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Remove a.png from Pose" })).toHaveAttribute("aria-pressed", "true");
    expect(api.listProjectAssets).toHaveBeenCalledOnce();
  });

  it("preserves ordered alternatives independently across named slots", async () => {
    const form = populatedBatchForm();
    form.workflowProfileJson = profileJson([
      { key: "style", label: "Style", node_id: "1", input_name: "image" },
      { key: "pose", label: "Pose", node_id: "2", input_name: "image" },
    ]);
    form.imageBindings = [
      { slot_key: "style", values: [null] },
      { slot_key: "pose", values: [null] },
    ];
    saveWorkingSession(form, null, [], "project-1");
    const assets = [
      asset("asset-a", "a.png"),
      asset("asset-b", "b.png"),
      asset("asset-c", "c.png"),
    ];
    render(<App api={makeApi({ listProjectAssets: vi.fn(async () => ({ assets })) })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Add a.png to Style" }));
    fireEvent.click(screen.getByRole("button", { name: "Add b.png to Style" }));
    fireEvent.click(screen.getByRole("button", { name: "Add c.png to Pose" }));

    expect(loadWorkingSession().form.imageBindings).toEqual([
      { slot_key: "style", values: [null, "asset-a", "asset-b"] },
      { slot_key: "pose", values: [null, "asset-c"] },
    ]);
    const selected = screen.getByRole("list", { name: "Style selected alternatives" });
    expect(within(selected).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Base workflowRemove",
      "a.pngRemove",
      "b.pngRemove",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Remove a.png from Style" }));

    expect(loadWorkingSession().form.imageBindings[0]).toEqual({
      slot_key: "style",
      values: [null, "asset-b"],
    });
  });

  it("excludes Base workflow independently and invalidates Preview", async () => {
    render(<App api={makeApi()} />);
    await reachPreview();
    fireEvent.click(screen.getByRole("button", { name: "Base workflow for Source image" }));

    expect(screen.getByText(/Preview required/)).toBeInTheDocument();
    expect(loadWorkingSession().form.imageBindings).toEqual([{ slot_key: "source", values: ["asset-1"] }]);
  });
});

describe("Run creation", () => {
  it("creates a Run from the current form and renders durable metadata", async () => {
    const api = makeApi({ previewBatch: vi.fn(async () => previewResponse()) });
    render(<App api={api} />);
    await reachPreview();

    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));

    expect(await screen.findByRole("heading", { name: "Run 7" })).toBeInTheDocument();
    expect(within(currentRunSection()).getByText("run-123")).toBeInTheDocument();
    expect(screen.getByText("Created · Ready to start")).toBeInTheDocument();
    expect(screen.getByText("Run 7 is frozen and ready to start.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Run" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Discard Run" })).toBeEnabled();
    expect(api.createRun).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Create Another Run" })).toBeDisabled();
    expect(screen.getByText("Created as Run 7.")).toBeInTheDocument();
  });

  it("renders Run creation errors", async () => {
    const api = makeApi({
      previewBatch: vi.fn(async () => previewResponse()),
      createRun: vi.fn(async () => {
        throw new ApiError("Project assets were not found: asset-1", "project_asset_not_found", 404);
      }),
    });
    render(<App api={api} />);
    await reachPreview();

    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));

    expect(await screen.findByText("Project assets were not found: asset-1")).toBeInTheDocument();
  });

  it("preserves a newly durable Run and reports a Preview job-count mismatch", async () => {
    const api = makeApi({ createRun: vi.fn(async () => runResponse("run-mismatch", 9, 3)) });
    render(<App api={api} />);
    await reachPreview();

    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));

    expect(await screen.findByRole("heading", { name: "Run 9" })).toBeInTheDocument();
    expect(within(currentRunSection()).getByText("run-mismatch")).toBeInTheDocument();
    expect(screen.getByText(/Run 9 was created with 3 Jobs, but the inspected Preview has 2/))
      .toHaveClass("consistency-error");
    expect(screen.getByText("Run 9 was created but does not match this Preview.")).toBeInTheDocument();
  });

  it("keeps the frozen Run Plan inspectable after creation and current Batch edits", async () => {
    const frozen = runLookupResponse("created", "run-plan", 27);
    frozen.prompt_versions = [
      { id: "prompt-b", name: "Editorial", text: "Editorial {{subject}}" },
      { id: "prompt-a", name: "Portrait", text: "Portrait {{subject}}" },
    ];
    frozen.jobs = [
      { ordinal: 1, prompt_version_id: "prompt-b" },
      { ordinal: 2, prompt_version_id: "prompt-a" },
    ];
    frozen.plan.jobs = [
      {
        ordinal: 1,
        prompt_version_id: "prompt-b",
        prompt_version_name: "Editorial",
        resolved_prompt: "Editorial cat",
        resolved_variables: [
          { name: "subject", value: "cat" },
          { name: "style", value: "editorial" },
        ],
        resolved_image_inputs: [{ slot_key: "source", label: "Source image", asset_id: null, filename: null }],
        resolved_parameters: [{ parameter_key: "steps", label: "Steps", value: null }],
        seed: 123,
      },
      {
        ordinal: 2,
        prompt_version_id: "prompt-a",
        prompt_version_name: "Portrait",
        resolved_prompt: "Portrait dog",
        resolved_variables: [
          { name: "subject", value: "dog" },
          { name: "style", value: "editorial" },
        ],
        resolved_image_inputs: [{ slot_key: "source", label: "Source image", asset_id: "asset-1", filename: "portrait.png" }],
        resolved_parameters: [{ parameter_key: "steps", label: "Steps", value: 30 }],
        seed: 456,
      },
    ];
    frozen.batch_snapshot.prompt_versions = [
      { id: "prompt-b", prompt_id: "prompt-2", version_number: 2, name: "Editorial", text: "Editorial {{subject}}" },
      { id: "prompt-a", prompt_id: "prompt-1", version_number: 4, name: "Portrait", text: "Portrait {{subject}}" },
    ];
    frozen.batch_snapshot.image_bindings = [{ slot_key: "source", values: [null, "asset-1"] }];
    frozen.batch_snapshot.parameter_bindings = [{ parameter_key: "steps", values: [null, 30, 0] }];
    frozen.batch_snapshot.seed_intent = { mode: "random", values: [], random_seed_count: 2 };
    frozen.batch_snapshot.variable_bindings.push({ placeholder: "style", values: ["editorial"] });
    const api = makeApi({
      createRun: vi.fn(async () => runResponse("run-plan", 27, 2)),
      getRun: vi.fn(async () => frozen),
    });
    render(<App api={api} />);
    await reachPreview();

    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));
    await screen.findByRole("button", { name: "View Run Plan" });
    expect(screen.getByText(/2 prompts · 2 variable combinations · 1 image slot · 2 alternatives · 2 seeds/))
      .toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Batch name"), { target: { value: "Edited afterward" } });
    fireEvent.click(screen.getByRole("button", { name: "View Run Plan" }));

    const dialog = screen.getByRole("dialog", { name: "Run 27 Plan" });
    expect(within(dialog).getByRole("heading", { name: "First experiment" })).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent("Edited afterward");
    expect([...dialog.querySelectorAll(".run-plan-prompts > li > strong")].map((node) => node.textContent))
      .toEqual(["Editorial", "Portrait"]);
    expect(within(dialog).getByText("2 values · cat, dog")).toBeInTheDocument();
    expect(within(dialog).getByText("1 value · editorial")).toBeInTheDocument();
    expect(within(dialog).getByText("Random · 2 requested")).toBeInTheDocument();
    expect(within(dialog).getByText("123, 456")).toBeInTheDocument();
    expect(within(dialog).getAllByText("Base workflow").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("portrait.png").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("asset-1").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Steps").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("30").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("0")).toBeInTheDocument();
    expect(within(dialog).queryByText("steps")).not.toBeInTheDocument();
    expect(within(dialog).getByText("KREA2 Outfit · v4")).toBeInTheDocument();
    expect(within(dialog).getByText("General · v4")).toBeInTheDocument();
    expect(within(dialog).getByText("Editorial cat")).toBeInTheDocument();
  });

  it("shows exact snapshot divergence and clears it after an exact revert", async () => {
    const api = makeApi({
      getRun: vi.fn(async (runId: string) => {
        const frozen = runLookupResponse("created", runId, 7);
        frozen.batch_snapshot = vi.mocked(api.previewBatch).mock.calls[0][0].batch_snapshot;
        return frozen;
      }),
    });
    render(<App api={api} />);
    await reachPreview();
    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));

    await screen.findByRole("button", { name: "View Run Plan" });
    expect(screen.queryByText("The current Batch has changed since this Run was created.")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Batch name"), { target: { value: "Edited afterward" } });
    expect(screen.getByText("The current Batch has changed since this Run was created.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View Run Plan" }));
    expect(screen.getByRole("dialog", { name: "Run 7 Plan" })).toHaveTextContent("First experiment");
    fireEvent.click(within(screen.getByRole("dialog", { name: "Run 7 Plan" })).getByRole("button", { name: "Close" }));

    fireEvent.change(screen.getByLabelText("Batch name"), { target: { value: "First experiment" } });
    expect(screen.queryByText("The current Batch has changed since this Run was created.")).not.toBeInTheDocument();
  });

  it("uses the creation request snapshot before the frozen Run finishes loading", async () => {
    const frozenRequest = deferred<RunResponse>();
    const api = makeApi({ getRun: vi.fn(() => frozenRequest.promise) });
    render(<App api={api} />);
    await reachPreview();
    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));
    await screen.findByText("Run 7 is frozen and ready to start.");

    fireEvent.change(screen.getByLabelText("Batch name"), { target: { value: "Changed while loading" } });
    expect(screen.getByText("The current Batch has changed since this Run was created.")).toBeInTheDocument();

    const frozen = runLookupResponse("created");
    frozen.batch_snapshot = vi.mocked(api.previewBatch).mock.calls[0][0].batch_snapshot;
    frozenRequest.resolve(frozen);
    await screen.findByRole("button", { name: "View Run Plan" });
    expect(screen.getByText("The current Batch has changed since this Run was created.")).toBeInTheDocument();
  });
});

describe("Discard unstarted Run", () => {
  it("keeps discarded provenance inspectable and permits another immutable Run", async () => {
    const createRun = vi
      .fn<BatchcraftApi["createRun"]>()
      .mockResolvedValueOnce(runResponse("run-discarded", 7))
      .mockResolvedValueOnce(runResponse("run-next", 8));
    const api = makeApi({
      createRun,
      discardRun: vi.fn(async (runId: string) => execution("cancelled", runId)),
      getRun: vi.fn(async (runId: string) => {
        const runNumber = runId === "run-discarded" ? 7 : 8;
        const frozen = runLookupResponse("created", runId, runNumber);
        frozen.batch_snapshot = vi.mocked(api.previewBatch).mock.calls[0][0].batch_snapshot;
        return frozen;
      }),
    });
    render(<App api={api} />);
    await reachPreview();
    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));
    await screen.findByRole("button", { name: "View Run Plan" });

    fireEvent.click(screen.getByRole("button", { name: "Discard Run" }));

    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
    expect(api.discardRun).toHaveBeenCalledWith("run-discarded");
    expect(screen.queryByRole("button", { name: "Start Run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard Run" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View Run Plan" })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "Active Project" })).toBeEnabled();
    const createAnother = screen.getByRole("button", { name: "Create Another Run" });
    expect(createAnother).toBeEnabled();
    fireEvent.click(createAnother);

    expect(await screen.findByRole("heading", { name: "Run 8" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Run 7" })).getByText("run-discarded")).toBeInTheDocument();
    expect(within(currentRunSection()).getByText("run-next")).toBeInTheDocument();
    await waitFor(() => expect(loadWorkingSession().sessionRunIds).toEqual(["run-discarded", "run-next"]));
  });

  it("keeps an ineligible created Run inspectable without wedging the workspace", async () => {
    const createRun = vi
      .fn<BatchcraftApi["createRun"]>()
      .mockResolvedValueOnce(runResponse("run-ineligible", 7))
      .mockResolvedValueOnce(runResponse("run-next", 8));
    const api = makeApi({
      createRun,
      discardRun: vi.fn(async () => {
        throw new ApiError("Run can no longer be discarded", "run_discard_not_eligible", 409);
      }),
      getExecution: vi.fn(async () => execution("created", "run-ineligible")),
      getRun: vi.fn(async (runId: string) => {
        const runNumber = runId === "run-ineligible" ? 7 : 8;
        const frozen = runLookupResponse("created", runId, runNumber);
        frozen.batch_snapshot = vi.mocked(api.previewBatch).mock.calls[0][0].batch_snapshot;
        return frozen;
      }),
    });
    render(<App api={api} pollIntervalMs={1} />);
    await reachPreview();
    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));
    await screen.findByRole("button", { name: "Discard Run" });

    fireEvent.click(screen.getByRole("button", { name: "Discard Run" }));

    expect(await screen.findByText("Created · Not executable")).toBeInTheDocument();
    expect(screen.getByText("This Run's persisted execution state is not eligible to start or discard.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start Run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard Run" })).not.toBeInTheDocument();
    expect(within(currentRunSection()).getByText("run-ineligible")).toBeInTheDocument();
    await waitFor(() => expect(
      screen.getByRole("combobox", { name: "Active Project" }),
    ).toBeEnabled());
    const createAnother = screen.getByRole("button", { name: "Create Another Run" });
    expect(createAnother).toBeEnabled();
    fireEvent.click(createAnother);
    expect(await screen.findByRole("heading", { name: "Run 8" })).toBeInTheDocument();
    expect(createRun).toHaveBeenCalledTimes(2);
    expect(api.getExecution).toHaveBeenCalledWith("run-ineligible");
  });

  it("reconciles a discarded Run when the response is lost", async () => {
    const api = makeApi({
      discardRun: vi.fn(async () => {
        throw new ApiError("Cannot reach the batchcraft API", "network_error", null);
      }),
      getExecution: vi.fn(async () => execution("cancelled")),
    });
    render(<App api={api} />);
    await reachPreview();
    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard Run" }));

    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
    expect(screen.queryByText("Cannot reach the batchcraft API")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start Run" })).not.toBeInTheDocument();
    expect(api.getExecution).toHaveBeenCalledWith("run-123");
    expect(api.getExecution).toHaveBeenCalledTimes(1);
  });

  it("reconciles execution when Start wins the discard race", async () => {
    const api = makeApi({
      discardRun: vi.fn(async () => {
        throw new ApiError("Run can no longer be discarded", "run_discard_not_eligible", 409);
      }),
      getExecution: vi.fn(async () => execution("running")),
    });
    render(<App api={api} />);
    await reachPreview();
    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard Run" }));

    expect(await screen.findByText(/^Running/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start Run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard Run" })).not.toBeInTheDocument();
    expect(api.getExecution).toHaveBeenCalledWith("run-123");
  });

  it("disables discard while Start is in progress", async () => {
    const startRequest = deferred<{ run_id: string; status: string }>();
    const api = makeApi({
      startRun: vi.fn(() => startRequest.promise),
    });
    render(<App api={api} />);
    await reachPreview();
    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));
    await screen.findByRole("button", { name: "Discard Run" });

    fireEvent.click(screen.getByRole("button", { name: "Start Run" }));
    expect(screen.getByRole("button", { name: "Discard Run" })).toBeDisabled();
    startRequest.resolve({ run_id: "run-123", status: "accepted" });
    await screen.findByText("Succeeded");
  });

  it("disables repeated discard while the request is in progress", async () => {
    const discardRequest = deferred<ExecutionResponse>();
    const api = makeApi({ discardRun: vi.fn(() => discardRequest.promise) });
    render(<App api={api} />);
    await reachPreview();
    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard Run" }));
    expect(screen.getByRole("button", { name: "Discarding..." })).toBeDisabled();
    discardRequest.resolve(execution("cancelled"));
    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
  });
});

describe("Run execution polling", () => {
  it("starts the Run, renders progress, and stops polling on success", async () => {
    const secondPoll = deferred<ExecutionResponse>();
    const api = makeApi({
      previewBatch: vi.fn(async () => previewResponse()),
      getExecution: vi
        .fn<BatchcraftApi["getExecution"]>()
        .mockResolvedValueOnce(execution("running"))
        .mockImplementationOnce(() => secondPoll.promise),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    expect(await screen.findByText("Running · Job 1 of 2")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard Run" })).not.toBeInTheDocument();
    expect(screen.queryByText("Job details")).not.toBeInTheDocument();
    expect(screen.getByText("prompt-1").closest(".job-secondary-metadata")).not.toBeNull();
    expect(api.startRun).toHaveBeenCalledWith("run-123");

    await waitFor(() => expect(api.getExecution).toHaveBeenCalledTimes(2));
    secondPoll.resolve(execution("succeeded"));
    expect(await screen.findByText("Succeeded")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard Run" })).not.toBeInTheDocument();
    await pause(20);
    expect(api.getExecution).toHaveBeenCalledTimes(2);
  });

  it.each(["failed", "blocked"] as const)("stops polling on %s", async (status) => {
    const api = makeApi({
      previewBatch: vi.fn(async () => previewResponse()),
      getExecution: vi.fn(async () => execution(status)),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    expect(await screen.findByText(status === "failed" ? "Failed" : "Blocked")).toBeInTheDocument();
    if (status === "failed") {
      expect(screen.getAllByText("generation failed").length).toBeGreaterThan(0);
    } else {
      expect(screen.getByText(/Automatic execution stopped/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Retry/i })).not.toBeInTheDocument();
    }
    await pause(20);
    expect(api.getExecution).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Discard Run" })).not.toBeInTheDocument();
  });

  it("does not overlap execution polls", async () => {
    const firstPoll = deferred<ExecutionResponse>();
    const api = makeApi({
      previewBatch: vi.fn(async () => previewResponse()),
      getExecution: vi
        .fn<BatchcraftApi["getExecution"]>()
        .mockImplementationOnce(() => firstPoll.promise)
        .mockResolvedValueOnce(execution("succeeded")),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    await waitFor(() => expect(api.getExecution).toHaveBeenCalledOnce());
    await pause(20);
    expect(api.getExecution).toHaveBeenCalledOnce();

    firstPoll.resolve(execution("running"));
    await waitFor(() => expect(api.getExecution).toHaveBeenCalledTimes(2));
  });

  it("observes durable state after an ambiguous Start network failure", async () => {
    const api = makeApi({
      previewBatch: vi.fn(async () => previewResponse()),
      startRun: vi.fn(async () => {
        throw new ApiError("Cannot reach the batchcraft API", "network_error", null);
      }),
      getExecution: vi.fn(async () => execution("succeeded")),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    expect(await screen.findByText("Succeeded")).toBeInTheDocument();
    expect(api.getExecution).toHaveBeenCalledOnce();
  });

  it("allows Start again when an ambiguous request leaves the Run created", async () => {
    const api = makeApi({
      previewBatch: vi.fn(async () => previewResponse()),
      startRun: vi.fn(async () => {
        throw new ApiError("Cannot reach the batchcraft API", "network_error", null);
      }),
      getExecution: vi.fn(async () => execution("created")),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    expect(
      await screen.findByText("The Run remains created. The Start request was not observed; it is safe to start again."),
    ).toBeInTheDocument();
    expect(api.getExecution).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("button", { name: "Start Run" })).toBeEnabled();
  });
});

describe("Repeated Runs", () => {
  it("creates a second Run from the same valid Preview after success", async () => {
    const createRun = vi
      .fn<BatchcraftApi["createRun"]>()
      .mockResolvedValueOnce(runResponse("run-1", 7))
      .mockResolvedValueOnce(runResponse("run-2", 8));
    const api = makeApi({
      createRun,
      getExecution: vi.fn(async (runId: string) => execution("succeeded", runId)),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();
    expect(await screen.findByText("Succeeded")).toBeInTheDocument();
    const previewRequest = vi.mocked(api.previewBatch).mock.calls[0][0];

    const createAnother = screen.getByRole("button", { name: "Create Another Run" });
    await waitFor(() => expect(createAnother).toBeEnabled());
    fireEvent.click(createAnother);

    expect(await screen.findByRole("heading", { name: "Run 8" })).toBeInTheDocument();
    expect(within(currentRunSection()).getByText("run-2")).toBeInTheDocument();
    expect(createRun).toHaveBeenCalledTimes(2);
    expect(createRun.mock.calls[0][0]).toBe(previewRequest);
    expect(createRun.mock.calls[1][0]).toBe(previewRequest);
    expect(previewRequest.prompt_versions.map((prompt) => prompt.name)).toEqual(["Portrait"]);
    expect(within(screen.getByRole("group", { name: "Prompt Versions" })).getByText("1 prompt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Run" })).toBeEnabled();
    expect(loadWorkingSession().currentRunId).toBe("run-2");
  });

  it.each(["failed", "blocked"] as const)(
    "allows a new Run after a %s Run without offering Retry",
    async (status) => {
      const createRun = vi
        .fn<BatchcraftApi["createRun"]>()
        .mockResolvedValueOnce(runResponse("run-1", 7))
        .mockResolvedValueOnce(runResponse("run-2", 8));
      const api = makeApi({
        createRun,
        getExecution: vi.fn(async (runId: string) => execution(status, runId)),
      });
      render(<App api={api} pollIntervalMs={5} />);
      await createRunAndStart();
      expect(
        await screen.findByText(status === "failed" ? "Failed" : "Blocked"),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Retry/i })).not.toBeInTheDocument();

      const createAnother = screen.getByRole("button", { name: "Create Another Run" });
      await waitFor(() => expect(createAnother).toBeEnabled());
      if (status === "blocked") {
        expect(screen.getByText(/previous Run is unchanged/)).toBeInTheDocument();
      }
      fireEvent.click(createAnother);

      expect(await screen.findByRole("heading", { name: "Run 8" })).toBeInTheDocument();
      expect(createRun).toHaveBeenCalledTimes(2);
    },
  );

  it("does not allow a running Run workspace to be replaced", async () => {
    const pending = deferred<ExecutionResponse>();
    const api = makeApi({
      getExecution: vi
        .fn<BatchcraftApi["getExecution"]>()
        .mockResolvedValueOnce(execution("running"))
        .mockImplementation(() => pending.promise),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    expect(await screen.findByText("Running · Job 1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Another Run" })).toBeDisabled();
    expect(await screen.findByText("The current Run is still running.")).toBeInTheDocument();
    expect(api.createRun).toHaveBeenCalledOnce();
  });

  it("keeps the previous terminal Run visible when another creation fails", async () => {
    const createRun = vi
      .fn<BatchcraftApi["createRun"]>()
      .mockResolvedValueOnce(runResponse("run-1", 7))
      .mockRejectedValueOnce(new ApiError("Run publication failed", "run_publication_failed", 500));
    const api = makeApi({
      createRun,
      getExecution: vi.fn(async (runId: string) => execution("succeeded", runId)),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();
    await screen.findByText("Succeeded");

    const createAnother = screen.getByRole("button", { name: "Create Another Run" });
    await waitFor(() => expect(createAnother).toBeEnabled());
    fireEvent.click(createAnother);

    expect(await screen.findByText("Run publication failed")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Run 7" })).toBeInTheDocument();
    expect(within(currentRunSection()).getByText("run-1")).toBeInTheDocument();
  });
});

describe("Current Run restoration", () => {
  it("restores a running Run and resumes polling without submitting execution", async () => {
    seedWorkingSession("run-running");
    const nextPoll = deferred<ExecutionResponse>();
    const api = makeApi({
      getRun: vi.fn(async () => runLookupResponse("running", "run-running", 11)),
      getExecution: vi
        .fn<BatchcraftApi["getExecution"]>()
        .mockResolvedValueOnce(execution("running", "run-running"))
        .mockImplementationOnce(() => nextPoll.promise),
      getResults: vi.fn(async () => ({ run_id: "run-running", results: [] })),
    });
    render(<App api={api} pollIntervalMs={5} />);

    expect(await screen.findByRole("heading", { name: "Run 11" })).toBeInTheDocument();
    expect(screen.getByText("Running · Job 1 of 2")).toBeInTheDocument();
    expect(api.getRun).toHaveBeenCalledWith("run-running", expect.any(AbortSignal));
    await waitFor(() => expect(api.getExecution).toHaveBeenCalledTimes(2));
    expect(api.startRun).not.toHaveBeenCalled();
    nextPoll.resolve(execution("succeeded", "run-running"));
    expect(await screen.findByText("Succeeded")).toBeInTheDocument();
  });

  it("restores a created Run with Start available and does not start automatically", async () => {
    seedWorkingSession("run-created");
    const api = makeApi({
      getRun: vi.fn(async () => runLookupResponse("created", "run-created", 12)),
      getExecution: vi.fn(async () => execution("created", "run-created")),
      getResults: vi.fn(async () => ({ run_id: "run-created", results: [] })),
    });
    render(<App api={api} />);

    expect(await screen.findByRole("heading", { name: "Run 12" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Run" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Discard Run" })).toBeEnabled();
    expect(api.startRun).not.toHaveBeenCalled();
  });

  it("restores a cancelled Run as terminal, not startable, and not creation-blocking", async () => {
    seedWorkingSession("run-cancelled");
    const api = makeApi({
      getRun: vi.fn(async () => runLookupResponse("cancelled", "run-cancelled", 15)),
      getExecution: vi.fn(async () => execution("cancelled", "run-cancelled")),
      getResults: vi.fn(async () => ({ run_id: "run-cancelled", results: [] })),
    });
    render(<App api={api} />);

    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start Run" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard Run" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Active Project" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    expect(await screen.findByRole("button", { name: "Create Another Run" })).toBeEnabled();
  });

  it("restores a succeeded Run and its Results", async () => {
    seedWorkingSession("run-succeeded");
    const artifact = result(1, 1, "image/png", "restored.png", 1024);
    const api = makeApi({
      getRun: vi.fn(async () => runLookupResponse("succeeded", "run-succeeded", 13)),
      getExecution: vi.fn(async () => execution("succeeded", "run-succeeded")),
      getResults: vi.fn(async () => ({ run_id: "run-succeeded", results: [artifact] })),
    });
    render(<App api={api} />);

    expect(await screen.findByRole("heading", { name: "Run 13" })).toBeInTheDocument();
    expect(await screen.findAllByAltText("Result 1 from Job 1: restored.png")).toHaveLength(1);
    expect(await screen.findAllByAltText("Result 1 from Job 1: Run 13 / restored.png")).toHaveLength(1);
    expect(api.getResults).toHaveBeenCalledOnce();
    expect(api.startRun).not.toHaveBeenCalled();
  });

  it("clears a missing restored Run ID and leaves the Batch usable", async () => {
    seedWorkingSession("run-missing");
    const api = makeApi({
      getRun: vi.fn(async () => {
        throw new ApiError("Run was not found", "run_not_found", 404);
      }),
    });
    render(<App api={api} />);

    expect(await screen.findByText(/The previous Run could not be restored/)).toBeInTheDocument();
    await waitFor(() => expect(loadWorkingSession().currentRunId).toBeNull());
    expect(screen.getByRole("button", { name: "Preview Batch" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    expect(await screen.findByRole("button", { name: "Create Run" })).toBeEnabled();
  });

  it("does not attach a restored Run from another Project or Batch", async () => {
    seedWorkingSession("run-mismatch");
    const api = makeApi({
      getRun: vi.fn(async () => ({
        ...runLookupResponse("succeeded", "run-mismatch", 14),
        project_id: "another-project",
      })),
    });
    render(<App api={api} />);

    expect(
      await screen.findByText("The previous Run belongs to another Project or Batch and was not restored."),
    ).toBeInTheDocument();
    await waitFor(() => expect(loadWorkingSession().currentRunId).toBeNull());
    expect(api.getExecution).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Run 14" })).not.toBeInTheDocument();
  });

  it("does not let an old Run Result response replace a newly created Run workspace", async () => {
    const oldResults = deferred<{ run_id: string; results: ResultResponse[] }>();
    const createRun = vi
      .fn<BatchcraftApi["createRun"]>()
      .mockResolvedValueOnce(runResponse("run-a", 7))
      .mockResolvedValueOnce(runResponse("run-b", 8));
    const getResults = vi
      .fn<BatchcraftApi["getResults"]>()
      .mockResolvedValueOnce({ run_id: "run-a", results: [] })
      .mockImplementationOnce(() => oldResults.promise);
    const api = makeApi({
      createRun,
      getExecution: vi.fn(async (runId: string) => execution("succeeded", runId)),
      getResults,
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();
    await screen.findByText("Succeeded");
    fireEvent.click(screen.getByRole("button", { name: "Refresh Results" }));
    await waitFor(() => expect(getResults).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Create Another Run" }));
    expect(await screen.findByRole("heading", { name: "Run 8" })).toBeInTheDocument();
    oldResults.resolve({
      run_id: "run-a",
      results: [result(1, 1, "image/png", "old-run.png", 1024)],
    });
    await pause(0);

    expect(screen.queryByAltText("Result 1 from Job 1: old-run.png")).not.toBeInTheDocument();
    expect(within(currentRunSection()).getByText("run-b")).toBeInTheDocument();
  });
});

describe("Results", () => {
  it("renders ordered image-first cards without technical metadata", async () => {
    const artifacts: ResultResponse[] = [
      result(1, 1, "image/png", "first.png", 2048),
      result(1, 2, "application/json", "metadata.json", 512),
      result(2, 1, "image/jpeg", "second.jpg", 4096),
    ];
    const api = makeApi({
      previewBatch: vi.fn(async () => previewResponse()),
      getExecution: vi.fn(async () => execution("succeeded")),
      getResults: vi.fn(async () => ({ run_id: "run-123", results: artifacts })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    const currentResults = screen.getByRole("heading", { name: "Results" }).closest("section");
    expect(currentResults).not.toBeNull();
    const scope = within(currentResults as HTMLElement);

    const firstImage = await scope.findByAltText("Result 1 from Job 1: first.png");
    expect(firstImage).toHaveAttribute("src", "http://api.test/api/result/1/1");
    expect(firstImage).toHaveClass("result-image");
    expect(firstImage.closest(".result-preview-frame")).not.toBeInTheDocument();
    expect(firstImage.closest("button.result-image-button")).not.toBeNull();

    // No visible technical metadata: filename, node, output, type, size.
    expect(scope.queryByText("first.png")).not.toBeInTheDocument();
    expect(scope.queryByText("metadata.json")).not.toBeInTheDocument();
    expect(scope.queryByText("512 B")).not.toBeInTheDocument();
    expect(scope.queryByText("41")).not.toBeInTheDocument();
    expect(scope.queryByText(/Node/i)).not.toBeInTheDocument();
    expect(scope.queryByText(/Output/i)).not.toBeInTheDocument();

    // Compact labels only; artifact label appears for the multi-artifact Job.
    expect(scope.getByText("Job 002")).toBeInTheDocument();
    const nonImage = scope.getByRole("link", { name: /JSON\s*Open artifact/ });
    expect(nonImage).toHaveAttribute("href", "http://api.test/api/result/1/2");
    expect(scope.getByText("Job 001 #1")).toBeInTheDocument();
    expect(scope.getByText("Job 001 #2")).toBeInTheDocument();

    const cards = currentResults?.querySelectorAll(".result-card") ?? [];
    expect(cards).toHaveLength(3);
  });

  it("can refresh Results after a terminal fetch failure", async () => {
    const artifact = result(1, 1, "image/png", "recovered.png", 1024);
    const api = makeApi({
      previewBatch: vi.fn(async () => previewResponse()),
      getExecution: vi.fn(async () => execution("succeeded")),
      getResults: vi
        .fn<BatchcraftApi["getResults"]>()
        .mockRejectedValueOnce(new ApiError("Result index unavailable", "invalid_run_data", 500))
        .mockResolvedValueOnce({ run_id: "run-123", results: [artifact] }),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    expect(await screen.findByText("Results: Result index unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh Results" }));

    expect(await screen.findByAltText("Result 1 from Job 1: recovered.png")).toBeInTheDocument();
    expect(screen.queryByText("Results: Result index unavailable")).not.toBeInTheDocument();
  });
});

describe("Result lightbox", () => {
  function completedRunApi(apiOverrides: Partial<BatchcraftApi> = {}) {
    return makeApi({
      previewBatch: vi.fn(async () => previewResponse()),
      getExecution: vi.fn(async () => execution("succeeded")),
      ...apiOverrides,
    });
  }

  const threeImages: ResultResponse[] = [
    result(1, 1, "image/png", "first.png", 100),
    result(2, 1, "image/jpeg", "second.jpg", 100),
    result(3, 1, "image/png", "third.png", 100),
  ];

  async function openFirstImage() {
    const image = await screen.findByAltText("Result 1 from Job 1: first.png");
    fireEvent.click(image.closest("button") as HTMLElement);
    return await screen.findByRole("dialog", { name: "Result image preview" });
  }

  it("opens on image click and closes via the explicit Close control", async () => {
    const frozen = runLookupResponse();
    frozen.plan.jobs[0].resolved_parameters = [{ parameter_key: "enabled", label: "Enabled", value: false }];
    const api = completedRunApi({
      getResults: vi.fn(async () => ({ run_id: "run-123", results: threeImages })),
      getRun: vi.fn(async () => frozen),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    const lightbox = await openFirstImage();
    expect(within(lightbox).getByText("1 of 3")).toBeInTheDocument();
    expect(within(lightbox).getByText("Job 001")).toBeInTheDocument();

    fireEvent.click(within(lightbox).getByRole("button", { name: "ⓘ Details" }));
    const details = await screen.findByRole("dialog", { name: "Job 001 · Artifact 1" });
    expect(within(details).getByText("A studio portrait of cat.", { exact: false })).toBeInTheDocument();
    expect(within(details).getByText("Enabled")).toBeInTheDocument();
    expect(within(details).getByText("false")).toBeInTheDocument();
    expect(within(details).queryByText("enabled")).not.toBeInTheDocument();
    fireEvent.click(within(details).getByRole("button", { name: "Close" }));
    expect(screen.getByRole("dialog", { name: "Result image preview" })).toBeInTheDocument();

    fireEvent.click(within(lightbox).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Result image preview" })).not.toBeInTheDocument();
  });

  it("closes with Escape", async () => {
    const api = completedRunApi({
      getResults: vi.fn(async () => ({ run_id: "run-123", results: threeImages })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    const lightbox = await openFirstImage();
    fireEvent.keyDown(lightbox, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Result image preview" })).not.toBeInTheDocument();
  });

  it("navigates deterministically with Previous/Next and disables unavailable directions", async () => {
    const api = completedRunApi({
      getResults: vi.fn(async () => ({ run_id: "run-123", results: threeImages })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    const image = await screen.findByAltText("Result 1 from Job 1: first.png");
    fireEvent.click(image.closest("button") as HTMLElement);
    const lightbox = await screen.findByRole("dialog", { name: "Result image preview" });

    // First item: Previous disabled, no wrap-around.
    expect(within(lightbox).getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(within(lightbox).getByRole("button", { name: "Next" })).toBeEnabled();
    fireEvent.click(within(lightbox).getByRole("button", { name: "Previous" }));
    expect(within(lightbox).getByText("1 of 3")).toBeInTheDocument();

    fireEvent.click(within(lightbox).getByRole("button", { name: "Next" }));
    expect(within(lightbox).getByText("2 of 3")).toBeInTheDocument();
    fireEvent.click(within(lightbox).getByRole("button", { name: "Next" }));
    expect(within(lightbox).getByText("3 of 3")).toBeInTheDocument();

    // Last item: Next disabled, no wrap-around.
    expect(within(lightbox).getByRole("button", { name: "Next" })).toBeDisabled();
    expect(within(lightbox).getByRole("button", { name: "Previous" })).toBeEnabled();
    fireEvent.click(within(lightbox).getByRole("button", { name: "Next" }));
    expect(within(lightbox).getByText("3 of 3")).toBeInTheDocument();
  });

  it("navigates with keyboard arrows", async () => {
    const api = completedRunApi({
      getResults: vi.fn(async () => ({ run_id: "run-123", results: threeImages })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    const lightbox = await openFirstImage();
    fireEvent.keyDown(lightbox, { key: "ArrowRight" });
    expect(within(lightbox).getByText("2 of 3")).toBeInTheDocument();
    fireEvent.keyDown(lightbox, { key: "ArrowLeft" });
    expect(within(lightbox).getByText("1 of 3")).toBeInTheDocument();
    // ArrowLeft at the first item does not wrap.
    fireEvent.keyDown(lightbox, { key: "ArrowLeft" });
    expect(within(lightbox).getByText("1 of 3")).toBeInTheDocument();
  });

  it("works identically inside the accumulated Batch Results gallery", async () => {
    const api = makeApi({
      previewBatch: vi.fn(async () => previewResponse()),
      getExecution: vi.fn(async () => execution("succeeded")),
      getResults: vi.fn(async () => ({ run_id: "run-123", results: threeImages })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    const gallery = batchResultsSection();
    const image = await within(gallery).findByAltText("Result 1 from Job 1: Run 7 / first.png");
    fireEvent.click(image.closest("button") as HTMLElement);

    const lightbox = await screen.findByRole("dialog", { name: "Result image preview" });
    expect(within(lightbox).getByText("1 of 3")).toBeInTheDocument();
    fireEvent.keyDown(lightbox, { key: "ArrowRight" });
    expect(within(lightbox).getByText("2 of 3")).toBeInTheDocument();
  });

  it("keeps the gallery usable when one image fails to load", async () => {
    const api = completedRunApi({
      getResults: vi.fn(async () => ({
        run_id: "run-123",
        results: [result(1, 1, "image/png", "broken.png", 100), result(2, 1, "image/png", "ok.png", 100)],
      })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    const broken = await screen.findByAltText("Result 1 from Job 1: broken.png");
    fireEvent.error(broken);
    const failedSlot = await screen.findByText("Image unavailable");
    expect(failedSlot).toBeInTheDocument();

    const okImage = screen.getByAltText("Result 1 from Job 2: ok.png");
    const button = okImage.closest("button");
    expect((button as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(button as HTMLElement);
    const lightbox = await screen.findByRole("dialog", { name: "Result image preview" });
    // The failed image is excluded from navigation.
    expect(within(lightbox).getByText("1 of 1")).toBeInTheDocument();
  });

  it("renders images without any cropping wrapper structure", async () => {
    const api = completedRunApi({
      getResults: vi.fn(async () => ({ run_id: "run-123", results: threeImages })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    const image = await screen.findByAltText("Result 1 from Job 1: first.png");
    const button = image.closest("button.result-image-button");
    expect(button).not.toBeNull();
    // The image is a direct child of the button: no aspect-ratio frame or
    // overflow container between the button and the image.
    expect(image.parentElement).toBe(button);
    expect(image.closest(".result-preview-frame")).not.toBeInTheDocument();
    expect(image.closest(".asset-preview-frame")).not.toBeInTheDocument();
  });
});

describe("Result Details", () => {
  function frozenProvenanceRun(runId = "run-123", runNumber = 7) {
    const frozen = runLookupResponse("succeeded", runId, runNumber);
    frozen.batch_snapshot.prompt_versions[0].version_number = 3;
    frozen.plan.jobs[0] = {
      ...frozen.plan.jobs[0],
      resolved_prompt: "A studio portrait of a cat in cinematic light.",
      resolved_variables: [
        { name: "subject", value: "cat" },
        { name: "style", value: "cinematic" },
      ],
      seed: 38192831,
      resolved_image_inputs: [
        { slot_key: "style", label: "Style image", asset_id: "ref-02", filename: "ref-02.png" },
        { slot_key: "pose", label: "Pose image", asset_id: null, filename: null },
      ],
    };
    frozen.plan.jobs[1] = {
      ...frozen.plan.jobs[1],
      resolved_prompt: "A studio portrait of a dog in natural light.",
      resolved_variables: [
        { name: "subject", value: "dog" },
        { name: "style", value: "natural" },
      ],
      seed: 992211,
      resolved_image_inputs: [
        { slot_key: "style", label: "Style image", asset_id: "ref-03", filename: "ref-03.png" },
        { slot_key: "pose", label: "Pose image", asset_id: null, filename: null },
      ],
    };
    return frozen;
  }

  it("opens the correct Result with frozen generation provenance and secondary technical metadata", async () => {
    const frozen = frozenProvenanceRun();
    const getRun = vi.fn(async () => frozen);
    const artifacts = [
      result(2, 1, "image/png", "dog.png", 4096),
      result(1, 1, "image/png", "cat.png", 2048),
    ];
    const api = makeApi({
      getRun,
      getExecution: vi.fn(async () => execution("succeeded")),
      getResults: vi.fn(async () => ({ run_id: "run-123", results: artifacts })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    const results = currentResultsSection();
    fireEvent.click(await within(results).findByRole("button", { name: "Details for Job 1, artifact 1" }));

    const dialog = await screen.findByRole("dialog", { name: "Job 001 · Artifact 1" });
    expect(within(dialog).getByText("Portrait · v3")).toBeInTheDocument();
    expect(within(dialog).getByText("A studio portrait of a cat in cinematic light.", { exact: false }))
      .toBeInTheDocument();
    expect(within(dialog).getByText("subject")).toBeInTheDocument();
    expect(within(dialog).getByText("cat")).toBeInTheDocument();
    expect(within(dialog).getByText("style")).toBeInTheDocument();
    expect(within(dialog).getByText("cinematic")).toBeInTheDocument();
    expect(within(dialog).getByText("38192831")).toBeInTheDocument();
    expect(within(dialog).getByText("ref-02.png")).toBeInTheDocument();
    expect(within(dialog).getByText("KREA2 Outfit · v4")).toBeInTheDocument();
    expect(within(dialog).getByText("General · v4")).toBeInTheDocument();

    const technical = within(dialog).getByText("Technical details").closest("details");
    expect(technical).not.toHaveAttribute("open");
    expect(within(technical as HTMLElement).getByText("cat.png")).toBeInTheDocument();
    expect(within(technical as HTMLElement).getByText("2.0 KB")).toBeInTheDocument();
    expect(within(technical as HTMLElement).getByText("abc123")).toBeInTheDocument();

    // Run creation already loaded and cached the frozen Run Plan.
    expect(getRun).toHaveBeenCalledTimes(1);
  });

  it("shows Base workflow for a frozen named slot", async () => {
    const frozen = frozenProvenanceRun();
    frozen.plan.jobs[0].resolved_image_inputs = [
      { slot_key: "source", label: "Source image", asset_id: null, filename: null },
    ];
    const api = makeApi({
      getRun: vi.fn(async () => frozen),
      getExecution: vi.fn(async () => execution("succeeded")),
      getResults: vi.fn(async () => ({
        run_id: "run-123",
        results: [result(1, 1, "image/png", "base.png", 100)],
      })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    fireEvent.click(await within(currentResultsSection()).findByRole("button", {
      name: "Details for Job 1, artifact 1",
    }));
    const dialog = await screen.findByRole("dialog", { name: "Job 001 · Artifact 1" });
    expect(within(dialog).getByText("Base workflow")).toBeInTheDocument();
  });

  it("renders a Parameter label and exact value without concatenating its technical key", async () => {
    const frozen = frozenProvenanceRun();
    frozen.plan.jobs[0].resolved_parameters = [
      { parameter_key: "cfg_internal", label: "Guidance", value: null },
      { parameter_key: "caption_internal", label: "Caption", value: "" },
    ];
    const api = makeApi({
      getRun: vi.fn(async () => frozen),
      getExecution: vi.fn(async () => execution("succeeded")),
      getResults: vi.fn(async () => ({
        run_id: "run-123",
        results: [result(1, 1, "image/png", "parameters.png", 100)],
      })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    fireEvent.click(await within(currentResultsSection()).findByRole("button", {
      name: "Details for Job 1, artifact 1",
    }));
    const dialog = await screen.findByRole("dialog", { name: "Job 001 · Artifact 1" });
    expect(within(dialog).getByText("Guidance").nextElementSibling).toHaveTextContent(/^Base workflow$/);
    expect(within(dialog).getByText("Caption").nextElementSibling).toHaveTextContent(/^"" \(empty string\)$/);
    expect(dialog).not.toHaveTextContent("cfg_internal");
    expect(dialog).not.toHaveTextContent("caption_internal");
  });

  it("uses the Job ordinal and preserves artifact-specific technical metadata", async () => {
    const frozen = frozenProvenanceRun();
    const api = makeApi({
      getRun: vi.fn(async () => frozen),
      getExecution: vi.fn(async () => execution("succeeded")),
      getResults: vi.fn(async () => ({
        run_id: "run-123",
        results: [
          result(1, 1, "image/png", "cat-primary.png", 100),
          result(1, 2, "image/png", "cat-mask.png", 200),
          result(2, 1, "image/png", "dog.png", 300),
        ],
      })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();
    const results = currentResultsSection();

    fireEvent.click(await within(results).findByRole("button", { name: "Details for Job 1, artifact 2" }));
    let dialog = await screen.findByRole("dialog", { name: "Job 001 · Artifact 2" });
    expect(within(dialog).getByText("A studio portrait of a cat in cinematic light.", { exact: false }))
      .toBeInTheDocument();
    expect(within(dialog).getByText("cat-mask.png")).toBeInTheDocument();
    expect(within(dialog).getByText("200 B")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    fireEvent.click(within(results).getByRole("button", { name: "Details for Job 2, artifact 1" }));
    dialog = await screen.findByRole("dialog", { name: "Job 002 · Artifact 1" });
    expect(within(dialog).getByText("A studio portrait of a dog in natural light.", { exact: false }))
      .toBeInTheDocument();
    expect(within(dialog).getByText("992211")).toBeInTheDocument();
    expect(within(dialog).queryByText("cat-mask.png")).not.toBeInTheDocument();
  });

  it("uses the correct cached frozen Run for Batch Results", async () => {
    const form = populatedBatchForm();
    form.imageBindings = [{ slot_key: "source", values: ["asset-1"] }];
    saveWorkingSession(form, null, ["run-a", "run-b"]);
    const runA = frozenProvenanceRun("run-a", 10);
    runA.plan.jobs[0].resolved_prompt = "Frozen prompt from Run A";
    const runB = frozenProvenanceRun("run-b", 11);
    runB.plan.jobs[0].resolved_prompt = "Frozen prompt from Run B";
    const getRun = vi.fn(async (runId: string) => runId === "run-a" ? runA : runB);
    const api = makeApi({
      getRun,
      getExecution: vi.fn(async (runId: string) => execution("succeeded", runId)),
      getResults: vi.fn(async (runId: string) => ({
        run_id: runId,
        results: [result(1, 1, "image/png", `${runId}.png`, 100)],
      })),
    });
    render(<App api={api} />);

    const runBRegion = await screen.findByRole("region", { name: "Run 11" });
    fireEvent.click(within(runBRegion).getByRole("button", { name: "Details for Job 1, artifact 1" }));
    let dialog = await screen.findByRole("dialog", { name: "Job 001 · Artifact 1" });
    expect(within(dialog).getByText("Frozen prompt from Run B", { exact: false })).toBeInTheDocument();
    expect(within(dialog).queryByText("Frozen prompt from Run A", { exact: false })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    fireEvent.click(within(runBRegion).getByRole("button", { name: "Details for Job 1, artifact 1" }));
    dialog = await screen.findByRole("dialog", { name: "Job 001 · Artifact 1" });
    expect(within(dialog).getByText("Frozen prompt from Run B", { exact: false })).toBeInTheDocument();
    expect(getRun).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed provenance load retryable inside Details", async () => {
    const frozen = frozenProvenanceRun();
    const getRun = vi
      .fn<BatchcraftApi["getRun"]>()
      .mockRejectedValueOnce(new ApiError("creation lookup failed", "network_error", 503))
      .mockRejectedValueOnce(new ApiError("details lookup failed", "network_error", 503))
      .mockResolvedValueOnce(frozen);
    const api = makeApi({
      getRun,
      getExecution: vi.fn(async () => execution("succeeded")),
      getResults: vi.fn(async () => ({
        run_id: "run-123",
        results: [result(1, 1, "image/png", "retry.png", 100)],
      })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();

    fireEvent.click(await within(currentResultsSection()).findByRole("button", {
      name: "Details for Job 1, artifact 1",
    }));
    const dialog = await screen.findByRole("dialog", { name: "Job 001 · Artifact 1" });
    expect(await within(dialog).findByText(/details lookup failed/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(await within(dialog).findByText("Portrait · v3")).toBeInTheDocument();
    expect(getRun).toHaveBeenCalledTimes(3);
  });

  it("does not let a stale Details request overwrite a newly selected Result", async () => {
    const frozen = frozenProvenanceRun();
    const pending = deferred<RunResponse>();
    const getRun = vi
      .fn<BatchcraftApi["getRun"]>()
      .mockRejectedValueOnce(new ApiError("creation lookup failed", "network_error", 503))
      .mockImplementationOnce(() => pending.promise);
    const api = makeApi({
      getRun,
      getExecution: vi.fn(async () => execution("succeeded")),
      getResults: vi.fn(async () => ({
        run_id: "run-123",
        results: [
          result(1, 1, "image/png", "cat.png", 100),
          result(2, 1, "image/png", "dog.png", 100),
        ],
      })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();
    const results = currentResultsSection();

    fireEvent.click(await within(results).findByRole("button", { name: "Details for Job 1, artifact 1" }));
    let dialog = await screen.findByRole("dialog", { name: "Job 001 · Artifact 1" });
    expect(within(dialog).getByText("Loading frozen Run provenance...")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    fireEvent.click(within(results).getByRole("button", { name: "Details for Job 2, artifact 1" }));
    dialog = await screen.findByRole("dialog", { name: "Job 002 · Artifact 1" });

    pending.resolve(frozen);
    expect(await within(dialog).findByText("A studio portrait of a dog in natural light.", { exact: false }))
      .toBeInTheDocument();
    expect(within(dialog).queryByText("A studio portrait of a cat in cinematic light.", { exact: false }))
      .not.toBeInTheDocument();
    expect(getRun).toHaveBeenCalledTimes(2);
  });
});

describe("Batch working-session Results gallery", () => {
  it("accumulates ordered Results from multiple Runs without replacing older Results", async () => {
    const createRun = vi
      .fn<BatchcraftApi["createRun"]>()
      .mockResolvedValueOnce(runResponse("run-a", 10))
      .mockResolvedValueOnce(runResponse("run-b", 11));
    const resultsByRun: Record<string, ResultResponse[]> = {
      "run-a": [
        result(1, 1, "image/png", "a1.png", 100),
        result(2, 1, "image/png", "a2.png", 100),
      ],
      "run-b": [
        result(1, 1, "image/png", "b1.png", 100),
        result(1, 2, "application/json", "b2.json", 100),
      ],
    };
    const api = makeApi({
      createRun,
      getExecution: vi.fn(async (runId: string) => execution("succeeded", runId)),
      getResults: vi.fn(async (runId: string) => ({ run_id: runId, results: resultsByRun[runId] ?? [] })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await reachPreview();
    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));
    await screen.findByRole("heading", { name: "Run 10" });
    fireEvent.click(screen.getByRole("button", { name: "Start Run" }));
    const gallery = batchResultsSection();
    expect(await within(gallery).findByAltText("Result 1 from Job 1: Run 10 / a1.png")).toBeInTheDocument();
    expect(within(gallery).getByAltText("Result 1 from Job 2: Run 10 / a2.png")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create Another Run" }));
    await screen.findByRole("heading", { name: "Run 11" });
    expect(within(gallery).getByAltText("Result 1 from Job 1: Run 10 / a1.png")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start Run" }));

    expect(await within(gallery).findByAltText("Result 1 from Job 1: Run 11 / b1.png")).toBeInTheDocument();
    const images = [...gallery.querySelectorAll("img.result-image")].map((item) =>
      item.getAttribute("alt"),
    );
    expect(images).toEqual([
      "Result 1 from Job 1: Run 10 / a1.png",
      "Result 1 from Job 2: Run 10 / a2.png",
      "Result 1 from Job 1: Run 11 / b1.png",
    ]);
    expect(loadWorkingSession().sessionRunIds).toEqual(["run-a", "run-b"]);
  });

  it("restores multiple session Runs once without executing or duplicating the current Run", async () => {
    const form = populatedBatchForm();
    form.imageBindings = [{ slot_key: "source", values: ["asset-1"] }];
    saveWorkingSession(form, "run-b", ["run-a", "run-b", "run-b"]);
    const api = makeApi({
      getRun: vi.fn(async (runId: string) =>
        runLookupResponse("succeeded", runId, runId === "run-a" ? 10 : 11),
      ),
      getExecution: vi.fn(async (runId: string) => execution("succeeded", runId)),
      getResults: vi.fn(async (runId: string) => ({
        run_id: runId,
        results: [result(1, 1, "image/png", `${runId}.png`, 100)],
      })),
    });
    render(<App api={api} />);

    const gallery = batchResultsSection();
    expect(await within(gallery).findByAltText("Result 1 from Job 1: Run 10 / run-a.png")).toBeInTheDocument();
    expect(await within(gallery).findByAltText("Result 1 from Job 1: Run 11 / run-b.png")).toBeInTheDocument();
    expect(within(gallery).getAllByRole("region")).toHaveLength(2);
    expect(api.getRun).toHaveBeenCalledTimes(2);
    expect(api.getResults).toHaveBeenCalledTimes(2);
    expect(api.startRun).not.toHaveBeenCalled();
  });

  it("resets accumulated Results when the stable Batch identity changes", async () => {
    const artifact = result(1, 1, "image/png", "old-batch.png", 100);
    const api = makeApi({
      getExecution: vi.fn(async () => execution("succeeded")),
      getResults: vi.fn(async () => ({ run_id: "run-123", results: [artifact] })),
      listSavedBatches: vi.fn(async () => ({
        batches: [
          {
            id: "batch-1",
            project_id: "project-1",
            filesystem_key: "batch_1",
            name: "First experiment",
            revision: 1,
            updated_at: "2026-08-27T12:00:00Z",
            archived_at: null,
          },
          {
            id: "batch-2",
            project_id: "project-1",
            filesystem_key: "batch_2",
            name: "Other experiment",
            revision: 1,
            updated_at: "2026-08-27T12:00:00Z",
            archived_at: null,
          },
        ],
      })),
      getSavedBatch: vi.fn(async () => ({
        id: "batch-2",
        project_id: "project-1",
        filesystem_key: "batch_2",
        name: "Other experiment",
        description: null,
        revision: 1,
        seed_mode: "fixed" as const,
        seed_values: [1],
        random_seed_count: null,
        selected_workflow_version_id: null,
        selected_workflow_profile_id: null,
        selected_workflow_profile_version_id: null,
        created_at: "2026-08-27T12:00:00Z",
        updated_at: "2026-08-27T12:00:00Z",
        archived_at: null,
        prompt_selections: [],
        variable_bindings: [],
        image_bindings: [],
        parameter_bindings: [],
        selected_workflow_version: null,
        selected_workflow_profile_name: null,
        selected_workflow_profile_archived_at: null,
        selected_workflow_profile_version: null,
      })),
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();
    const gallery = batchResultsSection();
    expect(await within(gallery).findByAltText("Result 1 from Job 1: Run 7 / old-batch.png")).toBeInTheDocument();

    fireEvent.change(await screen.findByRole("combobox", { name: "Saved Batch" }), {
      target: { value: "batch-2" },
    });
    await screen.findByRole("dialog", { name: "Switch Batch?" });
    fireEvent.click(screen.getByRole("button", { name: "Discard and switch" }));
    await waitFor(() => expect(loadWorkingSession().sessionRunIds).toEqual([]));

    expect(within(gallery).queryByAltText("Result 1 from Job 1: Run 7 / old-batch.png")).not.toBeInTheDocument();
    expect(within(gallery).getByText("No session Results yet")).toBeInTheDocument();
  });

  it("keeps healthy historical Results when another session Run is unavailable", async () => {
    const form = populatedBatchForm();
    form.imageBindings = [{ slot_key: "source", values: ["asset-1"] }];
    saveWorkingSession(form, null, ["run-bad", "run-good"]);
    const api = makeApi({
      getRun: vi.fn(async (runId: string) => {
        if (runId === "run-bad") {
          throw new ApiError("Run data is invalid", "invalid_run_data", 500);
        }
        return runLookupResponse("succeeded", runId, 22);
      }),
      getResults: vi.fn(async (runId: string) => ({
        run_id: runId,
        results: [result(1, 1, "image/png", "healthy.png", 100)],
      })),
    });
    render(<App api={api} />);

    const gallery = batchResultsSection();
    expect(await within(gallery).findByAltText("Result 1 from Job 1: Run 22 / healthy.png")).toBeInTheDocument();
    expect(within(gallery).getByText("Unavailable: Run data is invalid")).toBeInTheDocument();
    expect(api.getRun).toHaveBeenCalledTimes(2);
  });
});

function makeApi(
  overrides: Partial<BatchcraftApi & RunDiscardApi> = {},
): BatchcraftApi & RunDiscardApi {
  const prompt = {
    id: "prompt-1",
    project_id: "project-1",
    name: "Portrait",
    description: null,
    created_at: "2026-08-27T12:00:00Z",
    updated_at: "2026-08-27T12:00:00Z",
    archived_at: null,
  };
  const version = {
    id: "prompt-v1",
    prompt_id: "prompt-1",
    version_number: 1,
    name_snapshot: "Portrait",
    text: "A studio portrait of {{subject}}.",
    note: null,
    created_at: "2026-08-27T12:00:00Z",
    archived_at: null,
  };
  return {
    getComfyUIStatus: vi.fn(async () => ({
      reachable: true,
      version: "0.31.0",
      devices: ["Test GPU"],
      diagnostic: null,
    })),
    listProjects: vi.fn(async () => ({ projects: [projectResponse()] })),
    createProject: vi.fn(async () => projectResponse()),
    getProject: vi.fn(async () => projectResponse()),
    updateProject: vi.fn(async () => projectResponse()),
    adoptProject: vi.fn(async () => projectResponse()),
    listAdoptableProjects: vi.fn(async () => ({ projects: [] })),
    listSavedBatches: vi.fn(async () => ({ batches: [] })),
    createSavedBatch: vi.fn(),
    getSavedBatch: vi.fn(async () => { throw new ApiError("Saved Batch was not found", "saved_batch_not_found", 404); }),
    updateSavedBatch: vi.fn(),
    archiveSavedBatch: vi.fn(),
    listAdoptableSavedBatches: vi.fn(async () => ({ batches: [] })),
    adoptSavedBatch: vi.fn(),
    listProjectAssets: vi.fn(async () => ({ assets: [asset("asset-1", "portrait.png")] })),
    uploadProjectAssets: vi.fn(async () => ({ assets: [] })),
    listPrompts: vi.fn(async () => ({
      prompts: [{ ...prompt, latest_active_version: version }],
    })),
    createPrompt: vi.fn(async () => ({ prompt, version })),
    getPrompt: vi.fn(async () => prompt),
    updatePrompt: vi.fn(async () => prompt),
    listPromptVersions: vi.fn(async () => ({ prompt_versions: [version] })),
    createPromptVersion: vi.fn(async () => version),
    getPromptVersion: vi.fn(async () => version),
    listWorkflows: vi.fn(async () => ({ workflows: [] })),
    createWorkflow: vi.fn(),
    getWorkflow: vi.fn(),
    updateWorkflow: vi.fn(),
    archiveWorkflow: vi.fn(),
    listWorkflowVersions: vi.fn(async () => ({ workflow_versions: [] })),
    createWorkflowVersion: vi.fn(),
    getWorkflowVersion: vi.fn(),
    archiveWorkflowVersion: vi.fn(),
    listWorkflowProfiles: vi.fn(async () => ({ workflow_profiles: [] })),
    createWorkflowProfile: vi.fn(),
    getWorkflowProfile: vi.fn(),
    updateWorkflowProfile: vi.fn(),
    archiveWorkflowProfile: vi.fn(),
    listWorkflowProfileVersions: vi.fn(async () => ({ workflow_profile_versions: [] })),
    createWorkflowProfileVersion: vi.fn(),
    getWorkflowProfileVersion: vi.fn(),
    archiveWorkflowProfileVersion: vi.fn(),
    previewBatch: vi.fn(async () => previewResponse()),
    createRun: vi.fn(async () => runResponse()),
    getRun: vi.fn(async () => runLookupResponse()),
    startRun: vi.fn(async (runId: string) => ({ run_id: runId, status: "accepted" })),
    discardRun: vi.fn(async (runId: string) => execution("cancelled", runId)),
    getExecution: vi.fn(async () => execution("succeeded")),
    getResults: vi.fn(async () => ({ run_id: "run-123", results: [] })),
    resultUrl: (url: string) => `http://api.test${url}`,
    assetUrl: (url: string) => `http://api.test${url}`,
    ...overrides,
  };
}

function previewResponse(jobCount = 2, imageAssetId: string | null = "asset-1"): PreviewResponse {
  const subjects = ["cat", "dog", "bird"];
  return {
    job_count: jobCount,
    warnings: [
      { code: "unused_binding", message: "Unused binding variable", placeholder: "unused" },
    ],
    jobs: Array.from({ length: jobCount }, (_, index) => {
      const subject = subjects[index] ?? `subject-${index + 1}`;
      return {
        ordinal: index + 1,
        prompt_version_id: "prompt-v1",
        prompt_version_name: "Portrait",
        resolved_prompt: `A studio portrait of ${subject}.`,
        resolved_variables: [{ name: "subject", value: subject }],
        resolved_image_inputs: [{
          slot_key: "source",
          label: "Source image",
          asset_id: imageAssetId,
          filename: imageAssetId ? "portrait.png" : null,
        }],
        resolved_parameters: [],
        seed: 1,
      };
    }),
  };
}

function runResponse(
  runId = "run-123",
  runNumber = 7,
  jobCount = 2,
): RunCreatedResponse {
  return {
    run_id: runId,
    run_number: runNumber,
    project_id: "project-1",
    project_name: "My Project",
    batch_id: "batch-1",
    batch_name: "First experiment",
    job_count: jobCount,
    durable_status: "created",
  };
}

function runLookupResponse(
  status: ExecutionResponse["status"] = "succeeded",
  runId = "run-123",
  runNumber = 7,
): RunResponse {
  return {
    ...runResponse(runId, runNumber),
    created_at: "2026-08-27T12:00:00Z",
    prompt_versions: [
      { id: "prompt-v1", name: "Portrait", text: "A studio portrait of {{subject}}." },
    ],
    jobs: [
      { ordinal: 1, prompt_version_id: "prompt-v1" },
      { ordinal: 2, prompt_version_id: "prompt-v1" },
    ],
    plan: {
      job_count: 2,
      warnings: [
        { code: "unused_binding", message: "Unused binding variable", placeholder: "unused" },
      ],
      jobs: previewResponse().jobs,
    },
    batch_snapshot: {
      snapshot_version: 4,
      project: { id: "project-1", filesystem_key: "project_1", name: "My Project" },
      source_saved_batch: { id: "batch-1", revision: 3 },
      batch: {
        id: "batch-1",
        filesystem_key: "batch_1",
        name: "First experiment",
        description: "Frozen Batch description",
      },
      prompt_versions: [
        {
          id: "prompt-v1",
          prompt_id: "prompt-1",
          version_number: 1,
          name: "Portrait",
          text: "A studio portrait of {{subject}}.",
        },
      ],
      variable_bindings: [
        {
          placeholder: "subject",
          values: ["cat", "dog"],
        },
      ],
      image_bindings: [{ slot_key: "source", values: ["asset-1"] }],
      parameter_bindings: [],
      seed_intent: { mode: "fixed", values: [1], random_seed_count: null },
      workflow_selection: {
        workflow_id: "workflow-1",
        workflow_version_id: "workflow-v4",
        workflow_name: "KREA2 Outfit",
        workflow_version_number: 4,
        workflow_profile_id: "profile-1",
        workflow_profile_version_id: "profile-v4",
        workflow_profile_name: "General",
        workflow_profile_version_number: 4,
        workflow: {},
        workflow_profile: JSON.parse(profileJson([
          { key: "source", label: "Source image", node_id: "1", input_name: "image" },
        ])),
      },
    },
    execution: execution(status, runId),
  };
}

function execution(status: ExecutionResponse["status"], runId = "run-123"): ExecutionResponse {
  if (status === "created" || status === "cancelled") {
    return {
      run_id: runId,
      status,
      started_at: null,
      completed_at: status === "cancelled" ? "2026-08-27T12:01:00Z" : null,
      current_job_ordinal: null,
      error: null,
      diagnostics: status === "cancelled" ? ["discarded_before_start"] : [],
      jobs: [1, 2].map((ordinal) => ({
        ordinal,
        status: "pending",
        prompt_id: null,
        started_at: null,
        completed_at: null,
        error: null,
        diagnostics: [],
        result_count: 0,
      })),
    };
  }
  const terminal = status === "succeeded" || status === "failed" || status === "blocked";
  return {
    run_id: runId,
    status,
    started_at: "2026-08-27T12:00:00Z",
    completed_at: terminal ? "2026-08-27T12:01:00Z" : null,
    current_job_ordinal: status === "running" ? 1 : null,
    error: status === "failed" ? "generation failed" : status === "blocked" ? "reconciliation required" : null,
    diagnostics: status === "blocked" ? ["submission outcome unknown"] : [],
    jobs: [
      {
        ordinal: 1,
        status: status === "running" ? "submitted" : status,
        prompt_id: "prompt-1",
        started_at: "2026-08-27T12:00:00Z",
        completed_at: terminal ? "2026-08-27T12:01:00Z" : null,
        error: status === "failed" ? "generation failed" : null,
        diagnostics: status === "blocked" ? ["submission outcome unknown"] : [],
        result_count: status === "succeeded" ? 2 : 0,
      },
      {
        ordinal: 2,
        status: status === "succeeded" ? "succeeded" : "pending",
        prompt_id: status === "succeeded" ? "prompt-2" : null,
        started_at: null,
        completed_at: terminal ? "2026-08-27T12:01:00Z" : null,
        error: null,
        diagnostics: [],
        result_count: status === "succeeded" ? 1 : 0,
      },
    ],
  };
}

function result(
  jobOrdinal: number,
  artifactOrdinal: number,
  contentType: string,
  filename: string,
  byteSize: number,
): ResultResponse {
  return {
    job_ordinal: jobOrdinal,
    artifact_ordinal: artifactOrdinal,
    producing_node_id: "41",
    output_name: "images",
    remote_filename: filename,
    content_type: contentType,
    byte_size: byteSize,
    sha256: "abc123",
    download_url: `/api/result/${jobOrdinal}/${artifactOrdinal}`,
  };
}

function asset(assetId: string, filename: string): AssetResponse {
  return {
    asset_id: assetId,
    original_filename: filename,
    content_type: "image/png",
    byte_size: 2048,
    sha256: `${assetId}-sha256`,
    created_at: "2026-08-27T12:00:00Z",
    content_url: `/api/assets/${assetId}`,
  };
}

function projectResponse(overrides: Partial<ProjectResponse> = {}): ProjectResponse {
  return {
    id: "project-1",
    filesystem_key: "project_1",
    name: "My Project",
    description: null,
    created_at: "2026-08-27T12:00:00Z",
    updated_at: "2026-08-27T12:00:00Z",
    archived_at: null,
    ...overrides,
  };
}

function populatedBatchForm() {
  const form = initialBatchForm();
  const prompt = newPrompt(1);
  form.projectId = "project-1";
  form.projectFilesystemKey = "project_1";
  form.projectName = "My Project";
  prompt.promptName = "Portrait";
  prompt.snapshotName = "Portrait";
  prompt.text = "A studio portrait of {{subject}}.";
  form.prompts = [prompt];
  form.workflowProfileJson = profileJson([
    { key: "source", label: "Source image", node_id: "1", input_name: "image" },
  ]);
  form.imageBindings = [{ slot_key: "source", values: [null] }];
  return form;
}

function profileJson(imageInputs: unknown[]): string {
  return JSON.stringify({ mappings: {}, image_inputs: imageInputs, parameters: [] });
}

function seedWorkingSession(runId: string) {
  const form = populatedBatchForm();
  form.imageBindings = [{ slot_key: "source", values: ["asset-1"] }];
  saveWorkingSession(form, runId, [runId], "project-1");
}

function batchResultsSection(): HTMLElement {
  const section = screen.getByRole("heading", { name: "Batch Results" }).closest("section");
  if (!section) {
    throw new Error("Batch Results section was not rendered");
  }
  return section;
}

function currentResultsSection(): HTMLElement {
  const section = screen.getByRole("heading", { name: "Results" }).closest("section");
  if (!section) {
    throw new Error("Current Results section was not rendered");
  }
  return section;
}

function currentRunSection(): HTMLElement {
  const section = screen.getByRole("heading", { name: /^Run \d+$/ }).closest("section");
  if (!section) {
    throw new Error("Current Run section was not rendered");
  }
  return section;
}

function promptVersion(
  overrides: Partial<LibraryPromptVersion> = {},
): LibraryPromptVersion {
  return {
    id: "prompt-v1",
    prompt_id: "prompt-1",
    version_number: 1,
    name_snapshot: "Portrait",
    text: "A studio portrait of {{subject}}.",
    note: null,
    created_at: "2026-08-27T12:00:00Z",
    archived_at: null,
    ...overrides,
  };
}

function projectPrompt(
  id = "prompt-1",
  name = "Portrait",
  version = promptVersion({ prompt_id: id }),
): ProjectPrompt {
  return {
    id,
    project_id: "project-1",
    name,
    description: null,
    created_at: "2026-08-27T12:00:00Z",
    updated_at: "2026-08-27T12:00:00Z",
    archived_at: null,
    latest_active_version: version,
  };
}

async function addExistingPrompt(name: string) {
  await pause(0);
  await waitFor(() => expect(
    within(screen.getByRole("group", { name: "Prompt Versions" }))
      .queryByText("Loading Prompt library..."),
  ).not.toBeInTheDocument());
  await waitFor(() => {
    if (screen.queryByRole("heading", { name: "Choose an active Prompt" })) return;
    const chooseExisting = screen.queryByRole("button", { name: "Choose existing" });
    if (chooseExisting) {
      fireEvent.click(chooseExisting);
      throw new Error("Waiting for the Prompt list");
    }
    const section = screen.getByRole("group", { name: "Prompt Versions" });
    const add = within(section).queryByRole("button", { name: "Add Prompt" });
    if (add && !add.hasAttribute("disabled")) {
      fireEvent.click(add);
      throw new Error("Waiting for the Add Prompt dialog");
    }
    const edit = within(section).queryByRole("button", { name: "Edit" });
    if (edit) {
      fireEvent.click(edit);
      throw new Error("Waiting for the Prompt editor");
    }
    throw new Error("Prompt section is not ready");
  });
  const dialog = screen.getByRole("dialog", { name: "Add Prompt" });
  const nameNode = within(dialog).getByText(name, { selector: "strong" });
  const card = nameNode.closest(".repeater-card");
  if (!card) throw new Error(`Prompt card was not rendered for ${name}`);
  fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Use latest version" }));
}

async function expandConfiguration(title: string, action = "Edit") {
  const section = screen.getByRole("group", { name: title });
  const button = await within(section).findByRole("button", { name: action });
  if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button);
}

function promptCards(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".prompt-card")];
}

async function enterAsset() {
  fireEvent.click(await screen.findByRole("button", { name: "Add portrait.png to Source image" }));
}

async function reachPreview() {
  await enterAsset();
  fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
  await screen.findByRole("button", { name: "Create Run" });
}

async function createRunAndStart() {
  await reachPreview();
  fireEvent.click(screen.getByRole("button", { name: "Create Run" }));
  await screen.findByRole("heading", { name: "Run 7" });
  fireEvent.click(screen.getByRole("button", { name: "Start Run" }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function pause(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
