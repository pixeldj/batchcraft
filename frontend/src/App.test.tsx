import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import { ApiError, type BatchcraftApi } from "./api/client";
import type {
  AssetResponse,
  ExecutionResponse,
  PreviewResponse,
  ResultResponse,
  RunCreatedResponse,
  RunResponse,
} from "./api/types";
import { initialBatchForm } from "./features/batch/form";
import { loadWorkingSession, saveWorkingSession } from "./features/session/workingSession";

beforeEach(() => {
  sessionStorage.clear();
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

describe("Batch preview", () => {
  it("places Seeds before Reference Assets in the Batch editor", () => {
    const api = makeApi();
    render(<App api={api} />);

    const seeds = screen.getByRole("group", { name: "Seeds" });
    const references = screen.getByRole("group", { name: "Reference Assets" });

    expect(seeds.compareDocumentPosition(references) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("builds the API request and renders Jobs and compiler warnings", async () => {
    const api = makeApi({ previewBatch: vi.fn(async () => previewResponse()) });
    render(<App api={api} />);
    await enterAsset();

    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));

    expect(await screen.findByText("Compiler warnings")).toBeInTheDocument();
    expect(screen.getByText("Unused binding variable")).toBeInTheDocument();
    expect(screen.getByText("A studio portrait of cat.")).toBeInTheDocument();
    expect(screen.getByText("subject = cat")).toBeInTheDocument();
    expect(screen.getAllByText("Portrait", { selector: ".prompt-identity strong" })).toHaveLength(2);
    expect(screen.getAllByText("prompt-v1", { selector: ".prompt-identity code" })).toHaveLength(2);
    const request = vi.mocked(api.previewBatch).mock.calls[0][0];
    expect(request.references).toEqual([{ asset_id: "asset-1" }]);
    expect(request.seeds).toEqual({ mode: "fixed", values: [1] });
    expect(request.variable_bindings[0]).toEqual(
      expect.objectContaining({ placeholder: "subject", selected_values: ["cat", "dog"] }),
    );
  });

  it("renders backend validation errors near the Batch editor", async () => {
    const api = makeApi({
      previewBatch: vi.fn(async () => {
        throw new ApiError("Selected value is not in the Variable List", "invalid_batch", 422);
      }),
    });
    render(<App api={api} />);
    await enterAsset();

    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));

    expect(
      await screen.findByText("Selected value is not in the Variable List"),
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
    const assets = [asset("asset-a", "a.png"), asset("asset-b", "b.png")];
    const api = makeApi({
      listProjectAssets: vi.fn(async () => ({ assets })),
      previewBatch: vi.fn(async () => previewResponse(2)),
      createRun: vi.fn(async () => runResponse("run-two", 2, 2)),
    });
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Select a.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Select b.png" }));

    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    await screen.findByRole("button", { name: "Create Run" });
    const previewRequest = vi.mocked(api.previewBatch).mock.calls[0][0];
    expect(previewRequest.references).toEqual([
      { asset_id: "asset-a" },
      { asset_id: "asset-b" },
    ]);
    expect(screen.getByText("2", { selector: ".count-block strong" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));

    expect(await screen.findByRole("heading", { name: "Run 2" })).toBeInTheDocument();
    expect(vi.mocked(api.createRun).mock.calls[0][0]).toBe(previewRequest);
    expect(screen.getByText("2", { selector: ".run-metadata dd" })).toBeInTheDocument();
  });

  it("materializes Random seeds once and consumes the Preview after successful Run creation", async () => {
    const api = makeApi({
      previewBatch: vi.fn(async () => previewResponse(3)),
      createRun: vi.fn(async () => runResponse("run-random", 4, 3)),
    });
    render(<App api={api} />);
    await enterAsset();
    fireEvent.change(screen.getByLabelText("Seed mode"), { target: { value: "random" } });
    fireEvent.change(screen.getByLabelText(/Random seed count/), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Prompt" }));
    const promptTemplates = screen.getAllByLabelText(/Prompt template/);
    fireEvent.change(promptTemplates[1], { target: { value: "A second portrait of {{subject}}." } });

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

  it("invalidates Preview after reference edits and requires Preview before creation", async () => {
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
    fireEvent.click(await screen.findByRole("button", { name: "Select a.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Select b.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    await screen.findByRole("button", { name: "Create Run" });

    fireEvent.click(screen.getByRole("button", { name: "Select c.png" }));

    expect(screen.getByText(/Preview required/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create Run" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    await waitFor(() => expect(api.previewBatch).toHaveBeenCalledTimes(2));
    expect(screen.getByText("3", { selector: ".count-block strong" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create Run" }));

    expect(await screen.findByRole("heading", { name: "Run 3" })).toBeInTheDocument();
    expect(vi.mocked(api.createRun).mock.calls[0][0].references).toHaveLength(3);
  });
});

describe("PromptVersion editor", () => {
  it("starts with one prompt and supports stable add, edit, reorder, remove, and final removal prevention", () => {
    render(<App api={makeApi()} />);

    expect(screen.getAllByLabelText("PromptVersion ID")).toHaveLength(1);
    expect(screen.getByLabelText("Prompt name")).toHaveValue("Portrait");
    expect(within(promptCards()[0]).getByRole("button", { name: "Remove" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Add Prompt" }));
    const ids = screen.getAllByLabelText("PromptVersion ID");
    const names = screen.getAllByLabelText("Prompt name");
    const templates = screen.getAllByLabelText(/Prompt template/);
    expect(ids).toHaveLength(2);
    expect(names[1]).toHaveValue("Prompt 2");

    fireEvent.change(ids[1], { target: { value: "prompt-alt" } });
    fireEvent.change(names[1], { target: { value: "Alternate" } });
    fireEvent.change(templates[1], { target: { value: "Alternate {{subject}}" } });
    const secondCard = templates[1].closest(".prompt-card");
    expect(secondCard).not.toBeNull();
    fireEvent.click(within(secondCard as HTMLElement).getByRole("button", { name: "Move up" }));

    expect(screen.getAllByLabelText("PromptVersion ID")[0]).toHaveValue("prompt-alt");
    expect(screen.getAllByLabelText("Prompt name")[0]).toHaveValue("Alternate");
    expect(screen.getAllByLabelText(/Prompt template/)[0]).toHaveValue("Alternate {{subject}}");

    fireEvent.click(within(promptCards()[0]).getByRole("button", { name: "Remove" }));
    expect(screen.getAllByLabelText("PromptVersion ID")).toHaveLength(1);
    expect(within(promptCards()[0]).getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(screen.getByLabelText("Prompt name")).toHaveValue("Portrait");
  });

  it("routes prompt edits through form change and invalidates Preview", async () => {
    render(<App api={makeApi()} />);
    await reachPreview();
    expect(screen.getByRole("button", { name: "Create Run" })).toBeEnabled();

    fireEvent.change(screen.getByLabelText("Prompt name"), { target: { value: "Changed" } });

    expect(screen.getByText(/Preview required/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create Run" })).not.toBeInTheDocument();
  });
});

describe("Browser working-session restoration", () => {
  it("restores the form and ordered references after remount but requires a new Preview", async () => {
    const assets = [asset("asset-a", "a.png"), asset("asset-b", "b.png")];
    const api = makeApi({ listProjectAssets: vi.fn(async () => ({ assets })) });
    const first = render(<App api={api} />);
    fireEvent.change(screen.getByLabelText(/Prompt template/), {
      target: { value: "Restored portrait of {{subject}}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Prompt" }));
    fireEvent.change(screen.getAllByLabelText("PromptVersion ID")[1], {
      target: { value: "prompt-editorial" },
    });
    fireEvent.change(screen.getAllByLabelText("Prompt name")[1], {
      target: { value: "Editorial" },
    });
    fireEvent.change(screen.getAllByLabelText(/Prompt template/)[1], {
      target: { value: "Editorial image of {{subject}}" },
    });
    fireEvent.change(screen.getByLabelText(/Variable List values/), {
      target: { value: "fox\nwolf" },
    });
    fireEvent.change(screen.getByLabelText("Seed mode"), { target: { value: "explicit" } });
    fireEvent.change(screen.getByLabelText(/Explicit seeds/), { target: { value: "9, 3" } });
    fireEvent.change(screen.getByLabelText("Workflow JSON"), {
      target: { value: '{"workflow":true}' },
    });
    fireEvent.change(screen.getByLabelText("Workflow Profile JSON"), {
      target: { value: '{"profile":true}' },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Select b.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Select a.png" }));
    await waitFor(() => expect(sessionStorage.getItem("batchcraft.working-session")).not.toBeNull());
    first.unmount();

    render(<App api={api} />);

    expect(await screen.findByText(/Draft restored from this browser session/)).toBeInTheDocument();
    expect(screen.getAllByLabelText("PromptVersion ID").map((field) => (field as HTMLInputElement).value))
      .toEqual(["prompt-v1", "prompt-editorial"]);
    expect(screen.getAllByLabelText("Prompt name").map((field) => (field as HTMLInputElement).value))
      .toEqual(["Portrait", "Editorial"]);
    expect(screen.getAllByLabelText(/Prompt template/).map((field) => (field as HTMLTextAreaElement).value))
      .toEqual(["Restored portrait of {{subject}}", "Editorial image of {{subject}}"]);
    expect(screen.getByLabelText(/Variable List values/)).toHaveValue("fox\nwolf");
    expect(screen.getByLabelText("Seed mode")).toHaveValue("explicit");
    expect(screen.getByLabelText(/Explicit seeds/)).toHaveValue("9, 3");
    expect(screen.getByLabelText("Workflow JSON")).toHaveValue('{"workflow":true}');
    expect(screen.getByLabelText("Workflow Profile JSON")).toHaveValue('{"profile":true}');
    expect(screen.getByText("2 images selected")).toBeInTheDocument();
    expect(screen.queryByText("b.png")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Selected Reference Assets" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Change selection" }));
    const selected = await screen.findByRole("list", { name: "Selected Reference Assets" });
    expect([...selected.querySelectorAll("li > span")].map((item) => item.textContent)).toEqual([
      "b.png",
      "a.png",
    ]);
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

  it("surfaces a restored Reference Asset that no longer exists and blocks Preview", async () => {
    const form = initialBatchForm();
    form.referenceAssetIds = ["asset-missing"];
    saveWorkingSession(form, null);
    const api = makeApi();
    render(<App api={api} />);

    expect(screen.getByText("1 image selected")).toBeInTheDocument();
    expect(screen.queryByText("asset-missing (missing from Project)")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Change selection" }));
    expect(await screen.findByText("asset-missing (missing from Project)")).toBeInTheDocument();
    expect(screen.getByText("Remove missing Reference Assets before Previewing this Batch.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));

    expect(
      await screen.findByText(/Selected Reference Assets are no longer available/),
    ).toBeInTheDocument();
    expect(api.previewBatch).not.toHaveBeenCalled();
  });
});

describe("Reference Asset picker", () => {
  it("shows only the selected count while collapsed and toggles the Project library", async () => {
    const form = initialBatchForm();
    form.referenceAssetIds = ["asset-a"];
    saveWorkingSession(form, null);
    const api = makeApi({
      listProjectAssets: vi.fn(async () => ({ assets: [asset("asset-a", "a.png")] })),
    });
    render(<App api={api} />);

    expect(screen.getByText("1 image selected")).toBeInTheDocument();
    expect(screen.queryByText("a.png")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deselect a.png" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Change selection" }));
    expect(await screen.findByRole("button", { name: "Deselect a.png" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide images" }));

    expect(screen.queryByText("a.png")).not.toBeInTheDocument();
    expect(screen.getByText("1 image selected")).toBeInTheDocument();
  });

  it("Select All preserves selected order, appends display order, and Select None invalidates Preview", async () => {
    const form = initialBatchForm();
    form.referenceAssetIds = ["asset-c", "asset-a"];
    saveWorkingSession(form, null);
    const assets = [asset("asset-a", "a.png"), asset("asset-b", "b.png"), asset("asset-c", "c.png")];
    const api = makeApi({ listProjectAssets: vi.fn(async () => ({ assets })) });
    render(<App api={api} />);

    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    await screen.findByRole("button", { name: "Create Run" });
    fireEvent.click(screen.getByRole("button", { name: "Change selection" }));
    await screen.findByRole("button", { name: "Deselect a.png" });

    fireEvent.click(screen.getByRole("button", { name: "Select All" }));

    expect(screen.getByText("3 images selected")).toBeInTheDocument();
    expect(screen.getByText(/Preview required/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));
    await waitFor(() => expect(api.previewBatch).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.previewBatch).mock.calls[1][0].references).toEqual([
      { asset_id: "asset-c" },
      { asset_id: "asset-a" },
      { asset_id: "asset-b" },
    ]);
    await screen.findByRole("button", { name: "Create Run" });

    fireEvent.click(screen.getByRole("button", { name: "Select None" }));

    expect(screen.getByText("0 images selected")).toBeInTheDocument();
    expect(screen.getByText(/Preview required/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create Run" })).not.toBeInTheDocument();
  });

  it("renders an empty library and reports listing errors without blocking editing", async () => {
    const api = makeApi({ listProjectAssets: vi.fn(async () => ({ assets: [] })) });
    const { rerender } = render(<App api={api} />);

    expect(await screen.findByText("This Project has no imported images.")).toBeInTheDocument();

    const failingApi = makeApi({
      listProjectAssets: vi.fn(async () => {
        throw new ApiError("Asset index unavailable", "invalid_asset_data", 500);
      }),
    });
    rerender(<App api={failingApi} />);

    expect(await screen.findByText("Asset library: Asset index unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview Batch" })).toBeEnabled();
  });

  it("preserves selection order and appends an asset when it is reselected", async () => {
    const assets = [asset("asset-a", "a.png"), asset("asset-c", "c.png"), asset("asset-b", "b.png")];
    const api = makeApi({ listProjectAssets: vi.fn(async () => ({ assets })) });
    render(<App api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "Select a.png" }));
    expect(screen.getByRole("button", { name: "Deselect a.png" }).querySelector("img")).toHaveAttribute(
      "src",
      "http://api.test/api/assets/asset-a",
    );
    expect(screen.getByRole("button", { name: "Deselect a.png" }).querySelector(".asset-preview-frame img"))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select c.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Select b.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Deselect c.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Select c.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview Batch" }));

    await waitFor(() => expect(api.previewBatch).toHaveBeenCalledOnce());
    expect(vi.mocked(api.previewBatch).mock.calls[0][0].references).toEqual([
      { asset_id: "asset-a" },
      { asset_id: "asset-b" },
      { asset_id: "asset-c" },
    ]);
    const selected = screen.getByRole("list", { name: "Selected Reference Assets" });
    expect([...selected.querySelectorAll("li > span")].map((item) => item.textContent)).toEqual([
      "a.png",
      "b.png",
      "c.png",
    ]);
  });

  it("clears selection and ignores a stale library response when the Project changes", async () => {
    const oldLibrary = deferred<{ assets: AssetResponse[] }>();
    const api = makeApi({
      listProjectAssets: vi.fn((projectKey: string) =>
        projectKey === "project_1"
          ? oldLibrary.promise
          : Promise.resolve({ assets: [asset("asset-new", "new.png")] }),
      ),
    });
    render(<App api={api} />);
    fireEvent.change(screen.getByLabelText("Filesystem key", { selector: "#project-key" }), {
      target: { value: "new_project" },
    });

    expect(await screen.findByRole("button", { name: "Select new.png" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select new.png" }));
    fireEvent.change(screen.getByLabelText("Filesystem key", { selector: "#project-key" }), {
      target: { value: "final_project" },
    });
    oldLibrary.resolve({ assets: [asset("asset-old", "old.png")] });

    await waitFor(() => expect(api.listProjectAssets).toHaveBeenCalledWith("final_project", expect.any(AbortSignal)));
    expect(screen.queryByRole("button", { name: /old\.png/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Selected Reference Assets" })).not.toBeInTheDocument();
  });

  it("merges imported assets, deduplicates them, and selects new imports", async () => {
    const existing = asset("asset-a", "a.png");
    const imported = asset("asset-b", "b.png");
    const api = makeApi({
      listProjectAssets: vi.fn(async () => ({ assets: [existing] })),
      uploadProjectAssets: vi.fn(async () => ({ assets: [existing, imported, imported] })),
    });
    render(<App api={api} />);
    await screen.findByRole("button", { name: "Select a.png" });

    fireEvent.change(screen.getByLabelText("Import images"), {
      target: { files: [new File(["image"], "b.png", { type: "image/png" })] },
    });

    expect(await screen.findByRole("button", { name: "Deselect b.png" })).toBeInTheDocument();
    expect(screen.getAllByText("b.png")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /b\.png/ })).toHaveLength(1);
    expect(api.uploadProjectAssets).toHaveBeenCalledWith("project_1", expect.any(Array));
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
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Run 9 was created with 3 Jobs, but the inspected Preview has 2",
    );
    expect(screen.getByText("Run 9 was created but does not match this Preview.")).toBeInTheDocument();
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
    expect(screen.getByText("prompt-1")).toBeInTheDocument();
    expect(api.startRun).toHaveBeenCalledWith("run-123");

    await waitFor(() => expect(api.getExecution).toHaveBeenCalledTimes(2));
    secondPoll.resolve(execution("succeeded"));
    expect(await screen.findByText("Succeeded")).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "Add Prompt" }));
    fireEvent.change(screen.getAllByLabelText(/Prompt template/)[1], {
      target: { value: "Alternate {{subject}}" },
    });
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
    expect(previewRequest.prompt_versions.map((prompt) => prompt.name)).toEqual([
      "Portrait",
      "Prompt 2",
    ]);
    expect(screen.getAllByLabelText(/Prompt template/)[0]).toHaveValue(
      "A studio portrait of {{subject}}.",
    );
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
    expect(api.startRun).not.toHaveBeenCalled();
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
    expect(await screen.findAllByAltText("Result 1 from Job 1: restored.png")).toHaveLength(2);
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

    expect(screen.queryByText("old-run.png")).not.toBeInTheDocument();
    expect(within(currentRunSection()).getByText("run-b")).toBeInTheDocument();
  });
});

describe("Results", () => {
  it("renders ordered image and non-image artifacts with metadata", async () => {
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
    const firstImage = await within(currentResults as HTMLElement).findByAltText(
      "Result 1 from Job 1: first.png",
    );
    expect(firstImage).toHaveAttribute("src", "http://api.test/api/result/1/1");
    expect(within(currentResults as HTMLElement).getByRole("link", { name: /JSON\s*Open artifact/ })).toHaveAttribute(
      "href",
      "http://api.test/api/result/1/2",
    );
    expect(within(currentResults as HTMLElement).getByText("metadata.json")).toBeInTheDocument();
    expect(within(currentResults as HTMLElement).getByText("512 B")).toBeInTheDocument();
    expect(firstImage).toHaveClass("result-image");
    expect(firstImage.closest(".result-image-link")).toBeInTheDocument();
    expect(firstImage.closest(".result-preview-frame")).not.toBeInTheDocument();

    const cards = currentResults?.querySelectorAll(".result-card") ?? [];
    expect(cards).toHaveLength(3);
    expect(within(cards[0] as HTMLElement).getByText("first.png")).toBeInTheDocument();
    expect(within(cards[1] as HTMLElement).getByText("metadata.json")).toBeInTheDocument();
    expect(within(cards[2] as HTMLElement).getByText("second.jpg")).toBeInTheDocument();
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
    expect(await within(gallery).findByText("a1.png")).toBeInTheDocument();
    expect(within(gallery).getByText("a2.png")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create Another Run" }));
    await screen.findByRole("heading", { name: "Run 11" });
    expect(within(gallery).getByText("a1.png")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start Run" }));

    expect(await within(gallery).findByText("b1.png")).toBeInTheDocument();
    const filenames = [...gallery.querySelectorAll(".result-filename")].map((item) => item.textContent);
    expect(filenames).toEqual(["a1.png", "a2.png", "b1.png", "b2.json"]);
    expect(loadWorkingSession().sessionRunIds).toEqual(["run-a", "run-b"]);
  });

  it("restores multiple session Runs once without executing or duplicating the current Run", async () => {
    const form = initialBatchForm();
    form.referenceAssetIds = ["asset-1"];
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
    expect(await within(gallery).findByText("run-a.png")).toBeInTheDocument();
    expect(await within(gallery).findByText("run-b.png")).toBeInTheDocument();
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
    });
    render(<App api={api} pollIntervalMs={5} />);
    await createRunAndStart();
    const gallery = batchResultsSection();
    expect(await within(gallery).findByText("old-batch.png")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Batch ID"), { target: { value: "different-batch" } });

    expect(within(gallery).queryByText("old-batch.png")).not.toBeInTheDocument();
    expect(within(gallery).getByText(/will accumulate here/)).toBeInTheDocument();
    expect(loadWorkingSession().sessionRunIds).toEqual([]);
  });

  it("keeps healthy historical Results when another session Run is unavailable", async () => {
    const form = initialBatchForm();
    form.referenceAssetIds = ["asset-1"];
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
    expect(await within(gallery).findByText("healthy.png")).toBeInTheDocument();
    expect(within(gallery).getByText("Unavailable: Run data is invalid")).toBeInTheDocument();
    expect(api.getRun).toHaveBeenCalledTimes(2);
  });
});

function makeApi(overrides: Partial<BatchcraftApi> = {}): BatchcraftApi {
  return {
    getComfyUIStatus: vi.fn(async () => ({
      reachable: true,
      version: "0.31.0",
      devices: ["Test GPU"],
      diagnostic: null,
    })),
    listProjectAssets: vi.fn(async () => ({ assets: [asset("asset-1", "portrait.png")] })),
    uploadProjectAssets: vi.fn(async () => ({ assets: [] })),
    previewBatch: vi.fn(async () => previewResponse()),
    createRun: vi.fn(async () => runResponse()),
    getRun: vi.fn(async () => runLookupResponse()),
    startRun: vi.fn(async (runId: string) => ({ run_id: runId, status: "accepted" })),
    getExecution: vi.fn(async () => execution("succeeded")),
    getResults: vi.fn(async () => ({ run_id: "run-123", results: [] })),
    resultUrl: (url: string) => `http://api.test${url}`,
    assetUrl: (url: string) => `http://api.test${url}`,
    ...overrides,
  };
}

function previewResponse(jobCount = 2): PreviewResponse {
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
        reference_asset_id: "asset-1",
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
    execution: execution(status, runId),
  };
}

function execution(status: ExecutionResponse["status"], runId = "run-123"): ExecutionResponse {
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

function seedWorkingSession(runId: string) {
  const form = initialBatchForm();
  form.referenceAssetIds = ["asset-1"];
  saveWorkingSession(form, runId, [runId]);
}

function batchResultsSection(): HTMLElement {
  const section = screen.getByRole("heading", { name: "Batch Results" }).closest("section");
  if (!section) {
    throw new Error("Batch Results section was not rendered");
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

function promptCards(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".prompt-card")];
}

async function enterAsset() {
  fireEvent.click(await screen.findByRole("button", { name: "Select portrait.png" }));
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
