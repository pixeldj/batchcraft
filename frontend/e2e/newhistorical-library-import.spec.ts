import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type {
  CreatePromptResponse, CreateWorkflowResponse, CreateWorkflowProfileResponse,
  GlobalCatalogItem, GlobalCopyResponse, GlobalRunSetup, GlobalRunSetupImportRequest,
  LibraryPage, ProjectResponse, RunCreatedResponse, RunResponse, SavedBatchDetail,
} from "../src/api/types";

const apiUrl = "http://127.0.0.1:8002";
const setupPath = "/api/library/run-setup";
const importPath = "/api/library/workflows/import-run";
const review = (page: Page) => page.getByRole("dialog", { name: "Import to Library", exact: true });
const navigation = (page: Page) => page.getByRole("navigation", { name: "Workspace" });
const recovery = (page: Page) => page.evaluate(() => localStorage.getItem("batchcraft.working-session-recovery.v4"));

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(`${apiUrl}${path}`, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as T;
}

async function get<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`${apiUrl}${path}`);
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as T;
}

function responseFor(page: Page, path: string, method = "POST") {
  return page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === method);
}

// Only the launcher's fresh temporary store is used. Archival is not empty-SQLite portability;
// the committed v1 fixture and filesystem byte preservation are covered by backend API tests.
async function seedRun(page: Page, request: APIRequestContext) {
  const suffix = randomUUID().slice(0, 8);
  const project = await post<ProjectResponse>(request, "/api/projects", {
    name: `Historical ${suffix}`, filesystem_key: `historical_${suffix}`,
  });
  const prompt = await post<CreatePromptResponse>(request, `/api/projects/${project.id}/prompts`, {
    name: "Compiled prompt", text: "A {{subject}} at sunset",
  });
  const workflow = await post<CreateWorkflowResponse>(request, `/api/projects/${project.id}/workflows`, {
    name: `Frozen workflow ${suffix}`,
    workflow: {
      "1": { class_type: "CLIPTextEncode", inputs: { text: "Original base prompt" } },
      "2": { class_type: "KSampler", inputs: { seed: 1, steps: 20, cfg: 7 } },
      "3": { class_type: "SaveImage", inputs: { filename_prefix: "original_base" } },
    },
  });
  const profile = await post<CreateWorkflowProfileResponse>(request, `/api/workflows/${workflow.workflow.id}/profiles`, {
    name: `Frozen profile ${suffix}`, workflow_version_id: workflow.version.id,
    mappings: {
      prompt: { node_id: "1", input_name: "text", value_type: "string" },
      seed: { node_id: "2", input_name: "seed", value_type: "integer" },
      output_prefix: { node_id: "3", input_name: "filename_prefix", value_type: "string" },
    },
    image_inputs: [], parameters: [{ key: "cfg", label: "CFG", node_id: "2", input_name: "cfg", value_type: "float" }],
  });
  const batch = await post<SavedBatchDetail>(request, `/api/projects/${project.id}/batches`, {
    name: "Historical import", filesystem_key: "historical_import",
    prompt_selections: [{ prompt_version_id: prompt.version.id, name_snapshot: prompt.version.name_snapshot, text: prompt.version.text }],
    variable_bindings: [{ placeholder: "subject", values: ["mountain"] }], image_bindings: [],
    parameter_bindings: [{ parameter_key: "cfg", mode: "values", values: [2] }], linked_parameter_sets: [],
    seed_intent: { mode: "fixed", values: [99], random_seed_count: null },
    selected_workflow_version: { id: workflow.version.id, content_sha256: workflow.version.content_sha256, workflow: workflow.version.workflow },
    selected_workflow_profile_id: profile.workflow_profile.id,
    selected_workflow_profile_version: {
      id: profile.version.id, workflow_profile_id: profile.workflow_profile.id, workflow_version_id: workflow.version.id,
      content_sha256: profile.version.content_sha256, profile: profile.version.profile,
    },
  });
  await page.goto("/");
  await page.getByLabel("Active Project").selectOption(project.id);
  await expect(page.getByLabel("Active Project")).toHaveValue(project.id);
  await page.getByLabel("Saved Batch", { exact: true }).selectOption(batch.id);
  await page.getByRole("button", { name: "Discard and switch", exact: true }).click();
  // Switching loads the Saved Batch asynchronously; Preview must use the loaded draft.
  await expect(page.getByRole("dialog", { name: "Switch Batch?", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Saved Batch", { exact: true })).toHaveValue(batch.id);
  await page.getByRole("button", { name: "Preview Batch", exact: true }).click();
  await page.getByLabel(/^Run Name/).fill(`Frozen experiment ${suffix}`);
  const created = responseFor(page, "/api/runs");
  await page.getByRole("button", { name: "Create Run", exact: true }).click();
  const run = await (await created).json() as RunCreatedResponse;
  await page.getByRole("button", { name: "Start Run", exact: true }).click();
  await expect(page.getByText("Succeeded", { exact: true })).toBeVisible();
  await expect(page.locator("img.result-image")).toHaveJSProperty("naturalWidth", 384);
  const frozen = await get<RunResponse>(request, `/api/runs/${run.run_id}`);
  expect(frozen.plan.jobs).toMatchObject([{ seed: 99, resolved_prompt: "A mountain at sunset", resolved_parameters: [{ parameter_key: "cfg", value: 2 }] }]);
  expect(frozen.plan.job_count).toBe(1);
  await post(request, `/api/workflow-profiles/${profile.workflow_profile.id}/archive`, {});
  await post(request, `/api/workflows/${workflow.workflow.id}/archive`, {});
  const setup = await get<GlobalRunSetup>(request, `${setupPath}?run_id=${run.run_id}`);
  expect(setup.workflow).toEqual(workflow.version.workflow);
  expect(setup.profile).toEqual(profile.version.profile);
  return { project, workflow, profile, batch, run, frozen, setup };
}

function assertCopy(receipt: GlobalCopyResponse, body: GlobalRunSetupImportRequest, setup: GlobalRunSetup) {
  expect(body).toEqual({
    request_id: expect.any(String), run_id: setup.run_id, name: body.name, profile_name: body.profile_name,
    expected_workflow_sha256: setup.source.workflow.content_sha256,
    expected_profile_sha256: setup.source.profiles[0].content_sha256,
  });
  expect(receipt.request_id).toBe(body.request_id);
  expect(receipt.source).toEqual(setup.source);
  expect(receipt.workflow.workflow.name).toBe(body.name);
  expect(receipt.workflow.version.workflow).toEqual(setup.workflow);
  expect(receipt.workflow.version.workflow).toMatchObject({
    "1": { inputs: { text: "Original base prompt" } }, "2": { inputs: { seed: 1, cfg: 7 } },
    "3": { inputs: { filename_prefix: "original_base" } },
  });
  expect(receipt.profiles).toHaveLength(1);
  const copy = receipt.profiles[0];
  expect(copy.workflow_profile.name).toBe(body.profile_name);
  expect(copy.version.workflow_version_id).toBe(receipt.workflow.version.id);
  expect(copy.version.profile.id).not.toBe(setup.profile.id);
  for (const field of ["mappings", "image_inputs", "parameters"]) expect(copy.version.profile[field]).toEqual(setup.profile[field]);
}

test("historical import: Run Plan and nested Result Details copy the base pair without changing the Batch", async ({ page, request }, testInfo) => {
  const source = await seedRun(page, request);
  const calls: Array<{ path: string; method: string }> = [];
  page.on("request", (sent) => calls.push({ path: new URL(sent.url()).pathname, method: sent.method() }));
  await page.getByRole("button", { name: "Preview Batch", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Create (Another )?Run$/ })).toBeEnabled();
  const before = await recovery(page);
  await navigation(page).getByRole("button", { name: "Runs", exact: true }).click();
  const browser = page.getByRole("region", { name: "Project browser" });
  await browser.getByRole("button", { name: "View Run Plan", exact: true }).click();
  const plan = page.getByRole("dialog", { name: / Plan$/ });
  const opener = plan.getByRole("button", { name: "Import to Library", exact: true });
  const loaded = responseFor(page, setupPath, "GET");
  await opener.click();
  expect(await (await loaded).json()).toEqual(source.setup);
  await expect(review(page).getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await expect(review(page).getByRole("textbox")).toHaveCount(0);
  await expect(review(page)).toContainText(source.setup.run_name!);
  await expect(review(page)).toContainText(source.workflow.workflow.name);
  await expect(review(page)).toContainText(source.profile.workflow_profile.name);
  await expect(review(page).locator(".field-help")).toHaveText("Copies the base setup, not Job overrides.");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await review(page).evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight && element.scrollWidth <= element.clientWidth;
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`historical-import-initial-${width}.png`), scale: "css" });
  }
  await page.keyboard.press("Escape");
  await expect(review(page)).toHaveCount(0);
  await expect(plan).toBeVisible();
  await expect(opener).toBeFocused();
  await opener.click();
  // A real catalog collision, not a fabricated import response.
  await post(request, "/api/library/workflows", { request_id: randomUUID(), name: source.setup.workflow_name, workflow: source.setup.workflow });
  const conflictResponse = responseFor(page, importPath);
  await review(page).getByRole("button", { name: "Import to Library", exact: true }).click();
  const conflict = await conflictResponse;
  expect(conflict.status()).toBe(409);
  await expect(review(page).getByRole("alert")).toContainText("Check names or reload setup.");
  await expect(review(page).getByLabel("Workflow name", { exact: true })).toHaveValue(source.setup.workflow_name!);
  await expect(review(page).getByLabel("Profile name", { exact: true })).toHaveValue(source.setup.profile_name!);
  await page.screenshot({ path: testInfo.outputPath("historical-import-collision.png"), scale: "css" });
  const name = `Plan copy ${source.project.id}`;
  await review(page).getByLabel("Workflow name", { exact: true }).fill(name);
  await review(page).getByLabel("Profile name", { exact: true }).fill("Plan mappings");
  const importedResponse = responseFor(page, importPath);
  await review(page).getByRole("button", { name: "Import to Library", exact: true }).click();
  const imported = await importedResponse;
  expect(imported.ok(), await imported.text()).toBe(true);
  const body = imported.request().postDataJSON() as GlobalRunSetupImportRequest;
  expect(body.request_id).not.toBe(conflict.request().postDataJSON().request_id);
  const receipt = await imported.json() as GlobalCopyResponse;
  assertCopy(receipt, body, source.setup);
  await expect(review(page).getByRole("status")).toHaveText("Imported to Library.");
  await page.screenshot({ path: testInfo.outputPath("historical-import-success.png"), scale: "css" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: testInfo.outputPath("historical-import-success-1440.png"), scale: "css" });
  await page.setViewportSize({ width: 390, height: 900 });
  await review(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(opener).toBeFocused();
  await page.keyboard.press("Escape");
  await navigation(page).getByRole("button", { name: "Batch", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Create (Another )?Run$/ })).toBeEnabled();
  expect(await recovery(page)).toBe(before);
  expect(calls.filter((call) => call.path === "/api/batches/preview")).toHaveLength(1);
  expect(calls.filter((call) => /\/projects\/[^/]+\/workflows|\/workflows\/[^/]+\/profiles/.test(call.path))).toEqual([]);
  expect(calls.filter((call) => call.method !== "GET" && call.path !== importPath && call.path !== "/api/batches/preview" && !call.path.endsWith("/reindex"))).toEqual([]);

  // A cold page starts a separate explicit import, rather than reusing the first receipt.
  await page.reload();
  await expect(page.getByLabel("Active Project")).toHaveValue(source.project.id);
  await navigation(page).getByRole("button", { name: "Workflow Library", exact: true }).click();
  await page.getByLabel("Search Workflow Library").fill("No matching historical copy");
  await page.getByLabel("Search Workflow Library").press("Enter");
  await expect(page).toHaveURL((url) => url.searchParams.get("library_q") === "No matching historical copy");
  await navigation(page).getByRole("button", { name: "Gallery", exact: true }).click();
  await expect(browser.locator(".pb-image-button img")).toHaveJSProperty("naturalWidth", 384);
  await browser.locator(".pb-image-button").click();
  const viewer = page.getByRole("dialog", { name: "Project Result image", exact: true });
  const detailsTrigger = viewer.getByRole("button", { name: "Image Details", exact: true });
  await detailsTrigger.click();
  const details = page.getByRole("dialog", { name: /^Job .*Artifact 1$/ });
  const detailsImport = details.getByRole("button", { name: "Import to Library", exact: true });
  const coldDraft = await recovery(page);
  await detailsImport.click();
  await expect(review(page).getByRole("button", { name: "Import to Library", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(detailsImport).toBeFocused();
  await expect(viewer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  await expect(detailsTrigger).toBeFocused();
  await detailsTrigger.click();
  await detailsImport.click();
  for (const [label, value] of [["Workflow name", `Result copy ${source.project.id}`], ["Profile name", "Result mappings"]]) {
    await review(page).getByRole("button", { name: `Rename ${label}`, exact: true }).click();
    await review(page).getByLabel(label, { exact: true }).fill(value);
  }
  await page.screenshot({ path: testInfo.outputPath("historical-import-nested-renames.png"), scale: "css" });
  const resultResponse = responseFor(page, importPath);
  await review(page).getByRole("button", { name: "Import to Library", exact: true }).click();
  const result = await resultResponse;
  expect(result.ok()).toBe(true);
  const resultBody = result.request().postDataJSON() as GlobalRunSetupImportRequest;
  const resultReceipt = await result.json() as GlobalCopyResponse;
  assertCopy(resultReceipt, resultBody, source.setup);
  expect(resultBody.request_id).not.toBe(body.request_id);
  expect(resultReceipt.workflow.workflow.id).not.toBe(receipt.workflow.workflow.id);
  expect(resultReceipt.profiles[0].workflow_profile.id).not.toBe(receipt.profiles[0].workflow_profile.id);
  await review(page).getByRole("button", { name: "Open Workflow Library", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(navigation(page).getByRole("button", { name: "Workflow Library", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByLabel("Search Workflow Library")).toHaveValue("");
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
  expect(await recovery(page)).toBe(coldDraft);
  expect(await get(request, `/api/runs/${source.run.run_id}`)).toEqual(source.frozen);
});

test("historical import: cancelled reads and a lost committed response preserve the retry receipt", async ({ page, request }) => {
  const source = await seedRun(page, request);
  await page.getByRole("button", { name: "View Run Plan", exact: true }).click();
  const plan = page.getByRole("dialog", { name: / Plan$/ });
  const opener = plan.getByRole("button", { name: "Import to Library", exact: true });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let readFinished!: () => void;
  const cancelledRead = new Promise<void>((resolve) => { readFinished = resolve; });
  await page.route(`**${setupPath}?*`, async (route) => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
    readFinished();
  }, { times: 1 });
  await opener.click();
  await expect(review(page).getByRole("status")).toHaveText("Loading frozen setup...");
  await review(page).getByRole("button", { name: "Cancel", exact: true }).click();
  release();
  // Drain the cancelled interception before starting another one (localhost fetches
  // can outlive the UI assertions in the built serving mode).
  await cancelledRead;
  await expect(plan).toBeVisible();
  await expect(opener).toBeFocused();
  await expect(review(page)).toHaveCount(0);
  await opener.click();
  await expect(review(page).getByRole("button", { name: "Import to Library", exact: true })).toBeEnabled();
  const attempts: GlobalRunSetupImportRequest[] = [];
  let committed: GlobalCopyResponse | undefined;
  await page.route(`**${importPath}`, async (route) => {
    attempts.push(route.request().postDataJSON() as GlobalRunSetupImportRequest);
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    committed = await response.json() as GlobalCopyResponse;
    await route.abort("failed");
  }, { times: 1 });
  const before = await recovery(page);
  await review(page).getByRole("button", { name: "Import to Library", exact: true }).click();
  await expect(review(page).getByRole("alert")).toBeVisible();
  expect(committed).toBeDefined();
  assertCopy(committed!, attempts[0], source.setup);
  await review(page).getByRole("button", { name: "Cancel", exact: true }).click();
  let additionalReads = 0;
  // Simulate unavailable review transport, not deletion of real source files.
  await page.route(`**${setupPath}?*`, async (route) => {
    additionalReads++;
    await route.fulfill({ status: 404, json: { detail: "Source unavailable" } });
  });
  await opener.click();
  await expect(review(page).getByLabel("Workflow name", { exact: true })).toHaveValue(attempts[0].name);
  const retriedResponse = responseFor(page, importPath);
  await review(page).getByRole("button", { name: "Import to Library", exact: true }).click();
  const retried = await retriedResponse;
  expect(retried.ok()).toBe(true);
  expect(retried.request().postDataJSON()).toEqual(attempts[0]);
  expect(await retried.json()).toEqual(committed);
  await expect(review(page).getByRole("status")).toHaveText("Imported to Library.");
  expect(additionalReads).toBe(0);
  const catalog = await get<LibraryPage<GlobalCatalogItem>>(request, `/api/library/workflows?q=${encodeURIComponent(attempts[0].name)}`);
  expect(catalog.items.map((item) => item.id)).toEqual([committed!.workflow.workflow.id]);
  expect(await recovery(page)).toBe(before);
  expect(await get(request, `/api/runs/${source.run.run_id}`)).toEqual(source.frozen);

  // A fresh review loses another real committed response. Editing and reverting a name
  // must create a new operation, which collides rather than replaying the old receipt.
  await page.unroute(`**${setupPath}?*`);
  await page.reload();
  await page.getByRole("button", { name: "View Run Plan", exact: true }).click();
  await opener.click();
  await review(page).getByRole("button", { name: "Rename Workflow name", exact: true }).click();
  const editedName = `Edited retry ${source.project.id}`;
  await review(page).getByLabel("Workflow name", { exact: true }).fill(editedName);
  await page.route(`**${importPath}`, async (route) => {
    attempts.push(route.request().postDataJSON() as GlobalRunSetupImportRequest);
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    await route.abort("failed");
  }, { times: 1 });
  await review(page).getByRole("button", { name: "Import to Library", exact: true }).click();
  await expect(review(page).getByRole("alert")).toBeVisible();
  await review(page).getByLabel("Workflow name", { exact: true }).fill(`${editedName} changed`);
  await review(page).getByLabel("Workflow name", { exact: true }).fill(editedName);
  const changedResponse = responseFor(page, importPath);
  await review(page).getByRole("button", { name: "Import to Library", exact: true }).click();
  const changed = await changedResponse;
  expect(changed.status()).toBe(409);
  const changedBody = changed.request().postDataJSON() as GlobalRunSetupImportRequest;
  expect(changedBody).toEqual({ ...attempts[1], request_id: expect.any(String) });
  expect(changedBody.request_id).not.toBe(attempts[1].request_id);
  const editedCopies = await get<LibraryPage<GlobalCatalogItem>>(request, `/api/library/workflows?q=${encodeURIComponent(editedName)}`);
  expect(editedCopies.items).toHaveLength(1);
});

test("historical import: failed full inspection falls back to real frozen setup and rejects mismatched identity", async ({ page, request }) => {
  const source = await seedRun(page, request);
  // Clear only this isolated browser's monitor pointer so history performs an uncached read.
  await page.addInitScript(() => {
    const key = "batchcraft.working-session-recovery.v4";
    const saved = JSON.parse(localStorage.getItem(key)!);
    saved.current_run_id = null;
    saved.session_run_ids = [];
    localStorage.setItem(key, JSON.stringify(saved));
  });
  await page.route(`**/api/runs/${source.run.run_id}`, (route) => route.fulfill({
    status: 500, json: { detail: "Full Run inspection unavailable" },
  }));
  await page.reload();
  await expect(page.getByLabel("Active Project")).toHaveValue(source.project.id);
  const calls: string[] = [];
  page.on("request", (sent) => calls.push(new URL(sent.url()).pathname));
  await navigation(page).getByRole("button", { name: "Runs", exact: true }).click();
  await page.getByRole("region", { name: "Project browser" }).getByRole("button", { name: "View Run Plan", exact: true }).click();
  const inspection = page.getByRole("dialog", { name: "History inspection", exact: true });
  await expect(inspection.getByRole("alert")).toContainText("Inspection unavailable");
  await page.route(`**${setupPath}?*`, async (route) => {
    const response = await route.fetch();
    const setup = await response.json() as GlobalRunSetup;
    await route.fulfill({ response, json: { ...setup, run_id: "wrong-run" } });
  }, { times: 1 });
  await inspection.getByRole("button", { name: "Import frozen setup", exact: true }).click();
  await expect(review(page).getByRole("alert")).toContainText("did not match the selected Run or Project");
  await expect(review(page).getByRole("button", { name: "Import to Library", exact: true })).toBeDisabled();
  expect(calls.filter((path) => path === importPath)).toEqual([]);
  const loaded = responseFor(page, setupPath, "GET");
  await review(page).getByRole("button", { name: "Reload setup", exact: true }).click();
  expect(await (await loaded).json()).toEqual(source.setup);
  const importedResponse = responseFor(page, importPath);
  await review(page).getByRole("button", { name: "Import to Library", exact: true }).click();
  const imported = await importedResponse;
  expect(imported.ok()).toBe(true);
  assertCopy(await imported.json() as GlobalCopyResponse, imported.request().postDataJSON() as GlobalRunSetupImportRequest, source.setup);
  await expect(review(page).getByRole("status")).toHaveText("Imported to Library.");
  expect(calls.filter((path) => /\/projects\/[^/]+\/workflows|\/workflows\/[^/]+\/profiles/.test(path))).toEqual([]);
  expect(calls.filter((path) => path.endsWith("/results"))).toEqual([]);
  await review(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(inspection.getByRole("button", { name: "Import frozen setup", exact: true })).toBeFocused();
});
