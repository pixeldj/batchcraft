import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import type {
  BatchRequest, CreatePromptResponse, CreateWorkflowResponse, CreateWorkflowProfileResponse,
  GlobalCatalogItem, GlobalCopyResponse, GlobalProfileMetadata, LibraryPage, PreviewResponse,
  ProjectCopyResponse, ProjectResponse, RunCreatedResponse, RunResponse, SavedBatchDetail,
  SetupCopyRequest,
} from "../src/api/types";

const apiUrl = "http://127.0.0.1:8002";

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(`${apiUrl}${path}`, { data });
  expect(response.ok(), await response.text()).toBeTruthy();
  return await response.json() as T;
}

// Same real-API seed pattern as smoke.spec.ts, with one Job and two distinct Profiles.
async function seed(request: APIRequestContext, withSetup = true) {
  const suffix = randomUUID().slice(0, 8);
  const project = await post<ProjectResponse>(request, "/api/projects", {
    name: `Global ${suffix}`, filesystem_key: `global_${suffix}`,
  });
  const prompt = await post<CreatePromptResponse>(request, `/api/projects/${project.id}/prompts`, {
    name: "Landscape", text: `A mountain at sunset ${suffix}`,
  });
  const workflow = withSetup ? await post<CreateWorkflowResponse>(request, `/api/projects/${project.id}/workflows`, {
    name: `Source workflow ${suffix}`,
    workflow: {
      "1": { class_type: "CLIPTextEncode", inputs: { text: "Landscape" } },
      "2": { class_type: "KSampler", inputs: { seed: 1, steps: 20, cfg: 7 } },
      "3": { class_type: "SaveImage", inputs: { filename_prefix: "sandbox" } },
    },
  }) : null;
  const profiles: CreateWorkflowProfileResponse[] = [];
  if (workflow) {
    for (const [key, label, value_type] of [["steps", "Steps", "integer"], ["cfg", "CFG", "float"]]) {
      profiles.push(await post<CreateWorkflowProfileResponse>(request, `/api/workflows/${workflow.workflow.id}/profiles`, {
        name: `${label} mapping`, workflow_version_id: workflow.version.id,
        mappings: {
          prompt: { node_id: "1", input_name: "text", value_type: "string" },
          seed: { node_id: "2", input_name: "seed", value_type: "integer" },
          output_prefix: { node_id: "3", input_name: "filename_prefix", value_type: "string" },
        },
        image_inputs: [],
        parameters: [{ key, label, node_id: "2", input_name: key, value_type }],
      }));
    }
  }
  const profile = profiles[0];
  const batch = await post<SavedBatchDetail>(request, `/api/projects/${project.id}/batches`, {
    name: "Global library baseline", filesystem_key: "baseline",
    prompt_selections: [{ prompt_version_id: prompt.version.id, name_snapshot: prompt.version.name_snapshot, text: prompt.version.text }],
    variable_bindings: [], image_bindings: [], linked_parameter_sets: [],
    parameter_bindings: workflow ? [{ parameter_key: "steps", mode: "values", values: [null] }] : [],
    seed_intent: { mode: "fixed", values: [42], random_seed_count: null },
    selected_workflow_version: workflow ? {
      id: workflow.version.id, content_sha256: workflow.version.content_sha256, workflow: workflow.version.workflow,
    } : null,
    selected_workflow_profile_id: profile?.workflow_profile.id ?? null,
    selected_workflow_profile_version: profile ? {
      id: profile.version.id, workflow_profile_id: profile.workflow_profile.id,
      workflow_version_id: workflow!.version.id, content_sha256: profile.version.content_sha256, profile: profile.version.profile,
    } : null,
  });
  return { project, prompt, workflow, profiles, batch };
}

test("real API: global catalog without a Project uses bounded metadata reads and narrow dialogs", async ({ page, request }, testInfo) => {
  const source = await seed(request);
  const imported = await post<GlobalCopyResponse>(request, "/api/library/workflows/import-project", {
    request_id: randomUUID(), project_id: source.project.id, workflow_version_id: source.workflow!.version.id,
    profiles: source.profiles.map((item) => ({ version_id: item.version.id })),
  });
  const paths: string[] = [];
  page.on("request", (sent) => paths.push(new URL(sent.url()).pathname));
  const catalogResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/library/workflows");
  await page.goto("/?view=workflows");
  const catalog = await catalogResponse;
  expect(catalog.ok()).toBe(true);
  expect(new URL(catalog.url()).searchParams.get("limit")).toBe("20");
  const metadata = await catalog.json() as LibraryPage<GlobalCatalogItem>;
  expect(metadata.items.length).toBeLessThanOrEqual(20);
  expect(metadata.items.some((item) => item.id === imported.workflow.workflow.id)).toBe(true);
  for (const item of metadata.items) {
    expect(item).not.toHaveProperty("workflow");
    expect(item).not.toHaveProperty("profile");
    expect(item).not.toHaveProperty("project_id");
  }
  expect(paths.filter((path) => path.startsWith("/api/library/workflow-versions/"))).toEqual([]);
  const library = page.getByRole("region", { name: "Global Workflow Library" });
  await library.getByRole("button", { name: imported.workflow.workflow.name, exact: true }).click();
  await expect(library.getByRole("button", { name: "Use in this Project", exact: true })).toBeDisabled();
  await expect(library).toContainText("Select and verify a Project in Batch");
  await page.screenshot({ path: testInfo.outputPath("global-library.png"), fullPage: true });
  const profilesResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/library/workflow-versions/${imported.workflow.version.id}/profiles`);
  await library.getByRole("button", { name: "Inspect compatible Profiles" }).click();
  const received = await profilesResponse;
  expect(received.ok()).toBe(true);
  expect(new URL(received.url()).searchParams.get("limit")).toBe("20");
  const profiles = await received.json() as LibraryPage<GlobalProfileMetadata>;
  expect(profiles.items).toHaveLength(2);
  for (const item of profiles.items) expect(item).not.toHaveProperty("profile");
  const dialog = page.getByRole("dialog", { name: "Review Project copy" });
  await expect(dialog.getByRole("button", { name: "Confirm copy" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Inspect CFG mapping", exact: true }).click();
  await expect(dialog.locator("pre").last()).toContainText('"input_name": "cfg"');
  await page.screenshot({ path: testInfo.outputPath("global-profile-inspection.png") });
  await page.setViewportSize({ width: 320, height: 740 });
  await page.screenshot({ path: testInfo.outputPath("global-copy-dialog-320.png") });
  expect.soft(await dialog.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.left >= 0 && box.right <= innerWidth && element.scrollWidth <= element.clientWidth;
  }), "Copy dialog must fit 320px without horizontal scrolling").toBe(true);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await library.getByRole("button", { name: "Import to Library", exact: true }).click();
  await page.getByRole("combobox", { name: "Source Project", exact: true }).selectOption(source.project.id);
  await page.getByRole("combobox", { name: "Source Workflow", exact: true }).selectOption(source.workflow!.workflow.id);
  await expect(page.getByRole("combobox", { name: "Source Workflow revision", exact: true })).toHaveValue(source.workflow!.version.id);
  await page.screenshot({ path: testInfo.outputPath("global-import-dialog-320.png") });
  expect.soft(await page.getByRole("dialog", { name: "Import Project setup" }).evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.left >= 0 && box.right <= innerWidth && element.scrollWidth <= element.clientWidth;
  }), "Import dialog must fit 320px without horizontal scrolling").toBe(true);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Batch", exact: true }).click();
  await expect(page.getByLabel("Active Project")).toHaveValue("");
  expect(paths.filter((path) => /\/history(?:\/|$)|\/reindex$|\/projects\/[^/]+\/runs/.test(path))).toEqual([]);
});

test("real API: Project A imports without invalidating Preview, Project B explicitly applies independent copies and executes", async ({ page, request }, testInfo) => {
  const source = await seed(request);
  const destination = await seed(request, false);
  const paths: string[] = [];
  const errors: string[] = [];
  page.on("request", (sent) => paths.push(new URL(sent.url()).pathname));
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByLabel("Active Project").selectOption(source.project.id);
  await page.getByLabel("Saved Batch", { exact: true }).selectOption(source.batch.id);
  await page.getByRole("button", { name: "Discard and switch", exact: true }).click();
  const baselineResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/batches/preview");
  await page.getByRole("button", { name: "Preview Batch", exact: true }).click();
  const baseline = await baselineResponse;
  expect(baseline.ok()).toBe(true);
  expect((await baseline.json() as PreviewResponse).job_count).toBe(1);
  const setup = page.getByRole("group", { name: "Workflow Setup", exact: true });
  const baselineSetup = await setup.textContent();
  const navigation = page.getByRole("navigation", { name: "Workspace" });
  await navigation.getByRole("button", { name: "Workflow Library", exact: true }).click();
  const library = page.getByRole("region", { name: "Global Workflow Library" });
  await library.getByRole("button", { name: "Import to Library", exact: true }).click();
  await page.getByRole("combobox", { name: "Source Project", exact: true }).selectOption(source.project.id);
  await page.getByRole("combobox", { name: "Source Workflow", exact: true }).selectOption(source.workflow!.workflow.id);
  await expect(page.getByRole("combobox", { name: "Source Workflow revision", exact: true })).toHaveValue(source.workflow!.version.id);
  await page.getByRole("button", { name: "Review import", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review library import" });
  await expect(review.getByRole("checkbox")).toHaveCount(2);
  await expect(review.getByRole("checkbox", { name: "CFG mapping / v1", exact: true })).toBeChecked();
  await review.getByRole("button", { name: "Revisions for CFG mapping" }).click();
  await expect(review.getByRole("combobox", { name: "Exact revision for CFG mapping", exact: true })).toHaveValue(source.profiles[1].version.id);
  const globalName = `Reusable ${source.project.id}`;
  await review.getByLabel("New Workflow name (optional)").fill(globalName);
  await review.getByLabel("Copy name for CFG mapping").fill("Catalog CFG");
  await review.getByLabel("Copy name for Steps mapping").fill("Catalog Steps");
  const importedResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/library/workflows/import-project");
  await review.getByRole("button", { name: "Confirm copy" }).click();
  const importResponse = await importedResponse;
  expect(importResponse.ok()).toBe(true);
  const importRequest = importResponse.request().postDataJSON() as SetupCopyRequest;
  expect(importRequest).toMatchObject({ project_id: source.project.id, workflow_version_id: source.workflow!.version.id, name: globalName });
  expect(importRequest.profiles.map((item) => item.version_id).sort()).toEqual(source.profiles.map((item) => item.version.id).sort());
  const imported = await importResponse.json() as GlobalCopyResponse;
  expect(imported.request_id).toBe(importRequest.request_id);
  expect(imported.workflow.version.workflow).toEqual(source.workflow!.version.workflow);
  expect(imported.workflow.workflow.id).not.toBe(source.workflow!.workflow.id);
  await expect(review).toContainText("Your Batch and Preview are unchanged");
  await review.getByRole("button", { name: "Close", exact: true }).click();
  await navigation.getByRole("button", { name: "Batch", exact: true }).click();
  await expect(page.getByRole("button", { name: "Create Run", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Active Project")).toHaveValue(source.project.id);
  expect(await setup.textContent()).toBe(baselineSetup);
  expect(paths.filter((path) => path === "/api/batches/preview")).toHaveLength(1);

  await page.getByLabel("Active Project").selectOption(destination.project.id);
  await page.getByRole("dialog", { name: "Change Project?", exact: true }).getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel("Active Project")).toHaveValue(destination.project.id);
  await page.getByLabel("Saved Batch", { exact: true }).selectOption(destination.batch.id);
  await page.getByRole("button", { name: "Discard and switch", exact: true }).click();
  await expect(page.getByLabel("Saved Batch", { exact: true })).toHaveValue(destination.batch.id);
  await expect(page.getByRole("button", { name: "Create Run", exact: true })).toHaveCount(0);
  const emptyWorkflow = await page.getByLabel("Workflow JSON", { exact: true }).inputValue();
  await navigation.getByRole("button", { name: "Workflow Library", exact: true }).click();
  await library.getByLabel("Search Workflow Library").fill(globalName);
  await library.getByRole("button", { name: "Search library", exact: true }).click();
  await library.getByRole("button", { name: globalName, exact: true }).click();
  await library.getByRole("button", { name: "Use in this Project", exact: true }).click();
  const copyDialog = page.getByRole("dialog", { name: "Review Project copy" });
  await copyDialog.getByRole("checkbox", { name: "Catalog CFG / v1", exact: true }).check();
  await copyDialog.getByRole("checkbox", { name: "Catalog Steps / v1", exact: true }).check();
  await copyDialog.getByLabel("New Workflow name (optional)").fill("Destination workflow");
  await copyDialog.getByLabel("Copy name for Catalog CFG").fill("Destination CFG");
  await copyDialog.getByLabel("Copy name for Catalog Steps").fill("Destination Steps");
  await page.screenshot({ path: testInfo.outputPath("global-copy-naming-review.png") });
  const copiedResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/library/workflows/use-in-project");
  await copyDialog.getByRole("button", { name: "Confirm copy" }).click();
  const copyResponse = await copiedResponse;
  expect(copyResponse.ok()).toBe(true);
  const copyRequest = copyResponse.request().postDataJSON() as SetupCopyRequest;
  const copied = await copyResponse.json() as ProjectCopyResponse;
  expect(copyRequest).toMatchObject({ project_id: destination.project.id, workflow_version_id: imported.workflow.version.id, name: "Destination workflow" });
  expect(copyRequest.profiles.map((item) => item.version_id).sort()).toEqual(imported.profiles.map((item) => item.version.id).sort());
  expect(copied.request_id).toBe(copyRequest.request_id);
  expect(copied.request_id).not.toBe(imported.request_id);
  expect(await post<ProjectCopyResponse>(request, "/api/library/workflows/use-in-project", copyRequest)).toEqual(copied);
  expect(new Set([source.workflow!.workflow.id, imported.workflow.workflow.id, copied.workflow.workflow.id]).size).toBe(3);
  expect(new Set([source.workflow!.version.id, imported.workflow.version.id, copied.workflow.version.id]).size).toBe(3);
  expect(copied.workflow.workflow.project_id).toBe(destination.project.id);
  expect(copied.workflow.version.workflow).toEqual(source.workflow!.version.workflow);
  for (const original of source.profiles) {
    const key = (original.version.profile.parameters as Array<{ key: string }>)[0].key;
    const global = imported.profiles.find((item) => (item.version.profile.parameters as Array<{ key: string }>)[0].key === key)!;
    const copy = copied.profiles.find((item) => (item.version.profile.parameters as Array<{ key: string }>)[0].key === key)!;
    expect(new Set([original.workflow_profile.id, global.workflow_profile.id, copy.workflow_profile.id]).size).toBe(3);
    expect(new Set([original.version.id, global.version.id, copy.version.id]).size).toBe(3);
    expect(copy.version.workflow_version_id).toBe(copied.workflow.version.id);
    expect(copy.version.profile.id).toBe(copy.workflow_profile.id);
    for (const field of ["mappings", "image_inputs", "parameters"]) {
      expect(global.version.profile[field]).toEqual(original.version.profile[field]);
      expect(copy.version.profile[field]).toEqual(original.version.profile[field]);
    }
    const stored = await request.get(`${apiUrl}/api/workflow-profile-versions/${original.version.id}`);
    expect(stored.ok()).toBe(true);
    expect(await stored.json()).toEqual(original.version);
  }
  const storedWorkflow = await request.get(`${apiUrl}/api/workflow-versions/${source.workflow!.version.id}`);
  expect(storedWorkflow.ok()).toBe(true);
  expect(await storedWorkflow.json()).toEqual(source.workflow!.version);
  await expect(copyDialog).toContainText("Your Batch has not changed");
  expect(await page.getByLabel("Workflow JSON", { exact: true }).inputValue()).toBe(emptyWorkflow);
  await expect(copyDialog.getByRole("button", { name: "Use copied setup" })).toBeDisabled();
  const cfg = copied.profiles.find((item) => item.workflow_profile.name === "Destination CFG")!;
  await copyDialog.getByRole("combobox", { name: "Copied Profile to apply", exact: true }).selectOption(cfg.version.id);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Replace the Batch Workflow Setup");
    await dialog.dismiss();
  });
  await copyDialog.getByRole("button", { name: "Use copied setup" }).click();
  await expect(copyDialog).toBeVisible();
  expect(await page.getByLabel("Workflow JSON", { exact: true }).inputValue()).toBe(emptyWorkflow);
  page.once("dialog", async (dialog) => { await dialog.accept(); });
  await copyDialog.getByRole("button", { name: "Use copied setup" }).click();
  await expect(copyDialog).not.toBeVisible();
  await expect(page.getByLabel("Active Project")).toHaveValue(destination.project.id);
  await setup.getByRole("button", { name: "Change", exact: true }).click();
  expect(JSON.parse(await page.getByLabel("Workflow JSON", { exact: true }).inputValue())).toEqual(copied.workflow.version.workflow);
  expect(JSON.parse(await page.getByLabel("Workflow Profile JSON", { exact: true }).inputValue())).toEqual(cfg.version.profile);
  await page.getByRole("group", { name: "Parameters", exact: true }).getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: "Add override for CFG", exact: true }).click();
  await page.getByLabel("CFG override 2", { exact: true }).fill("1.5");
  const previewResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/batches/preview");
  await page.getByRole("button", { name: "Preview Batch", exact: true }).click();
  const received = await previewResponse;
  expect(received.ok()).toBe(true);
  const sent = received.request().postDataJSON() as BatchRequest;
  expect(sent.batch_snapshot.workflow_selection.workflow_version_id).toBe(copied.workflow.version.id);
  expect(sent.batch_snapshot.workflow_selection.workflow_profile_version_id).toBe(cfg.version.id);
  expect(sent.workflow_profile).toEqual(cfg.version.profile);
  expect(sent.batch_snapshot.seed_intent).toEqual({ mode: "fixed", values: [42], random_seed_count: null });
  const preview = await received.json() as PreviewResponse;
  expect(sent.parameter_bindings).toEqual([{ parameter_key: "cfg", mode: "values", values: [null, 1.5] }]);
  expect(preview.job_count).toBe(2);
  expect(preview.jobs).toMatchObject([null, 1.5].map((value) => ({
    resolved_prompt: destination.prompt.version.text, seed: 42,
    resolved_parameters: [{ parameter_key: "cfg", label: "CFG", value }],
  })));
  expect(paths.filter((path) => /\/history(?:\/|$)|\/reindex$|\/projects\/[^/]+\/runs/.test(path))).toEqual([]);
  const createdResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/runs" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Create Run", exact: true }).click();
  const created = await createdResponse;
  expect(created.ok()).toBe(true);
  const run = await created.json() as RunCreatedResponse;
  await page.getByRole("button", { name: "Start Run", exact: true }).click();
  await expect(page.getByText("Succeeded", { exact: true })).toBeVisible();
  await expect(page.locator("img.result-image")).toHaveCount(2);
  for (const image of await page.locator("img.result-image").all()) {
    await expect(image).toHaveJSProperty("naturalWidth", 384);
  }
  const frozenResponse = await request.get(`${apiUrl}/api/runs/${run.run_id}`);
  expect(frozenResponse.ok()).toBe(true);
  const frozen = await frozenResponse.json() as RunResponse;
  expect(frozen.plan.jobs).toMatchObject(preview.jobs);
  expect(frozen.batch_snapshot.workflow_selection).toEqual(sent.batch_snapshot.workflow_selection);
  await page.screenshot({ path: testInfo.outputPath("global-copy-result.png"), fullPage: true });
  expect(errors).toEqual([]);
});
