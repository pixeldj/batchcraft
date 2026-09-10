import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page, type Locator } from "@playwright/test";
import type {
  BatchRequest, CreatePromptResponse, CreateWorkflowResponse, CreateWorkflowProfileResponse,
  GlobalCatalogItem, GlobalCopyResponse, GlobalProfileFamily, GlobalProfileVersion, GlobalWorkflowVersion, LibraryPage, PreviewResponse,
  ProjectCopyResponse, ProjectResponse, RunCreatedResponse, RunResponse, SavedBatchDetail,
  SetupCopyRequest,
} from "../src/api/types";

const apiUrl = "http://127.0.0.1:8002";

function responseFor(page: Page, path: string, method = "POST") {
  return page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === method);
}

async function get<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`${apiUrl}${path}`);
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as T;
}

async function mapProfile(dialog: Locator, label: string, input: string) {
  for (const [mapping, node, target] of [["Prompt", "1", "text"], ["Seed", "2", "seed"], ["Output Prefix", "3", "filename_prefix"]]) {
    await dialog.getByLabel(`${mapping} node`, { exact: true }).selectOption(node);
    await dialog.getByLabel(`${mapping} input`, { exact: true }).selectOption(target);
  }
  await dialog.getByRole("button", { name: "Add Parameter", exact: true }).click();
  await dialog.getByLabel("Parameter 1 label", { exact: true }).fill(label);
  await dialog.getByLabel(`${label} node`, { exact: true }).selectOption("2");
  await dialog.getByLabel(`${label} input`, { exact: true }).selectOption(input);
  await expect(dialog.getByLabel(`${label} type`, { exact: true })).toHaveValue("integer");
}

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
  const profilesResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/library/workflows/${imported.workflow.workflow.id}/profiles`);
  await library.getByRole("button", { name: "Inspect compatible Profiles" }).click();
  const received = await profilesResponse;
  expect(received.ok()).toBe(true);
  expect(new URL(received.url()).searchParams.get("limit")).toBe("20");
  expect(new URL(received.url()).searchParams.get("workflow_version_id")).toBe(imported.workflow.version.id);
  const profiles = await received.json() as LibraryPage<GlobalProfileFamily>;
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
  await copyDialog.getByRole("checkbox", { name: "Catalog CFG", exact: true }).check();
  await copyDialog.getByRole("checkbox", { name: "Catalog Steps", exact: true }).check();
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

test("real UI: Project-free authoring, repair, immutable history and independent executable copies", async ({ page, request }, testInfo) => {
  page.setDefaultTimeout(10_000);
  const name = `Authored ${randomUUID().slice(0, 8)}`;
  const workflow = {
    "1": { class_type: "CLIPTextEncode", inputs: { text: "Landscape" } },
    "2": { class_type: "KSampler", inputs: { seed: 1, steps: 20, cfg: 7 } },
    "3": { class_type: "SaveImage", inputs: { filename_prefix: "sandbox" } },
  };
  const calls: Array<{ path: string; method: string }> = [];
  const errors: string[] = [];
  page.on("request", (sent) => calls.push({ path: new URL(sent.url()).pathname, method: sent.method() }));
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?view=workflows");
  const library = page.getByRole("region", { name: "Global Workflow Library" });
  await library.getByRole("button", { name: "New Workflow", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "New Workflow", exact: true });
  // Keep autofocus regressions failing while still exercising persistence and collecting layout evidence.
  await expect.soft(editor.getByLabel("Name", { exact: true })).toBeFocused();
  await editor.getByLabel("Name", { exact: true }).fill(name);
  await editor.getByRole("textbox", { name: "Workflow JSON", exact: true }).fill(JSON.stringify(workflow));
  await expect(editor.getByRole("button", { name: /^Save/ })).toHaveCount(1);
  const createdResponse = responseFor(page, "/api/library/workflows");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  const created = await createdResponse;
  expect(created.ok(), await created.text()).toBe(true);
  expect(created.request().postDataJSON()).toMatchObject({ name, workflow });
  const source = await created.json() as GlobalCopyResponse["workflow"];
  const profileDialog = page.getByRole("dialog", { name: "New Profile", exact: true });
  await expect(profileDialog.getByLabel("Name", { exact: true })).toHaveValue(`${name}-profile`);
  await expect.soft(profileDialog.getByLabel("Name", { exact: true })).toBeFocused();
  await profileDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(profileDialog).not.toBeVisible();
  const catalog = await get<LibraryPage<GlobalCatalogItem>>(request, `/api/library/workflows?q=${encodeURIComponent(name)}`);
  expect(catalog.items.map((item) => item.id)).toEqual([source.workflow.id]);
  const profilesPath = `/api/library/workflows/${source.workflow.id}/profiles`;
  expect((await get<LibraryPage<GlobalProfileFamily>>(request, profilesPath)).items).toEqual([]);
  expect(calls.filter((call) => call.method === "POST" && call.path === "/api/projects")).toEqual([]);
  await library.getByRole("button", { name: "New Profile", exact: true }).click();
  await expect(profileDialog.getByLabel("Name", { exact: true })).toHaveValue(`${name}-profile`);
  await profileDialog.getByLabel("Name", { exact: true }).fill("Steps mapping");
  await mapProfile(profileDialog, "Steps", "steps");
  // Duplicate literal targets pass native required validation but are rejected by the real backend.
  await profileDialog.getByLabel("Steps input", { exact: true }).selectOption("seed");
  const invalidResponse = responseFor(page, profilesPath);
  await profileDialog.getByRole("button", { name: "Save", exact: true }).click();
  expect((await invalidResponse).status()).toBe(422);
  await expect(profileDialog.getByRole("alert").filter({ hasText: "Your draft is retained" })).toBeVisible();
  await expect(profileDialog.getByLabel("Name", { exact: true })).toHaveValue("Steps mapping");
  await expect(profileDialog.getByLabel("Steps input", { exact: true })).toHaveValue("seed");
  await profileDialog.getByLabel("Steps input", { exact: true }).selectOption("steps");
  const profiles: GlobalCopyResponse["profiles"] = [];
  const firstResponse = responseFor(page, profilesPath);
  await profileDialog.getByRole("button", { name: "Save", exact: true }).click();
  const first = await firstResponse;
  expect(first.ok(), await first.text()).toBe(true);
  profiles.push(await first.json() as GlobalCopyResponse["profiles"][number]);
  await expect(profileDialog).not.toBeVisible();
  await library.getByRole("button", { name: "New Profile", exact: true }).click();
  await profileDialog.getByLabel("Name", { exact: true }).fill("CFG mapping");
  await mapProfile(profileDialog, "CFG", "cfg");
  const secondResponse = responseFor(page, profilesPath);
  await profileDialog.getByRole("button", { name: "Save", exact: true }).click();
  const second = await secondResponse;
  expect(second.ok(), await second.text()).toBe(true);
  profiles.push(await second.json() as GlobalCopyResponse["profiles"][number]);
  await expect(profileDialog).not.toBeVisible();
  expect(new Set(profiles.map((item) => item.workflow_profile.id)).size).toBe(2);
  for (const [index, input] of ["steps", "cfg"].entries()) {
    expect(profiles[index].version.workflow_version_id).toBe(source.version.id);
    expect(profiles[index].version.profile).toMatchObject({
      mappings: {
        prompt: { node_id: "1", input_name: "text", value_type: "string" },
        seed: { node_id: "2", input_name: "seed", value_type: "integer" },
        output_prefix: { node_id: "3", input_name: "filename_prefix", value_type: "string" },
      }, image_inputs: [], parameters: [{ key: input, label: index ? "CFG" : "Steps", node_id: "2", input_name: input, value_type: "integer" }],
    });
  }
  expect(calls.filter((call) => call.method === "POST" && call.path === "/api/library/workflows")).toHaveLength(1);
  await expect(library.getByRole("region", { name: "Workflow History", exact: true })).toHaveCount(0);
  await expect(library.getByRole("region", { name: "Profile History", exact: true })).toHaveCount(0);
  await expect(library.getByRole("button", { name: /^Revision / })).toHaveCount(0);
  expect(calls.filter((call) => call.method === "GET" && call.path.endsWith("/versions"))).toEqual([]);

  // Only now create a destination Project. Its setup is copied through the UI before source edits.
  const destination = await seed(request, false);
  await page.reload();
  const navigation = page.getByRole("navigation", { name: "Workspace" });
  await navigation.getByRole("button", { name: "Batch", exact: true }).click();
  await expect(page.getByLabel("Active Project")).toHaveValue("");
  await page.getByLabel("Active Project").selectOption(destination.project.id);
  await page.getByLabel("Saved Batch", { exact: true }).selectOption(destination.batch.id);
  await page.getByRole("button", { name: "Discard and switch", exact: true }).click();
  await navigation.getByRole("button", { name: "Workflow Library", exact: true }).click();
  await library.getByRole("button", { name, exact: true }).click();
  await library.getByRole("button", { name: "Use in this Project", exact: true }).click();
  const copyDialog = page.getByRole("dialog", { name: "Review Project copy" });
  await copyDialog.getByRole("checkbox", { name: "Steps mapping", exact: true }).check();
  await copyDialog.getByRole("checkbox", { name: "CFG mapping", exact: true }).check();
  const copiedResponse = responseFor(page, "/api/library/workflows/use-in-project");
  await copyDialog.getByRole("button", { name: "Confirm copy", exact: true }).click();
  const copyResponse = await copiedResponse;
  expect(copyResponse.ok(), await copyResponse.text()).toBe(true);
  const copied = await copyResponse.json() as ProjectCopyResponse;
  expect(copyResponse.request().postDataJSON()).toMatchObject({ project_id: destination.project.id, workflow_version_id: source.version.id });
  expect(copied.workflow.version.workflow).toEqual(workflow);
  expect(copied.workflow.workflow.id).not.toBe(source.workflow.id);
  expect(copied.workflow.version.id).not.toBe(source.version.id);
  for (const original of profiles) {
    const copy = copied.profiles.find((item) => item.workflow_profile.name === original.workflow_profile.name)!;
    expect(copy.workflow_profile.id).not.toBe(original.workflow_profile.id);
    expect(copy.version.id).not.toBe(original.version.id);
    expect(copy.version.workflow_version_id).toBe(copied.workflow.version.id);
    for (const field of ["mappings", "image_inputs", "parameters"]) expect(copy.version.profile[field]).toEqual(original.version.profile[field]);
  }
  const stepsCopy = copied.profiles.find((item) => item.workflow_profile.name === "Steps mapping")!;
  await copyDialog.getByRole("combobox", { name: "Copied Profile to apply", exact: true }).selectOption(stepsCopy.version.id);
  page.once("dialog", async (confirmation) => {
    expect(confirmation.message()).toContain("Replace the Batch Workflow Setup");
    await confirmation.accept();
  });
  await copyDialog.getByRole("button", { name: "Use copied setup", exact: true }).click();
  await expect(copyDialog).not.toBeVisible();
  await navigation.getByRole("button", { name: "Workflow Library", exact: true }).click();
  await library.getByRole("button", { name: "Steps mapping", exact: true }).click();
  await expect(library.getByRole("region", { name: "Selected Profile" })).toBeVisible();
  await library.getByRole("button", { name: "Edit Workflow", exact: true }).click();
  const editWorkflow = page.getByRole("dialog", { name: "Edit Workflow", exact: true });
  const changedWorkflow = { ...workflow, "2": { ...workflow["2"], inputs: { seed: 1, iterations: 30, cfg: 7 } } };
  await editWorkflow.getByRole("textbox", { name: "Workflow JSON", exact: true }).fill(JSON.stringify(changedWorkflow));
  const revisedResponse = responseFor(page, `/api/library/workflows/${source.workflow.id}/versions`);
  await editWorkflow.getByRole("button", { name: "Save", exact: true }).click();
  const revised = await revisedResponse;
  expect(revised.ok(), await revised.text()).toBe(true);
  const revision = await revised.json() as GlobalWorkflowVersion;
  expect(revision.version_number).toBe(2);
  expect(revision.workflow).toEqual(changedWorkflow);
  const repair = page.getByRole("dialog", { name: "Edit Profile", exact: true });
  await expect(repair).toContainText("Repair missing targets before saving");
  await expect(repair.getByLabel("Steps input", { exact: true })).toHaveValue("steps");
  await expect(repair.getByRole("alert")).toContainText("Input steps is missing from node 2");
  await expect(repair.getByLabel("Steps type", { exact: true })).toHaveValue("integer");
  await repair.getByLabel("Steps input", { exact: true }).selectOption("iterations");
  const repairedResponse = responseFor(page, `/api/library/workflow-profiles/${profiles[0].workflow_profile.id}/versions`);
  await repair.getByRole("button", { name: "Save", exact: true }).click();
  const repaired = await repairedResponse;
  expect(repaired.ok(), await repaired.text()).toBe(true);
  const repairedProfile = await repaired.json() as GlobalProfileVersion;
  expect(repairedProfile.workflow_version_id).toBe(revision.id);
  expect(repairedProfile.profile.mappings).toEqual(profiles[0].version.profile.mappings);
  expect(repairedProfile.profile.parameters).toEqual([{ key: "steps", label: "Steps", node_id: "2", input_name: "iterations", value_type: "integer" }]);
  await expect(library.getByRole("button", { name: "Review mappings for CFG mapping", exact: true })).toBeVisible();
  await expect(library.getByRole("button", { name: "Edit Steps mapping", exact: true })).toBeVisible();

  await library.getByRole("button", { name: "Workflow History", exact: true }).click();
  const history = library.getByRole("region", { name: "Workflow History", exact: true });
  await history.getByRole("button", { name: /^Revision 1 \// }).click();
  await expect(history).toContainText("Viewing revision 1.");
  await expect(library.getByRole("button", { name: "Edit CFG mapping", exact: true })).toBeVisible();
  await history.getByRole("button", { name: /^Revision 2 \// }).click();
  await expect(history).toContainText("Viewing revision 2.");
  await expect(library.getByRole("button", { name: "Review mappings for CFG mapping", exact: true })).toBeVisible();
  await history.getByRole("button", { name: /^Revision 1 \// }).click();
  await expect(history).toContainText("Viewing revision 1.");
  await history.getByRole("button", { name: "Restore Workflow content", exact: true }).click();
  const restoredResponse = responseFor(page, `/api/library/workflows/${source.workflow.id}/versions`);
  await page.getByRole("dialog", { name: `Restore ${name}`, exact: true }).getByRole("button", { name: "Restore", exact: true }).click();
  const restored = await restoredResponse;
  expect(restored.ok(), await restored.text()).toBe(true);
  const restoredVersion = await restored.json() as GlobalWorkflowVersion;
  expect(restoredVersion.version_number).toBe(3);
  expect(restoredVersion.id).not.toBe(source.version.id);
  expect(restoredVersion.workflow).toEqual(workflow);
  expect(restoredVersion.content_sha256).toBe(source.version.content_sha256);
  await expect(history).toContainText("Viewing revision 3.");

  await library.getByRole("button", { name: "Edit Workflow metadata", exact: true }).click();
  const metadata = page.getByRole("dialog", { name: `Edit metadata: ${name}`, exact: true });
  const renamed = `${name} renamed`;
  await metadata.getByLabel("Name", { exact: true }).fill(renamed);
  const renamedResponse = responseFor(page, `/api/library/workflows/${source.workflow.id}`, "PATCH");
  await metadata.getByRole("button", { name: "Save", exact: true }).click();
  expect((await renamedResponse).ok()).toBe(true);
  await expect(library.getByRole("heading", { name: renamed, exact: true })).toBeVisible();
  for (const [button, entryName, path] of [
    ["CFG mapping", "CFG mapping", `/api/library/workflow-profiles/${profiles[1].workflow_profile.id}/archive`],
    ["Workflow", renamed, `/api/library/workflows/${source.workflow.id}/archive`],
  ]) {
    await library.getByRole("button", { name: `Archive ${button}`, exact: true }).click();
    const archivedResponse = responseFor(page, path);
    await page.getByRole("dialog", { name: `Archive ${entryName}`, exact: true }).getByRole("button", { name: "Archive", exact: true }).click();
    expect((await archivedResponse).ok()).toBe(true);
    await expect(library.getByRole("button", { name: entryName, exact: true })).toHaveCount(0);
    await library.getByRole("checkbox", { name: "Show archived entries", exact: true }).check();
    await expect(library.getByRole("button", { name: button === "Workflow" ? `${entryName} (archived)` : entryName, exact: true })).toBeVisible();
    await library.getByRole("button", { name: `Unarchive ${button}`, exact: true }).click();
    const unarchivedResponse = responseFor(page, path);
    await page.getByRole("dialog", { name: `Unarchive ${entryName}`, exact: true }).getByRole("button", { name: "Unarchive", exact: true }).click();
    expect((await unarchivedResponse).ok()).toBe(true);
    await library.getByRole("checkbox", { name: "Show archived entries", exact: true }).uncheck();
    await expect(library.getByRole("button", { name: entryName, exact: true })).toBeVisible();
  }
  for (const version of [source.version, revision, restoredVersion]) {
    expect(await get(request, `/api/library/workflow-versions/${version.id}`)).toEqual(version);
  }
  for (const original of profiles) {
    expect(await get(request, `/api/library/workflow-profile-versions/${original.version.id}`)).toEqual(original.version);
  }
  expect(await get(request, `/api/workflow-versions/${copied.workflow.version.id}`)).toEqual(copied.workflow.version);
  for (const copy of copied.profiles) expect(await get(request, `/api/workflow-profile-versions/${copy.version.id}`)).toEqual(copy.version);
  expect(calls.filter((call) => call.method === "DELETE")).toEqual([]);

  // The explicitly applied Project copy remains selected through every catalog mutation.
  await navigation.getByRole("button", { name: "Batch", exact: true }).click();
  await page.getByRole("group", { name: "Parameters", exact: true }).getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: "Add override for Steps", exact: true }).click();
  await page.getByLabel("Steps override 2", { exact: true }).fill("25");
  const previewResponse = responseFor(page, "/api/batches/preview");
  await page.getByRole("button", { name: "Preview Batch", exact: true }).click();
  const receivedPreview = await previewResponse;
  expect(receivedPreview.ok(), await receivedPreview.text()).toBe(true);
  const sent = receivedPreview.request().postDataJSON() as BatchRequest;
  expect(sent.workflow).toEqual(workflow);
  expect(sent.workflow_profile).toEqual(stepsCopy.version.profile);
  expect(sent.batch_snapshot.workflow_selection.workflow_version_id).toBe(copied.workflow.version.id);
  const preview = await receivedPreview.json() as PreviewResponse;
  expect(preview.job_count).toBe(2);
  expect(preview.jobs).toMatchObject([null, 25].map((value) => ({ seed: 42, resolved_prompt: destination.prompt.version.text, resolved_parameters: [{ parameter_key: "steps", label: "Steps", value }] })));
  const runResponse = responseFor(page, "/api/runs");
  await page.getByRole("button", { name: "Create Run", exact: true }).click();
  const runCreated = await runResponse;
  expect(runCreated.ok()).toBe(true);
  const run = await runCreated.json() as RunCreatedResponse;
  await page.getByRole("button", { name: "Start Run", exact: true }).click();
  await expect(page.getByText("Succeeded", { exact: true })).toBeVisible();
  await expect(page.locator("img.result-image")).toHaveCount(2);
  for (const image of await page.locator("img.result-image").all()) await expect(image).toHaveJSProperty("naturalWidth", 384);
  const frozen = await get<RunResponse>(request, `/api/runs/${run.run_id}`);
  expect(frozen.plan.jobs).toMatchObject(preview.jobs);
  expect(frozen.batch_snapshot.workflow_selection).toEqual(sent.batch_snapshot.workflow_selection);
  await page.screenshot({ path: testInfo.outputPath("authored-copy-results.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("real UI: native authoring focus, dirty Escape and scrollable 320px Profile editor", async ({ page, request }, testInfo) => {
  page.setDefaultTimeout(10_000);
  await page.goto("/?view=workflows");
  const library = page.getByRole("region", { name: "Global Workflow Library" });
  const opener = library.getByRole("button", { name: "New Workflow", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "New Workflow", exact: true });
  await expect(dialog).toBeVisible();
  await testInfo.attach("initial-workflow-focus", {
    body: await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 1500) ?? "No active element"),
    contentType: "text/plain",
  });
  await expect.soft(dialog.getByLabel("Name", { exact: true })).toBeFocused();
  await dialog.getByLabel("Name", { exact: true }).fill(`Focus ${randomUUID().slice(0, 8)}`);
  const workflow = { "1": { class_type: "Test", inputs: { text: "Landscape", seed: 1, filename_prefix: "sandbox", steps: 20 } } };
  await dialog.getByRole("textbox", { name: "Workflow JSON", exact: true }).fill(JSON.stringify(workflow));
  const draft = await dialog.getByRole("textbox", { name: "Workflow JSON", exact: true }).inputValue();
  page.once("dialog", async (confirmation) => {
    expect(confirmation.type()).toBe("confirm");
    expect(confirmation.message()).toBe("Discard unsaved changes?");
    await confirmation.dismiss();
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Workflow JSON", exact: true })).toHaveValue(draft);
  const createdResponse = responseFor(page, "/api/library/workflows");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  const created = await createdResponse;
  expect(created.ok()).toBe(true);
  const source = await created.json() as GlobalCopyResponse["workflow"];
  const profile = page.getByRole("dialog", { name: "New Profile", exact: true });
  async function inspectLayout(label: string) {
    const geometry = await profile.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const form = element.querySelector("form")!;
      const heading = element.querySelector("h2")!.getBoundingClientRect();
      const save = element.querySelector<HTMLButtonElement>(":scope > button[type=submit]")!.getBoundingClientRect();
      const cancel = element.querySelector<HTMLButtonElement>(":scope > button[type=button]")!.getBoundingClientRect();
      const fits = (rect: DOMRect) => rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
      return {
        dialogFits: fits(box) && element.scrollWidth <= element.clientWidth,
        formScrollable: form.scrollHeight > form.clientHeight,
        headingFits: fits(heading), saveFits: fits(save), cancelFits: fits(cancel),
        dialog: box.toJSON(), heading: heading.toJSON(), save: save.toJSON(), cancel: cancel.toJSON(),
        form: { clientHeight: form.clientHeight, scrollHeight: form.scrollHeight, scrollTop: form.scrollTop },
      };
    });
    await testInfo.attach(`profile-editor-${label}-geometry`, { body: JSON.stringify(geometry, null, 2), contentType: "application/json" });
    expect.soft(geometry, `${label}: form scrolls independently while heading, Save and Cancel fit`).toMatchObject({
      dialogFits: true, formScrollable: true, headingFits: true, saveFits: true, cancelFits: true,
    });
  }
  await expect.soft(profile.getByLabel("Name", { exact: true })).toBeFocused();
  await inspectLayout("normal");
  await page.screenshot({ path: testInfo.outputPath("global-create-profile-editor.png") });
  await page.setViewportSize({ width: 320, height: 740 });
  await inspectLayout("320-top");
  await page.screenshot({ path: testInfo.outputPath("global-create-profile-editor-320-top.png") });
  await profile.getByRole("button", { name: "Add Parameter", exact: true }).click();
  await profile.getByLabel("Parameter 1 label", { exact: true }).fill("Steps");
  await profile.getByLabel("Steps node", { exact: true }).selectOption("1");
  await profile.getByLabel("Steps input", { exact: true }).selectOption("steps");
  await profile.getByLabel("Name", { exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(profile.getByRole("textbox", { name: "Description (optional)", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(profile.getByLabel("Name", { exact: true })).toBeFocused();
  expect(await profile.evaluate((element) => element.matches(":modal"))).toBe(true);
  // Native modal inertness prevents focus entering the background application.
  await page.getByRole("button", { name: "Settings", exact: true }).evaluate((element: HTMLElement) => element.focus());
  await expect(profile.getByLabel("Name", { exact: true })).toBeFocused();
  await profile.getByRole("textbox", { name: "Version note (optional)", exact: true }).focus();
  expect(await profile.locator("form").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await profile.getByRole("button", { name: "Cancel", exact: true }).focus();
  await expect(profile.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("global-create-profile-editor-320.png") });
  await inspectLayout("320-scrolled");
  page.once("dialog", async (confirmation) => {
    expect(confirmation.message()).toBe("Discard unsaved changes?");
    await confirmation.dismiss();
  });
  await page.keyboard.press("Escape");
  await expect(profile).toBeVisible();
  await expect(profile.getByLabel("Steps input", { exact: true })).toHaveValue("steps");
  page.once("dialog", async (confirmation) => {
    expect(confirmation.message()).toBe("Discard unsaved changes?");
    await confirmation.accept();
  });
  await profile.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(profile).not.toBeVisible();
  expect(await get(request, `/api/library/workflow-versions/${source.version.id}`)).toEqual(source.version);
  expect((await get<LibraryPage<GlobalProfileFamily>>(request, `/api/library/workflows/${source.workflow.id}/profiles`)).items).toEqual([]);
  await opener.click();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(opener).toBeFocused();
});
