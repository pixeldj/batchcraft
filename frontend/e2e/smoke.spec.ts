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
      "4": { class_type: "LoadImage", inputs: { image: "base.png" } },
    },
  });
  const profile = await post<CreateWorkflowProfileResponse>(request, `/api/workflows/${workflow.workflow.id}/profiles`, {
    name: "Sandbox profile", workflow_version_id: workflow.version.id,
    mappings: {
      prompt: { node_id: "1", input_name: "text", value_type: "string" },
      seed: { node_id: "2", input_name: "seed", value_type: "integer" },
      output_prefix: { node_id: "3", input_name: "filename_prefix", value_type: "string" },
    },
    image_inputs: [{ key: "reference", label: "Reference", node_id: "4", input_name: "image" }],
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
    image_bindings: [{ slot_key: "reference", values: [null] }],
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
  return { project, batch, prompt };
}

test("Workflow editors stay above Reference thumbnails and preserve bindings on Cancel", async ({ page, request }, testInfo) => {
  const { project, batch } = await seed(request);
  await page.goto("/");
  await page.getByLabel("Active Project").selectOption(project.id);
  await page.getByLabel("Saved Batch", { exact: true }).selectOption(batch.id);
  await page.getByRole("button", { name: "Discard and switch", exact: true }).click();
  await expect(page.getByLabel("Saved Batch", { exact: true })).toHaveValue(batch.id);
  const inputs = page.getByRole("group", { name: "Image Inputs", exact: true });
  await inputs.locator('input[type="file"]').setInputFiles({
    name: "reference.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1UAAAAASUVORK5CYII=", "base64"),
  });
  await inputs.getByRole("button", { name: "Add reference.png to Reference", exact: true }).click();
  const thumbnail = inputs.getByRole("button", { name: "Remove reference.png from Reference", exact: true });
  await expect(thumbnail.locator("img")).toHaveJSProperty("naturalWidth", 1);
  await expect(thumbnail.locator(".selection-order")).toHaveText("2");
  await page.getByRole("button", { name: "Preview Batch", exact: true }).click();
  await expect(page.getByRole("button", { name: "Create Run", exact: true })).toBeEnabled();
  await page.getByRole("group", { name: "Workflow Setup", exact: true }).getByRole("button", { name: "Change", exact: true }).click();

  for (const title of ["Edit Workflow", "Edit Profile"]) {
    await page.getByRole("button", { name: title, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: title, exact: true });
    await expect(dialog).toBeVisible();
    // Scroll the underlying picker into the dialog's viewport area to exercise real paint order.
    await thumbnail.evaluate(element => element.scrollIntoView({ block: "center" }));
    const point = await thumbnail.evaluate(element => {
      const box = element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    await page.mouse.move(point.x, point.y);
    expect(await page.evaluate(({ x, y }) =>
      document.elementFromPoint(x, y)?.closest("dialog")?.getAttribute("aria-label"), point)).toBe(title);
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    const viewport = page.viewportSize()!;
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({ path: testInfo.outputPath(`${title.replaceAll(" ", "-")}.png`) });
    await expect(dialog.getByRole("button", { name: title === "Edit Workflow" ? "Save Workflow" : "Save Profile", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(thumbnail).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Create Run", exact: true })).toBeEnabled();
  }
});

test("duplicated Prompts can be edited before and after saving without changing the Batch", async ({ page, request }, testInfo) => {
  const { project, batch, prompt } = await seed(request);
  await page.goto("/");
  await page.getByLabel("Active Project").selectOption(project.id);
  await page.getByLabel("Saved Batch", { exact: true }).selectOption(batch.id);
  await page.getByRole("button", { name: "Discard and switch", exact: true }).click();
  await expect(page.getByLabel("Saved Batch", { exact: true })).toHaveValue(batch.id);
  await page.getByRole("button", { name: "Preview Batch", exact: true }).click();
  await expect(page.getByRole("button", { name: "Create Run", exact: true })).toBeEnabled();
  await page.getByRole("group", { name: "Prompts", exact: true }).getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: "Add Prompt", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Prompts", exact: true });
  await library.getByRole("button", { name: "Duplicate", exact: true }).click();
  const template = library.getByRole("textbox", { name: "Prompt template", exact: true });
  await expect(template).toHaveValue(prompt.version.text);
  await expect(template).toBeEditable();
  await template.fill("An edited copy of {{subject}}");
  await library.getByRole("button", { name: "Duplicate Prompt", exact: true }).click();
  await expect(library.getByRole("heading", { name: "Landscape copy", exact: true })).toBeVisible();
  await expect(library.locator(".prompt-library-text")).toHaveText("An edited copy of {{subject}}");
  await library.getByRole("button", { name: "Edit Prompt", exact: true }).click();
  await library.getByRole("textbox", { name: "Prompt template", exact: true }).fill("A second revision of {{subject}}");
  await library.getByRole("button", { name: "Save revision", exact: true }).click();
  await expect(library.locator(".prompt-library-text")).toHaveText("A second revision of {{subject}}");
  await expect(library.locator(".prompt-library-panel-heading .prompt-revision")).toHaveText("v2");
  await page.screenshot({ path: testInfo.outputPath("edited-duplicate.png") });
  await library.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("button", { name: "Create Run", exact: true })).toBeEnabled();
  const source = await request.get(`${apiUrl}/api/prompt-versions/${prompt.version.id}`);
  expect((await source.json()).text).toBe(prompt.version.text);
  const saved = await request.get(`${apiUrl}/api/batches/${batch.id}`);
  expect(saved.ok()).toBeTruthy();
  expect((await saved.json()).prompt_selections).toEqual(batch.prompt_selections);
});

test("real API: Preview, execution, images, closed-tab recovery, historical reuse", async ({ page, context, request }, testInfo) => {
  const errors: string[] = [];
  context.on("page", (opened) => opened.on("pageerror", (error) => errors.push(error.message)));
  page.on("pageerror", (error) => errors.push(error.message));
  const { project, batch } = await seed(request);
  await page.goto("/");
  await expect(page.getByText("Browser test - simulated ComfyUI")).toBeVisible();
  await page.getByLabel("Active Project").selectOption(project.id);
  await page.getByLabel("Saved Batch", { exact: true }).selectOption(batch.id);
  await page.getByRole("button", { name: "Discard and switch", exact: true }).click();
  await expect(page.getByLabel("Saved Batch", { exact: true })).toHaveValue(batch.id);
  await page.getByRole("button", { name: "Preview Batch", exact: true }).click();
  await page.getByRole("button", { name: "Create Run", exact: true }).click();
  await page.getByRole("button", { name: "Start Run", exact: true }).click();
  await expect(page.getByText("Succeeded", { exact: true })).toBeVisible();
  const image = page.locator("img.result-image").first();
  await expect(image).toBeVisible();
  await expect(image).toHaveJSProperty("naturalWidth", 384);
  await image.click();
  await expect(page.getByRole("dialog", { name: "Result image preview" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("result-lightbox.png") });
  await page.getByRole("dialog", { name: "Result image preview" }).getByRole("button", { name: "Close", exact: true }).click();

  await page.close();
  const reopened = await context.newPage();
  await reopened.goto("/");
  await expect(reopened.getByText("Succeeded", { exact: true })).toBeVisible();
  await expect(reopened.getByRole("button", { name: "Create Run", exact: true })).toHaveCount(0);
  await reopened.getByRole("button", { name: "Reindex Project", exact: true }).click();
  const history = reopened.getByRole("region", { name: "Project History" });
  await history.getByRole("button", { name: "Open", exact: true }).click();
  await history.getByRole("button", { name: "Load Run as Batch", exact: true }).click();
  await expect(reopened.getByText(/loaded as an unsaved Batch draft/)).toBeVisible();
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
