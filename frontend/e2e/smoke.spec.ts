import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";

import type {
  CreatePromptResponse,
  CreateWorkflowResponse,
  CreateWorkflowProfileResponse,
  ProjectResponse,
  SavedBatchDetail,
  RunCreatedResponse,
  ExecutionResponse,
  PreviewResponse,
} from "../src/api/types";

const apiUrl = "http://127.0.0.1:8002";

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(`${apiUrl}${path}`, { data });
  expect(response.ok(), await response.text()).toBeTruthy();
  return await response.json() as T;
}

async function seed(request: APIRequestContext, subject = "mountain", provenance = false) {
  const suffix = randomUUID().slice(0, 8);
  const project = await post<ProjectResponse>(request, "/api/projects", {
    name: `Browser ${suffix}`, filesystem_key: `browser_${suffix}`,
  });
  const prompt = await post<CreatePromptResponse>(request, `/api/projects/${project.id}/prompts`, {
    name: "Landscape", text: "A {{subject}} at sunset",
  });
  const workflow = await post<CreateWorkflowResponse>(request, `/api/projects/${project.id}/workflows`, {
    name: "Sandbox workflow",
    workflow: {
      "1": { class_type: "CLIPTextEncode", inputs: { text: "Landscape" } },
      "2": { class_type: "KSampler", inputs: { seed: 1, steps: 20, cfg: 7 } },
      "3": { class_type: "SaveImage", inputs: { filename_prefix: "sandbox" } },
    },
  });
  const profile = await post<CreateWorkflowProfileResponse>(request, `/api/workflows/${workflow.workflow.id}/profiles`, {
    name: "Sandbox profile", workflow_version_id: workflow.version.id,
    mappings: {
      prompt: { node_id: "1", input_name: "text", value_type: "string" },
      seed: { node_id: "2", input_name: "seed", value_type: "integer" },
      output_prefix: { node_id: "3", input_name: "filename_prefix", value_type: "string" },
    },
    image_inputs: [],
    parameters: [
      { key: "steps", label: "Steps", node_id: "2", input_name: "steps", value_type: "integer" },
      { key: "cfg", label: "CFG", node_id: "2", input_name: "cfg", value_type: "float" },
    ],
  });
  const batch = await post<SavedBatchDetail>(request, `/api/projects/${project.id}/batches`, {
    name: "Browser smoke", filesystem_key: "browser_smoke",
    prompt_selections: [{
      prompt_version_id: prompt.version.id,
      name_snapshot: prompt.version.name_snapshot, text: prompt.version.text,
    }],
    variable_bindings: [{ placeholder: "subject", values: provenance ? [subject] : [subject, "river"] }],
    image_bindings: [],
    parameter_bindings: [
      { parameter_key: "steps", mode: "values", values: provenance ? [null, 20] : [null] },
      { parameter_key: "cfg", mode: "values", values: [null] },
    ],
    linked_parameter_sets: [],
    seed_intent: provenance
      ? { mode: "random", values: [], random_seed_count: 1 }
      : { mode: "fixed", values: [42], random_seed_count: null },
    selected_workflow_version: {
      id: workflow.version.id, content_sha256: workflow.version.content_sha256,
      workflow: workflow.version.workflow,
    },
    selected_workflow_profile_id: profile.workflow_profile.id,
    selected_workflow_profile_version: {
      id: profile.version.id, workflow_profile_id: profile.workflow_profile.id,
      workflow_version_id: workflow.version.id,
      content_sha256: profile.version.content_sha256, profile: profile.version.profile,
    },
  });
  return { project, batch };
}

test("real API: typed HistoryFilters distinguish Base and override on the same Job and roundtrip without changing draft", async ({ page, request }, testInfo) => {
  const { project, batch } = await seed(request, "mountain", true);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let reindexPosts = 0;
  const diagnosticRequests: URL[] = [];
  page.on("request", (sent) => {
    const url = new URL(sent.url());
    if (url.pathname === `/api/projects/${project.id}/reindex` && sent.method() === "POST") reindexPosts++;
    if (url.pathname === `/api/projects/${project.id}/history/diagnostics`) {
      expect(sent.method()).toBe("GET");
      diagnosticRequests.push(url);
    }
  });
  await page.goto("/");
  await page.getByLabel("Active Project").selectOption(project.id);
  await page.getByLabel("Saved Batch", { exact: true }).selectOption(batch.id);
  await page.getByRole("button", { name: "Discard and switch", exact: true }).click();
  const previewResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/batches/preview");
  await page.getByRole("button", { name: "Preview Batch", exact: true }).click();
  const preview = await (await previewResponse).json() as PreviewResponse;
  expect(preview.job_count).toBe(2);
  const base = preview.jobs.find((job) => job.resolved_parameters.find((p) => p.parameter_key === "steps")?.value === null)!;
  const override = preview.jobs.find((job) => job.resolved_parameters.find((p) => p.parameter_key === "steps")?.value === 20)!;
  expect(base.seed).not.toBe(override.seed);
  await page.getByLabel(/^Run Name/).fill("Base and equal override");
  const created = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/runs" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Create Run", exact: true }).click();
  const run = await (await created).json() as RunCreatedResponse;
  await page.getByRole("button", { name: "Start Run", exact: true }).click();
  await expect(page.getByText("Succeeded", { exact: true })).toBeVisible();

  // This unsaved authoring change must survive review navigation and cold reload.
  await page.getByRole("group", { name: "Seeds", exact: true }).getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("combobox", { name: "Seed mode", exact: true }).selectOption("fixed");
  await page.getByRole("spinbutton", { name: /^Seed / }).fill("987654");
  await page.getByRole("button", { name: "Preview Batch", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Create (Another )?Run$/ })).toBeEnabled();
  await page.getByLabel(/^Run Name/).fill("Unpublished draft - keep me");
  const nav = page.getByRole("navigation", { name: "Workspace" });
  const browser = page.getByRole("region", { name: "Project browser" });
  const dialog = page.getByRole("dialog", { name: "Find the exact experiment", exact: true });
  const add = browser.getByRole("button", { name: "+ Add filter", exact: true });
  const parameterChip = browser.getByRole("button", { name: /^Edit .*\(integer\):/ });
  const filters = () => JSON.parse(new URL(page.url()).searchParams.get("filters") ?? "{}");
  const details = page.getByRole("dialog", { name: /^Job \d+ .* Artifact 1$/ });
  const currentResults = page.locator("#current-run-workspace").getByRole("region", { name: "Results", exact: true });
  const currentLightbox = page.getByRole("dialog", { name: "Result image preview", exact: true });
  const recovery = () => page.evaluate(() => localStorage.getItem("batchcraft.working-session-recovery.v4"));
  await expect.poll(async () => JSON.parse((await recovery())!).draft.seedValues).toBe("987654");
  const draftBeforeReview = await recovery();
  expect(JSON.parse(draftBeforeReview!).current_run_id).toBe(run.run_id);

  // These entry points belong to the mounted current Run, not ProjectBrowser Details.
  for (const job of [base, override]) {
    const trigger = currentResults.getByRole("button", { name: `Details for Job ${job.ordinal}, artifact 1`, exact: true });
    await trigger.click();
    await expect(details.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(details).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.press("Enter");
    await details.getByRole("button", { name: "Filter Gallery by Steps (integer)", exact: true }).click();
    const parameter = job === base
      ? { key: "steps", value_type: "integer", mode: "base" }
      : { key: "steps", value_type: "integer", mode: "equals", value: 20 };
    await expect(details).toHaveCount(0);
    await expect(nav.getByRole("button", { name: "Gallery", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page).toHaveURL((url) => url.searchParams.get("view") === "gallery" && !url.searchParams.has("run"));
    expect(filters()).toEqual({ parameters: [parameter] });
    await expect(browser.locator(".pb-result")).toHaveCount(1);
    await expect(browser.getByRole("button", { name: new RegExp(`^Details for .*Job ${job.ordinal}, artifact 1:`) })).toBeVisible();
    const identity = await browser.locator(".pb-result").getAttribute("data-result-identity");
    const strip = page.getByRole("region", { name: "Current Run", exact: true });
    await expect(strip).toContainText(project.name);
    await expect(strip).toContainText("Base and equal override");
    await expect(strip.getByText("succeeded", { exact: true })).toBeVisible();
    await strip.getByRole("button", { name: "View current Run", exact: true }).click();
    await expect(page.getByLabel("Active Project")).toHaveValue(project.id);

    const image = currentResults.locator(".result-card").filter({
      has: page.getByRole("button", { name: `Details for Job ${job.ordinal}, artifact 1`, exact: true }),
    }).locator(".result-image-button");
    await image.click();
    await expect(currentLightbox.locator("img")).toHaveJSProperty("naturalWidth", 384);
    await expect(currentLightbox.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    const nestedTrigger = currentLightbox.getByRole("button", { name: /Details/ });
    await nestedTrigger.click();
    await expect(details.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(details).toHaveCount(0);
    await expect(currentLightbox).toBeVisible();
    await expect(nestedTrigger).toBeFocused();
    await nestedTrigger.press("Enter");
    await page.screenshot({ path: testInfo.outputPath(`current-run-filter-${job === base ? "base" : "override"}.png`), scale: "css" });
    await details.getByRole("button", { name: "Filter Gallery by Seed", exact: true }).click();
    await expect(details).toHaveCount(0);
    await expect(currentLightbox).toHaveCount(0);
    await expect(page.locator("[data-overlay-level]")).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
    await expect(nav.getByRole("button", { name: "Gallery", exact: true })).toHaveAttribute("aria-current", "page");
    expect(filters()).toEqual({ parameters: [parameter], seed: job.seed });
    expect(new URL(page.url()).searchParams.has("run")).toBe(false);
    await expect(browser.locator(".pb-result")).toHaveCount(1);
    await expect(browser.locator(".pb-result")).toHaveAttribute("data-result-identity", identity!);
    expect(await page.evaluate(() => document.activeElement?.closest("#current-run-workspace, dialog") === null)).toBe(true);
    // Navigation must leave the visible destination keyboard-operable, not trapped in hidden inspection.
    await page.keyboard.press("Tab");
    if (await page.evaluate(() => !document.hasFocus() && document.activeElement === document.body)) {
      await page.keyboard.press("Tab");
    }
    expect(await page.evaluate(() => document.activeElement instanceof HTMLElement
      && document.activeElement !== document.body && document.activeElement.checkVisibility()
      && document.activeElement.closest("#current-run-workspace, dialog") === null)).toBe(true);
    await browser.getByRole("button", { name: "Clear advanced", exact: true }).click();
    await expect(browser.locator(".pb-result")).toHaveCount(2);
    await strip.getByRole("button", { name: "View current Run", exact: true }).click();
    await expect(page.getByLabel("Active Project")).toHaveValue(project.id);
    await expect(page.getByLabel("Saved Batch", { exact: true })).toHaveValue(batch.id);
    await expect(page.getByRole("spinbutton", { name: /^Seed / })).toHaveValue("987654");
    await expect(page.getByLabel(/^Run Name/)).toHaveValue("Unpublished draft - keep me");
    await expect(page.getByRole("button", { name: /^Create (Another )?Run$/ })).toBeEnabled();
    await expect(currentResults.locator(".result-card")).toHaveCount(2);
    expect(await recovery()).toBe(draftBeforeReview);
  }
  await nav.getByRole("button", { name: "Gallery", exact: true }).click();
  await expect(browser.locator(".pb-result")).toHaveCount(2);
  await expect(browser.locator(".pb-image-button img").first()).toHaveJSProperty("naturalWidth", 384);
  const lightbox = page.getByRole("dialog", { name: "Project Result image", exact: true });
  for (const job of [base, override]) {
    const card = browser.locator(".pb-result").filter({
      has: page.getByRole("button", { name: new RegExp(`^Details for .*Job ${job.ordinal}, artifact 1:`) }),
    });
    const identity = await card.getAttribute("data-result-identity");
    await card.getByRole("button", { name: /^Details for / }).click();
    await details.getByRole("button", { name: "Filter Gallery by Steps (integer)", exact: true }).click();
    await expect(details).toHaveCount(0);
    await expect(nav.getByRole("button", { name: "Gallery", exact: true })).toHaveAttribute("aria-current", "page");
    const parameter = job === base
      ? { key: "steps", value_type: "integer", mode: "base" }
      : { key: "steps", value_type: "integer", mode: "equals", value: 20 };
    expect(filters()).toEqual({ parameters: [parameter] });
    await expect(browser.locator(".pb-result")).toHaveCount(1);
    await expect(browser.locator(".pb-result")).toHaveAttribute("data-result-identity", identity!);
    await browser.locator(".pb-image-button").click();
    await expect(lightbox).toBeVisible();
    await lightbox.getByRole("button", { name: "Image Details", exact: true }).click();
    await expect(details.getByRole("button", { name: "Filter Gallery by Seed", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`history-result-filter-${job === base ? "base" : "override"}.png`), scale: "css" });
    await details.getByRole("button", { name: "Filter Gallery by Seed", exact: true }).click();
    await expect(details).toHaveCount(0);
    await expect(lightbox).toHaveCount(0);
    expect(filters()).toEqual({ parameters: [parameter], seed: job.seed });
    await expect(browser.locator(".pb-result")).toHaveCount(1);
    await expect(browser.locator(".pb-result")).toHaveAttribute("data-result-identity", identity!);
    await browser.getByRole("button", { name: "Clear advanced", exact: true }).click();
    await expect(browser.locator(".pb-result")).toHaveCount(2);
  }
  await add.click();
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await dialog.getByLabel("Search historical choices").fill("Steps");
  await dialog.getByRole("radio", { name: /^Steps integer/ }).check();
  await dialog.getByLabel("Match mode").selectOption("base");
  await dialog.getByRole("button", { name: "Apply filter", exact: true }).click();
  await expect(browser.locator(".pb-result")).toHaveCount(1);
  const baseIdentity = await browser.locator(".pb-result").getAttribute("data-result-identity");
  expect(filters()).toEqual({ parameters: [{ key: "steps", value_type: "integer", mode: "base" }] });
  await add.click();
  await dialog.getByRole("radio", { name: "Seed", exact: true }).check();
  await dialog.getByLabel("Exact seed").fill(String(override.seed));
  await dialog.getByRole("button", { name: "Apply filter", exact: true }).click();
  await expect(browser.locator(".pb-result")).toHaveCount(0);
  await expect(browser.getByRole("heading", { name: "No matches in this view.", exact: true })).toBeVisible();
  await nav.getByRole("button", { name: "Runs", exact: true }).click();
  // Both conditions exist in this Run, but on different Jobs: it must not match.
  await expect(browser.locator(".pb-run")).toHaveCount(0);
  await expect(browser.getByRole("heading", { name: "No matches in this view.", exact: true })).toBeVisible();
  await parameterChip.click();
  await dialog.getByLabel("Match mode").selectOption("override");
  await dialog.getByRole("button", { name: "Apply filter", exact: true }).click();
  await expect(browser.locator(".pb-run")).toHaveCount(1);
  await expect(browser.locator(".pb-run")).toContainText("Base and equal override");
  await nav.getByRole("button", { name: "Gallery", exact: true }).click();
  await expect(browser.locator(".pb-result")).toHaveCount(1);
  await expect(browser.locator(".pb-result")).not.toHaveAttribute("data-result-identity", baseIdentity!);
  const overrideUrl = page.url();
  await parameterChip.click();
  await dialog.getByLabel("Match mode").selectOption("equals");
  await dialog.getByLabel("Exact value").fill("20");
  await dialog.getByRole("button", { name: "Apply filter", exact: true }).click();
  await expect(browser.locator(".pb-result")).toHaveCount(1);
  expect(filters()).toEqual({ seed: override.seed, parameters: [{ key: "steps", value_type: "integer", mode: "equals", value: 20 }] });
  const exactUrl = page.url();
  await page.goBack();
  await expect(page).toHaveURL(overrideUrl);
  await expect(parameterChip).toContainText("Any override");
  await page.goForward();
  await expect(page).toHaveURL(exactUrl);
  await expect(parameterChip).toContainText("20");
  await nav.getByRole("button", { name: "Batch", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: /^Seed / })).toHaveValue("987654");
  await expect(page.getByLabel(/^Run Name/)).toHaveValue("Unpublished draft - keep me");
  await expect(page.getByRole("button", { name: /^Create (Another )?Run$/ })).toBeEnabled();
  await nav.getByRole("button", { name: "Gallery", exact: true }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get("view") === "gallery"
    && url.searchParams.get("filters") === new URL(exactUrl).searchParams.get("filters"));
  await page.reload();
  await expect(browser.locator(".pb-result")).toHaveCount(1);
  expect(filters()).toEqual({ seed: override.seed, parameters: [{ key: "steps", value_type: "integer", mode: "equals", value: 20 }] });

  await page.setViewportSize({ width: 320, height: 720 });
  const brandBounds = await page.locator(".app-header .brand-block").boundingBox();
  const toolsBounds = await page.locator(".app-header .header-tools").boundingBox();
  expect(brandBounds).not.toBeNull();
  expect(toolsBounds).not.toBeNull();
  expect(toolsBounds!.y, "Header tools must occupy a separate row below the brand at 320px")
    .toBeGreaterThanOrEqual(brandBounds!.y + brandBounds!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("history-filters-active-320.png"), scale: "css", fullPage: true });
  await parameterChip.click();
  await expect(dialog.getByLabel("Exact value")).toHaveValue("20");
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await dialog.getByRole("button", { name: "Apply filter", exact: true }).focus();
  await page.keyboard.press("Tab");
  // Chromium may visit browser chrome before wrapping a native modal's tab order.
  if (await page.evaluate(() => !document.hasFocus() && document.activeElement === document.body)) {
    await page.keyboard.press("Tab");
  }
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  if (await page.evaluate(() => !document.hasFocus() && document.activeElement === document.body)) {
    await page.keyboard.press("Shift+Tab");
  }
  await expect(dialog.getByRole("button", { name: "Apply filter", exact: true })).toBeFocused();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath("history-filter-dialog-320.png"), scale: "css" });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(parameterChip).toBeFocused();
  await browser.getByRole("button", { name: `Edit Seed: ${override.seed}`, exact: true }).click();
  await dialog.getByLabel("Exact seed").fill(String(base.seed));
  await dialog.getByLabel("Exact seed").press("Enter");
  // Equals 20 is an explicit override, not the Base workflow's literal 20.
  await expect(browser.locator(".pb-result")).toHaveCount(0);
  await expect(browser.getByRole("heading", { name: "No matches in this view.", exact: true })).toBeVisible();
  await browser.getByRole("button", { name: /^Remove .*\(integer\):/ }).click();
  expect(filters()).toEqual({ seed: base.seed });
  await expect(browser.locator(".pb-result")).toHaveCount(1);
  await expect(browser.locator(".pb-result")).toHaveAttribute("data-result-identity", baseIdentity!);
  await nav.getByRole("button", { name: "Runs", exact: true }).click();
  await expect(browser.locator(".pb-run")).toHaveCount(1);
  await browser.getByRole("button", { name: `Remove Seed: ${base.seed}`, exact: true }).click();
  expect(new URL(page.url()).searchParams.has("filters")).toBe(false);
  await nav.getByRole("button", { name: "Gallery", exact: true }).click();
  await expect(browser.locator(".pb-result")).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("history-filters-gallery-320.png"), scale: "css", fullPage: true });
  // Finish automatic history reconciliation before measuring this read-only dialog.
  await expect(browser.getByRole("button", { name: "Reindex Project", exact: true })).toBeEnabled();
  const reindexesBeforeDiagnostics = reindexPosts;
  const diagnosticsTrigger = browser.getByRole("button", { name: "Diagnostics", exact: true });
  const diagnostics = page.getByRole("dialog", { name: "History diagnostics", exact: true });
  const diagnosticResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/projects/${project.id}/history/diagnostics`);
  await diagnosticsTrigger.click();
  const initialDiagnostics = await diagnosticResponse;
  expect(initialDiagnostics.ok()).toBe(true);
  expect(await initialDiagnostics.json()).toMatchObject({ project_id: project.id, items: [], next_cursor: null });
  await expect(diagnostics).toBeVisible();
  expect(await diagnostics.evaluate((element) => element.matches("dialog:modal"))).toBe(true);
  await expect(diagnostics.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await expect(diagnostics.getByText("No diagnostics in this indexed page. This is not a new storage check.", { exact: true })).toBeVisible();
  await expect(diagnostics.getByRole("button", { name: "Previous", exact: true })).toBeDisabled();
  await expect(diagnostics.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  // Development Strict Mode replays the mount effect; Refresh must add one read.
  const readsBeforeRefresh = diagnosticRequests.length;
  expect(readsBeforeRefresh).toBeGreaterThan(0);
  const refreshedDiagnostics = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/projects/${project.id}/history/diagnostics`);
  await diagnostics.getByRole("button", { name: "Refresh", exact: true }).click();
  expect((await refreshedDiagnostics).ok()).toBe(true);
  await expect(diagnostics.getByRole("region", { name: "Diagnostic page", exact: true })).toHaveAttribute("aria-busy", "false");
  await expect(diagnostics.getByText("No diagnostics in this indexed page. This is not a new storage check.", { exact: true })).toBeVisible();
  expect(diagnosticRequests).toHaveLength(readsBeforeRefresh + 1);
  for (const url of diagnosticRequests) {
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.has("cursor")).toBe(false);
  }
  expect(reindexPosts).toBe(reindexesBeforeDiagnostics);
  expect(await diagnostics.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight
      && element.scrollWidth <= element.clientWidth;
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("history-diagnostics-empty-320.png"), scale: "css" });
  await page.keyboard.press("Escape");
  await expect(diagnostics).toHaveCount(0);
  await expect(diagnosticsTrigger).toBeFocused();
  expect(reindexPosts).toBe(reindexesBeforeDiagnostics);
  await nav.getByRole("button", { name: "Batch", exact: true }).click();
  await expect(page.getByLabel("Saved Batch", { exact: true })).toHaveValue(batch.id);
  await page.getByRole("group", { name: "Seeds", exact: true }).getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: /^Seed / })).toHaveValue("987654");
  await expect(page.getByRole("button", { name: /^Create (Another )?Run$/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("real API: Preview, execution, images, closed-tab recovery, historical reuse", async ({ page, context, request }, testInfo) => {
  const errors: string[] = [];
  context.on("page", (opened) => opened.on("pageerror", (error) => errors.push(error.message)));
  page.on("pageerror", (error) => errors.push(error.message));
  const { project, batch } = await seed(request);
  await page.goto("/");
  await expect(page.getByText("Browser test - simulated ComfyUI")).toBeVisible();
  await expect(page.getByRole("region", { name: "Batch Results", exact: true })).toHaveCount(0);
  await page.getByLabel("Active Project").selectOption(project.id);
  await page.getByLabel("Saved Batch", { exact: true }).selectOption(batch.id);
  await page.getByRole("button", { name: "Discard and switch", exact: true }).click();
  await expect(page.getByLabel("Saved Batch", { exact: true })).toHaveValue(batch.id);
  await page.getByRole("button", { name: "Preview Batch", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("radio", { name: "Dark", exact: true }).check();
  await page.getByRole("radio", { name: "Synthwave", exact: true }).check();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.getByLabel("Saved Batch", { exact: true })).toHaveValue(batch.id);
  // Appearance must not invalidate the existing Preview or require another compilation.
  await page.getByRole("button", { name: "Create Run", exact: true }).click();
  await page.getByRole("button", { name: "Start Run", exact: true }).click();
  await expect(page.getByText("Succeeded", { exact: true })).toBeVisible();
  const image = page.locator("img.result-image").first();
  await expect(image).toBeVisible();
  await expect(image).toHaveJSProperty("naturalWidth", 384);
  const results = page.getByRole("region", { name: "Results", exact: true });
  await expect(results.locator(".result-card").first()).not.toContainText(/Job|verified/i);
  await expect(page.getByRole("region", { name: "Batch Results", exact: true })).toHaveCount(0);
  await results.screenshot({ path: testInfo.outputPath("results-clean.png"), scale: "css" });
  await image.click();
  await expect(page.getByRole("dialog", { name: "Result image preview" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("result-lightbox.png") });
  await page.getByRole("dialog", { name: "Result image preview" }).getByRole("button", { name: "Close", exact: true }).click();
  await results.getByRole("button", { name: "Details for Job 1, artifact 1", exact: true }).click();
  const details = page.getByRole("dialog", { name: "Job 001 \u00b7 Artifact 1", exact: true });
  await details.getByText("Technical details", { exact: true }).click();
  await expect(details.locator(".result-technical-details dl > div").filter({ has: page.getByText("Job ordinal", { exact: true }) }).locator("dd")).toHaveText("1");
  await expect(details.locator(".result-technical-details dl > div").filter({ has: page.getByText("Integrity", { exact: true }) }).locator("dd")).toHaveText("verified");
  await details.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Runs", exact: true }).click();
  const openHistory = page.getByRole("region", { name: "Project browser" });
  await expect(openHistory.getByText("Checking Project history...", { exact: true })).toHaveCount(0);
  await openHistory.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(openHistory.locator(".pb-run .status-pill")).toHaveText("succeeded");
  await expect(openHistory.getByText("2 Results", { exact: true })).toBeVisible();
  await openHistory.getByRole("button", { name: "Show Results", exact: true }).click();
  await expect(openHistory.locator(".pb-image-button img").first()).toHaveJSProperty("naturalWidth", 384);

  await page.close();
  const reopened = await context.newPage();
  await reopened.goto("/");
  await expect(reopened.getByText("Succeeded", { exact: true })).toBeVisible();
  await expect(reopened.getByText("Draft restored from this browser. Preview to verify the Job plan.", { exact: true })).toBeVisible();
  await reopened.locator(".dismissible-note").screenshot({ path: testInfo.outputPath("recovery-notice.png"), scale: "css" });
  await reopened.getByRole("button", { name: "Dismiss session notification" }).click();
  await expect(reopened.getByText(/Draft restored from this browser/)).toHaveCount(0);
  await expect(reopened.getByText("Browser test - simulated ComfyUI")).toBeVisible();
  await expect(reopened.getByRole("region", { name: "Batch Results", exact: true })).toHaveCount(0);
  await expect(reopened.getByRole("button", { name: "Create Run", exact: true })).toHaveCount(0);
  await reopened.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Gallery", exact: true }).click();
  const history = reopened.getByRole("region", { name: "Project browser" });
  await expect(history.locator(".pb-image-button img").first()).toHaveJSProperty("naturalWidth", 384);
  await expect(history.locator(".pb-result").first()).not.toContainText(/Job|verified/i);
  await reopened.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Runs", exact: true }).click();
  await history.getByRole("button", { name: "Load Run as Batch", exact: true }).click();
  if (await reopened.getByRole("dialog", { name: "Replace unsaved Batch?", exact: true }).isVisible()) {
    await reopened.getByRole("button", { name: "Replace Batch", exact: true }).click();
  }
  await expect(reopened.getByText(/loaded as an unsaved Batch draft/)).toBeVisible();
  await reopened.getByRole("button", { name: "Dismiss session notification" }).click();
  await expect(reopened.getByText(/loaded as an unsaved Batch draft/)).toHaveCount(0);
  await reopened.getByRole("button", { name: "Preview Batch", exact: true }).click();
  await expect(reopened.getByRole("button", { name: "Create Run", exact: true })).toBeEnabled();
  await reopened.screenshot({ path: testInfo.outputPath("restored-batch.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("closed-tab active Run recovery and Stop preserve the completed prefix", async ({ page, context, request }) => {
  const { project, batch } = await seed(request, "[sandbox:slow] mountain");
  await page.goto("/");
  await page.getByLabel("Active Project").selectOption(project.id);
  await page.getByLabel("Saved Batch", { exact: true }).selectOption(batch.id);
  await page.getByRole("button", { name: "Discard and switch", exact: true }).click();
  await expect(page.getByLabel("Saved Batch", { exact: true })).toHaveValue(batch.id);
  await page.getByRole("button", { name: "Preview Batch", exact: true }).click();
  const created = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/runs" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Create Run", exact: true }).click();
  const run = await (await created).json() as RunCreatedResponse;
  await page.getByRole("button", { name: "Start Run", exact: true }).click();
  await expect.poll(async () => {
    const response = await request.get(`${apiUrl}/api/runs/${run.run_id}/execution`);
    return (await response.json() as ExecutionResponse).jobs[0].status;
  }).toBe("submitted");
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto("/");
  await reopened.getByRole("button", { name: "Stop after current Job", exact: true }).click();
  await reopened.getByRole("button", { name: "Stop Run", exact: true }).click();
  await expect(reopened.getByText("Cancelled", { exact: true })).toBeVisible({ timeout: 40_000 });
  const response = await request.get(`${apiUrl}/api/runs/${run.run_id}/execution`);
  const execution = await response.json() as ExecutionResponse;
  expect(execution.jobs.map((job) => job.status)).toEqual(["succeeded", "cancelled"]);
  expect(execution.jobs[0].result_count).toBe(1);
  expect(execution.jobs[1].prompt_id).toBeNull();
  await expect(reopened.getByLabel("Active Project")).toBeEnabled();
});

test("Project browser preserves Preview, browses across Runs, and keeps filters in navigation", async ({ page, request }, testInfo) => {
  const { project, batch } = await seed(request);
  const requests: string[] = [];
  page.on("request", (sent) => requests.push(new URL(sent.url()).pathname));
  await page.goto("/");
  await page.getByLabel("Active Project").selectOption(project.id);
  await page.getByLabel("Saved Batch", { exact: true }).selectOption(batch.id);
  await page.getByRole("button", { name: "Discard and switch", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "Workspace" });
  const browser = page.getByRole("region", { name: "Project browser" });
  for (const name of ["Amber valley", "Blue hour"]) {
    await page.getByRole("button", { name: "Preview Batch", exact: true }).click();
    await expect(page.getByRole("button", { name: "Preview Batch", exact: true })).toBeEnabled();
    await page.getByLabel(/^Run Name/).fill(name);
    await nav.getByRole("button", { name: "Gallery", exact: true }).click();
    await expect(browser.getByRole("heading", { name: /^Gallery/ })).toBeVisible();
    await nav.getByRole("button", { name: "Batch", exact: true }).click();
    await expect(page.getByLabel(/^Run Name/)).toHaveValue(name);
    await expect(page.getByRole("button", { name: /^Create (Another )?Run$/ })).toBeEnabled();
    await page.getByRole("button", { name: /^Create (Another )?Run$/ }).click();
    await page.getByRole("button", { name: "Start Run", exact: true }).click();
    await nav.getByRole("button", { name: "Gallery", exact: true }).click();
    await expect(page.getByRole("region", { name: "Current Run", exact: true }).getByText("succeeded", { exact: true })).toBeVisible();
    await nav.getByRole("button", { name: "Batch", exact: true }).click();
  }
  // Exercise real cursor pages without generating 49 slow simulated GPU Jobs.
  await page.route("**/history/results*", async (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set("limit", "2");
    await route.fulfill({ response: await route.fetch({ url: url.href }) });
  });
  await nav.getByRole("button", { name: "Gallery", exact: true }).click();
  await expect(browser.getByText("Checking Project history...", { exact: true })).toHaveCount(0);
  await browser.getByRole("button", { name: "Refresh", exact: true }).click();
  // Refresh retains the old two-card page while reading; its count is not readiness.
  await expect(browser.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
  await expect(browser.locator(".pb-result")).toHaveCount(2);
  await expect(browser.locator(".pb-result strong")).toHaveText(["Blue hour", "Blue hour"]);
  const firstIdentity = await browser.locator(".pb-result").first().getAttribute("data-result-identity");
  await expect(browser.locator(".pb-image-button img").first()).toHaveJSProperty("naturalWidth", 384);
  await browser.getByLabel("Image size").selectOption("spacious");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("project-gallery.png"), scale: "css", fullPage: true });
  await browser.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(browser.getByText("Page 2", { exact: true })).toBeVisible();
  await expect(browser.locator(".pb-result strong")).toHaveText(["Amber valley", "Amber valley"]);
  await expect(browser.locator(".pb-result").first()).not.toHaveAttribute("data-result-identity", firstIdentity!);
  await browser.locator(".pb-image-button").first().click();
  const viewer = page.getByRole("dialog", { name: "Project Result image", exact: true });
  await expect(viewer).toBeVisible();
  await expect(viewer).toContainText("Amber valley");
  await expect(viewer.locator("img")).toHaveJSProperty("naturalWidth", 384);
  const originalViewport = page.viewportSize()!;
  for (const viewport of [originalViewport, { width: 320, height: 720 }, { width: 720, height: 320 }]) {
    await page.setViewportSize(viewport);
    await expect(viewer.locator(".pb-modal-heading")).toHaveCount(1);
    await expect(viewer.getByRole("heading")).toHaveCount(0);
    await expect(viewer.getByText("Project Result image", { exact: true })).toHaveCount(0);
    await expect(viewer.getByRole("button")).toHaveText(["Previous", "Next", "Image Details", "Close"]);
    const imageLink = viewer.getByRole("link", { name: "Open original image in a new tab", exact: true });
    await expect(imageLink).toHaveAttribute("href", (await viewer.locator("img").getAttribute("src"))!);
    await expect(imageLink).toHaveAttribute("target", "_blank");
    await expect(imageLink.locator("img")).toHaveCSS("object-fit", "contain");
    const layout = await viewer.evaluate((element) => {
      const box = (node: Element) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        dialog: box(element),
        toolbar: box(element.querySelector(".pb-modal-heading")!),
        controls: [...element.querySelectorAll(".pb-modal-heading button, .pb-viewer-navigation span")].map(box),
        image: box(element.querySelector("img")!),
        link: box(element.querySelector(".pb-viewer-link")!),
        caption: box(element.querySelector(".pb-viewer-caption")!),
        noOverflow: element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight,
      };
    });
    await page.screenshot({ path: testInfo.outputPath(`project-viewer-${viewport.width}x${viewport.height}.png`), scale: "css" });
    expect(layout.noOverflow).toBe(true);
    expect(layout.dialog.x).toBeGreaterThanOrEqual(0);
    expect(layout.dialog.x + layout.dialog.width).toBeLessThanOrEqual(viewport.width);
    expect(layout.dialog.y).toBeGreaterThanOrEqual(0);
    expect(layout.dialog.y + layout.dialog.height).toBeLessThanOrEqual(viewport.height);
    for (const control of layout.controls) {
      expect(control.y).toBeGreaterThanOrEqual(layout.toolbar.y);
      expect(control.y + control.height).toBeLessThanOrEqual(layout.toolbar.y + layout.toolbar.height + 1);
      expect(control.x).toBeGreaterThanOrEqual(layout.toolbar.x);
      expect(control.x + control.width).toBeLessThanOrEqual(layout.toolbar.x + layout.toolbar.width + 1);
      expect(Math.abs(control.y + control.height / 2 - layout.controls[0].y - layout.controls[0].height / 2)).toBeLessThan(1);
    }
    expect(layout.link.height / layout.dialog.height).toBeGreaterThan(0.7);
    expect(layout.image).toEqual(layout.link);
    expect(layout.image.y).toBeGreaterThanOrEqual(layout.toolbar.y + layout.toolbar.height);
    expect(layout.image.y + layout.image.height).toBeLessThanOrEqual(layout.caption.y);
  }
  await page.setViewportSize(originalViewport);
  await expect(viewer.getByRole("button", { name: "Previous", exact: true })).toBeDisabled();
  await expect(viewer.getByText("1/2", { exact: true })).toBeVisible();
  await viewer.getByRole("button", { name: "Next", exact: true }).click();
  await expect(viewer.getByText("2/2", { exact: true })).toBeVisible();
  await expect(viewer.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await viewer.getByRole("button", { name: "Previous", exact: true }).click();
  const imageDetails = viewer.getByRole("button", { name: "Image Details", exact: true });
  await imageDetails.click();
  const details = page.getByRole("dialog", { name: "Job 001 \u00b7 Artifact 1", exact: true });
  await expect(details).toContainText("Amber valley");
  await details.getByRole("button", { name: "Close", exact: true }).click();
  await expect(viewer).toBeVisible();
  await expect(imageDetails).toBeFocused();
  await viewer.getByRole("button", { name: "Close", exact: true }).click();
  await nav.getByRole("button", { name: "Runs", exact: true }).click();
  await expect(browser.locator(".pb-run")).toHaveCount(2);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("project-runs.png"), scale: "css", fullPage: true });
  await nav.getByRole("button", { name: "Gallery", exact: true }).click();
  await expect(browser.getByText("Page 2", { exact: true })).toBeVisible();
  await nav.getByRole("button", { name: "Runs", exact: true }).click();
  await browser.getByLabel("Run names and notes").fill("Blue");
  await browser.getByRole("button", { name: "Search", exact: true }).click();
  await expect(browser.locator(".pb-run")).toHaveCount(1);
  await expect(page).toHaveURL(/q=Blue/);
  await page.goBack();
  await expect(browser.locator(".pb-run")).toHaveCount(2);
  await page.goForward();
  await expect(browser.locator(".pb-run")).toHaveCount(1);
  await page.reload();
  await expect(nav.getByRole("button", { name: "Runs", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(browser.locator(".pb-run")).toHaveCount(1);
  const originalRunsUrl = page.url();
  await browser.getByRole("button", { name: "Show Results", exact: true }).click();
  await expect(page).toHaveURL(/view=gallery/);
  await page.goBack();
  await expect(page).toHaveURL(originalRunsUrl);
  await expect(browser.locator(".pb-run")).toHaveCount(1);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("radio", { name: "Synthwave", exact: true }).check();
  await page.getByRole("radio", { name: "Dark", exact: true }).check();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(browser.locator(".pb-run").first()).toHaveCSS("background-color", "rgb(26, 27, 38)");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("project-runs-synthwave.png"), scale: "css", fullPage: true });
  await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(requests.filter((url) => url === `/api/projects/${project.id}/runs`)).toEqual([]);
});
