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
} from "../src/api/types";

const apiUrl = "http://127.0.0.1:8002";

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(`${apiUrl}${path}`, { data });
  expect(response.ok(), await response.text()).toBeTruthy();
  return await response.json() as T;
}

async function seed(request: APIRequestContext, subject = "mountain") {
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
    variable_bindings: [{ placeholder: "subject", values: [subject, "river"] }],
    image_bindings: [],
    parameter_bindings: [
      { parameter_key: "steps", mode: "values", values: [null] },
      { parameter_key: "cfg", mode: "values", values: [null] },
    ],
    linked_parameter_sets: [],
    seed_intent: { mode: "fixed", values: [42], random_seed_count: null },
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
  await expect(browser.locator(".pb-result")).toHaveCount(2);
  const firstIdentity = await browser.locator(".pb-result").first().getAttribute("data-result-identity");
  await expect(browser.locator(".pb-image-button img").first()).toHaveJSProperty("naturalWidth", 384);
  await browser.getByLabel("Image size").selectOption("spacious");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("project-gallery.png"), scale: "css", fullPage: true });
  await browser.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(browser.getByText("Page 2", { exact: true })).toBeVisible();
  await expect(browser.locator(".pb-result").first()).not.toHaveAttribute("data-result-identity", firstIdentity!);
  await browser.locator(".pb-image-button").first().click();
  const viewer = page.getByRole("dialog", { name: "Project Result image", exact: true });
  await expect(viewer).toBeVisible();
  await expect(viewer).toContainText("Amber valley");
  await expect(viewer.locator("img")).toHaveJSProperty("naturalWidth", 384);
  await viewer.getByRole("button", { name: "Details", exact: true }).click();
  const details = page.getByRole("dialog", { name: "Job 001 \u00b7 Artifact 1", exact: true });
  await expect(details).toContainText("Amber valley");
  await details.getByRole("button", { name: "Close", exact: true }).click();
  await expect(viewer).toBeVisible();
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
