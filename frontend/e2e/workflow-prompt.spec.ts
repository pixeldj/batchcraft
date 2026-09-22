import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import type { CreateWorkflowResponse, CreateWorkflowProfileResponse, ProjectResponse, SavedBatchDetail, CreatePromptResponse, RunCreatedResponse, RunResponse, PreviewResponse } from "../src/api/types";

const apiUrl = "http://127.0.0.1:8002";
async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(`${apiUrl}${path}`, { data });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<T>;
}

test("Prompt Library sorts without reordering the Batch and duplicates edited old text as independent v1", async ({ page, request }, testInfo) => {
  const suffix = randomUUID().slice(0, 8);
  const project = await post<ProjectResponse>(request, "/api/projects", { name: `Library ${suffix}`, filesystem_key: `library_${suffix}` });
  const source = await post<CreatePromptResponse>(request, `/api/projects/${project.id}/prompts`, { name: "zebra", text: "  old exact text\n", description: "Source notes" });
  await post(request, `/api/prompts/${source.prompt.id}/versions`, { text: "Latest source text", note: "Second revision" });
  await post(request, `/api/projects/${project.id}/prompts`, { name: "Beta", text: "Beta text" });
  await post(request, `/api/projects/${project.id}/prompts`, { name: "alpha", text: "Alpha text" });
  const originalHistory = await (await request.get(`${apiUrl}/api/prompts/${source.prompt.id}/versions`)).json();
  await page.goto("/");
  await page.getByLabel("Active Project").selectOption(project.id);
  const prompts = page.getByRole("group", { name: "Prompts", exact: true });
  await prompts.getByRole("button", { name: "Prompt Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Prompts", exact: true });
  await expect(library.locator(".prompt-library-item strong")).toHaveText(["alpha", "Beta", "zebra"]);
  await expect(library.getByRole("heading", { name: "alpha", exact: true })).toBeVisible();
  await library.getByRole("button", { name: "zebra v2", exact: true }).click();
  await library.getByRole("button", { name: "History", exact: true }).click();
  await library.getByRole("button", { name: "Inspect revision 1", exact: true }).click();
  await library.getByRole("button", { name: "Back to Prompt", exact: true }).click();
  const footer = library.locator("footer");
  await footer.getByRole("button", { name: "Add to Batch", exact: true }).click();
  await expect(footer.getByRole("button", { name: "Selected in Batch", exact: true })).toBeDisabled();
  await library.getByRole("button", { name: "Duplicate", exact: true }).click();
  const template = library.getByRole("textbox", { name: "Prompt template", exact: true });
  await expect(template).toHaveValue("  old exact text\n");
  const edited = "  Edited older revision {{subject}}\n";
  await template.fill(edited);
  await library.getByLabel("Prompt name", { exact: true }).fill("aardvark copy");
  await expect(footer.getByRole("button", { name: "Add to Batch", exact: true })).toHaveCount(0);
  for (const event of ["visibilitychange", "pageshow"]) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let refreshing = false;
    await page.route("**/api/executions/active", async (route) => {
      const response = await route.fetch();
      refreshing = true;
      await gate;
      await route.fulfill({ response });
    }, { times: 1 });
    try {
      await template.focus();
      await page.evaluate((name) => {
        if (name === "pageshow") window.dispatchEvent(new PageTransitionEvent(name));
        else {
          Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
          document.dispatchEvent(new Event(name));
        }
      }, event);
      await expect.poll(() => refreshing).toBe(true);
      await expect(library).toBeVisible();
      await expect(template).toHaveValue(edited);
      await expect(template).toBeFocused();
      await expect(library.getByRole("button", { name: "Duplicate Prompt", exact: true })).toBeDisabled();
    } finally { release(); }
    await expect(library.getByRole("button", { name: "Duplicate Prompt", exact: true })).toBeEnabled();
    await expect(template).toHaveValue(edited);
  }
  const copiedResponse = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/projects/${project.id}/prompts` && r.request().method() === "POST");
  await library.getByRole("button", { name: "Duplicate Prompt", exact: true }).click();
  const copied = await (await copiedResponse).json() as CreatePromptResponse;
  expect(copied.prompt.id).not.toBe(source.prompt.id);
  expect(copied.version).toMatchObject({ version_number: 1, text: edited, prompt_id: copied.prompt.id });
  await expect(library.locator(".prompt-library-item strong")).toHaveText(["aardvark copy", "alpha", "Beta", "zebra"]);
  await expect(library.getByRole("heading", { name: "aardvark copy", exact: true })).toBeVisible();
  await expect(footer.getByRole("listitem")).toHaveCount(1);
  await expect(footer.getByRole("listitem")).toContainText("zebra v1");
  expect(await (await request.get(`${apiUrl}/api/prompts/${source.prompt.id}/versions`)).json()).toEqual(originalHistory);
  expect((await (await request.get(`${apiUrl}/api/prompts/${copied.prompt.id}/versions`)).json()).prompt_versions).toHaveLength(1);
  if (testInfo.project.name === "mobile") await page.setViewportSize({ width: 320, height: 740 });
  for (const name of ["Add to Batch", "Done"]) {
    await expect(footer.getByRole("button", { name, exact: true })).toBeInViewport();
  }
  expect(await library.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await library.screenshot({ path: testInfo.outputPath("prompt-library-footer.png") });
  await footer.getByRole("button", { name: "Done", exact: true }).click();
  await expect(prompts.locator(".prompt-card pre")).toHaveJSProperty("textContent", source.version.text);
});

test("mapped workflow prompt explicitly becomes real Project v1 and ordinary Run provenance", async ({ page, request }, testInfo) => {
  const suffix = randomUUID().slice(0, 8);
  const text = "  A {{subject}} at sunset\n\n" + "Detailed landscape with gentle light. ".repeat(30) + "  ";
  const project = await post<ProjectResponse>(request, "/api/projects", { name: `Prompt copy ${suffix}`, filesystem_key: `prompt_copy_${suffix}` });
  const workflow = await post<CreateWorkflowResponse>(request, `/api/projects/${project.id}/workflows`, {
    name: "Original workflow", workflow: {
      "1": { class_type: "CLIPTextEncode", inputs: { text } },
      "2": { class_type: "KSampler", inputs: { seed: 1 } },
      "3": { class_type: "SaveImage", inputs: { filename_prefix: "sandbox" } },
      "4": { class_type: "CLIPTextEncode", inputs: { text: "Other mapped prompt" } },
    },
  });
  const profile = await post<CreateWorkflowProfileResponse>(request, `/api/workflows/${workflow.workflow.id}/profiles`, {
    name: "Original profile", workflow_version_id: workflow.version.id,
    mappings: {
      prompt: { node_id: "1", input_name: "text", value_type: "string" },
      seed: { node_id: "2", input_name: "seed", value_type: "integer" },
      output_prefix: { node_id: "3", input_name: "filename_prefix", value_type: "string" },
    }, image_inputs: [], parameters: [],
  });
  // Newer compatible Profile and Workflow revisions must not replace the selected exact pair.
  await post(request, `/api/workflow-profiles/${profile.workflow_profile.id}/versions`, {
    workflow_version_id: workflow.version.id,
    mappings: { ...profile.version.profile.mappings as object, prompt: { node_id: "4", input_name: "text", value_type: "string" } },
    image_inputs: [], parameters: [],
  });
  await post(request, `/api/workflows/${workflow.workflow.id}/versions`, {
    workflow: { ...workflow.version.workflow, "1": { class_type: "CLIPTextEncode", inputs: { text: "New revision, not selected" } } },
  });
  const batch = await post<SavedBatchDetail>(request, `/api/projects/${project.id}/batches`, {
    name: "Copy original prompt", filesystem_key: "copy_original", prompt_selections: [], variable_bindings: [], image_bindings: [], parameter_bindings: [], linked_parameter_sets: [],
    seed_intent: { mode: "fixed", values: [42], random_seed_count: null },
    selected_workflow_version: { id: workflow.version.id, content_sha256: workflow.version.content_sha256, workflow: workflow.version.workflow },
    selected_workflow_profile_id: profile.workflow_profile.id,
    selected_workflow_profile_version: { id: profile.version.id, workflow_profile_id: profile.workflow_profile.id, workflow_version_id: workflow.version.id, content_sha256: profile.version.content_sha256, profile: profile.version.profile },
  });
  await page.goto("/");
  await page.getByLabel("Active Project").selectOption(project.id);
  await page.getByLabel("Saved Batch", { exact: true }).selectOption(batch.id);
  await page.getByRole("button", { name: "Discard and switch", exact: true }).click();
  await expect(page.getByLabel("Saved Batch", { exact: true })).toHaveValue(batch.id);
  const prompts = page.getByRole("group", { name: "Prompts", exact: true });
  await expect(prompts.getByRole("button", { name: "Use this prompt" })).toBeEnabled();
  expect((await (await request.get(`${apiUrl}/api/projects/${project.id}/prompts`)).json()).prompts).toEqual([]);
  await prompts.getByText("Workflow prompt", { exact: true }).click();
  await expect(prompts.locator(".workflow-prompt pre")).toHaveJSProperty("textContent", text);
  await prompts.screenshot({ path: testInfo.outputPath("workflow-prompt.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(prompts.getByLabel("Workflow Prompt copy name")).toHaveValue("Workflow prompt");
  await prompts.getByLabel("Workflow Prompt copy name").fill("Reviewed baseline");
  const copiedResponse = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/projects/${project.id}/prompts` && r.request().method() === "POST");
  await prompts.getByRole("button", { name: "Use this prompt" }).click();
  const copied = await (await copiedResponse).json() as CreatePromptResponse;
  expect(copied.prompt.project_id).toBe(project.id);
  expect(copied.prompt.name).toBe("Reviewed baseline");
  expect(copied.version).toMatchObject({ version_number: 1, text, placeholders: ["subject"] });
  await expect(prompts.getByRole("button", { name: "Use this prompt" })).toHaveCount(0);
  await expect(prompts.locator(".prompt-card pre")).toHaveJSProperty("textContent", text);
  // Copied placeholders follow normal binding validation, not literal bypass semantics.
  const invalidPreviewResponse = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/batches/preview" && r.request().method() === "POST");
  await page.getByRole("button", { name: "Preview Batch", exact: true }).click();
  expect((await invalidPreviewResponse).status()).toBe(422);
  await expect(page.getByRole("button", { name: "Create Run", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Create missing bindings", exact: true }).click();
  await page.getByRole("textbox", { name: "Values", exact: true }).fill("mountain");
  const previewResponse = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/batches/preview");
  await page.getByRole("button", { name: "Preview Batch", exact: true }).click();
  const previewHttp = await previewResponse;
  expect(previewHttp.ok(), await previewHttp.text()).toBe(true);
  const preview = await previewHttp.json() as PreviewResponse;
  expect(preview.jobs[0]).toMatchObject({ resolved_prompt: text.replace("{{subject}}", "mountain"), prompt_version_id: copied.version.id });
  const saved = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/batches/${batch.id}` && r.request().method() === "PATCH");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  const created = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/runs" && r.request().method() === "POST");
  await page.getByRole("button", { name: "Create Run", exact: true }).click();
  const run = await (await created).json() as RunCreatedResponse;
  const frozen = await (await request.get(`${apiUrl}/api/runs/${run.run_id}`)).json() as RunResponse;
  expect(frozen.prompt_versions).toEqual([{ id: copied.version.id, name: copied.version.name_snapshot, text }]);
  expect(frozen.batch_snapshot.workflow_selection.workflow).toEqual(workflow.version.workflow);
  expect(frozen.batch_snapshot.prompt_versions[0]).toMatchObject({ id: copied.version.id, prompt_id: copied.prompt.id, version_number: 1, text });
  expect((await (await request.get(`${apiUrl}/api/workflow-versions/${workflow.version.id}`)).json()).workflow).toEqual(workflow.version.workflow);
  await page.getByRole("button", { name: "Start Run", exact: true }).click();
  await expect(page.getByText("Succeeded", { exact: true })).toBeVisible();
  await prompts.getByRole("button", { name: "Prompt Library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Prompts", exact: true });
  await library.getByRole("button", { name: "Edit name / general notes" }).click();
  await library.getByLabel("General notes", { exact: true }).fill("Mutable general guidance");
  await library.getByRole("button", { name: "Save details", exact: true }).click();
  await expect(library.getByText("General notes: Mutable general guidance", { exact: true })).toBeVisible();
  expect((await (await request.get(`${apiUrl}/api/prompts/${copied.prompt.id}/versions`)).json()).prompt_versions).toHaveLength(1);
  await library.getByRole("button", { name: "Delete Prompt", exact: true }).click();
  await expect(library.getByText(/Remove from Batch first/)).toBeVisible();
  await library.getByRole("button", { name: "Cancel", exact: true }).click();
  await library.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Preview Batch", exact: true }).click();
  await expect(page.getByRole("button", { name: "Create Another Run", exact: true })).toBeEnabled();
  await prompts.getByRole("button", { name: "Edit Prompt", exact: true }).click();
  await expect(library.getByRole("textbox", { name: "Prompt template", exact: true })).toHaveValue(text);
  await expect(library.getByRole("button", { name: "Save revision", exact: true })).toBeDisabled();
  const editedText = "Updated " + text;
  await library.getByRole("textbox", { name: "Prompt template", exact: true }).fill(editedText);
  await library.getByLabel("Revision note (optional)").fill("Immutable change reason");
  await library.getByRole("button", { name: "Save revision", exact: true }).click();
  await expect(library).toHaveCount(0);
  await expect(prompts.locator(".prompt-card pre")).toHaveJSProperty("textContent", editedText);
  await expect(page.getByRole("button", { name: "Create Another Run", exact: true })).toHaveCount(0);
  const editedPreview = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/batches/preview");
  await page.getByRole("button", { name: "Preview Batch", exact: true }).click();
  expect((await (await editedPreview).json() as PreviewResponse).jobs[0].resolved_prompt).toBe(editedText.replace("{{subject}}", "mountain"));
  await expect.poll(() => page.evaluate(() => localStorage.getItem("batchcraft.working-session-recovery.v4"))).toContain("Updated ");
  const otherBrowserRecovery = await page.evaluate(() => localStorage.getItem("batchcraft.working-session-recovery.v4"));
  expect(otherBrowserRecovery).not.toBeNull();
  // Removing an unsaved row does not clear the persisted v1 reference.
  await prompts.getByRole("button", { name: "Remove", exact: true }).click();
  await prompts.getByRole("button", { name: "Prompt Library", exact: true }).click();
  await library.getByRole("button", { name: "Delete Prompt", exact: true }).click();
  await expect(library.getByRole("button", { name: "Permanently delete", exact: true })).toBeEnabled();
  await library.getByRole("button", { name: "Permanently delete", exact: true }).click();
  await expect(library.getByRole("alert")).toContainText("Saved Batch references one of its revisions");
  await library.getByRole("button", { name: "Cancel", exact: true }).click();
  await library.getByRole("button", { name: "Close", exact: true }).click();
  const cleared = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/batches/${batch.id}` && r.request().method() === "PATCH");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await cleared).ok()).toBe(true);
  await prompts.getByRole("button", { name: "Prompt Library", exact: true }).click();
  await library.getByRole("button", { name: "Delete Prompt", exact: true }).click();
  await expect(library.getByRole("button", { name: "Permanently delete", exact: true })).toBeEnabled();
  await library.screenshot({ path: testInfo.outputPath("prompt-delete-confirmation.png") });
  const deletion = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/prompts/${copied.prompt.id}` && r.request().method() === "DELETE");
  await library.getByRole("button", { name: "Permanently delete", exact: true }).click();
  expect((await deletion).status()).toBe(204);
  await expect(library.getByRole("button", { name: "Delete Prompt", exact: true })).toHaveCount(0);
  expect((await (await request.get(`${apiUrl}/api/runs/${run.run_id}`)).json() as RunResponse).prompt_versions).toEqual(frozen.prompt_versions);
  await page.reload();
  await expect(page.getByRole("group", { name: "Prompts", exact: true })).toContainText("0 prompts");
  expect((await (await request.get(`${apiUrl}/api/projects/${project.id}/prompts`)).json()).prompts).toHaveLength(0);
  // A different browser's untracked recovery still has exact text, but no editable library record.
  await page.addInitScript((value) => localStorage.setItem("batchcraft.working-session-recovery.v4", value!), otherBrowserRecovery);
  // Hydrate the recovery snapshots first, then settle the three real integrity bodies together.
  await page.addInitScript(({ workflowId, profileId }) => {
    const fetch = window.fetch.bind(window);
    const seen = new Map<string, number>();
    const releases: Array<() => void> = [];
    window.fetch = async (...args) => {
      const response = await fetch(...args);
      const path = new URL(response.url).pathname;
      const workflow = path === `/api/workflow-versions/${workflowId}` || path === `/api/workflow-profile-versions/${profileId}`;
      const prompt = path.startsWith("/api/prompt-versions/");
      if (!workflow && !prompt) return response;
      const count = (seen.get(path) ?? 0) + 1;
      seen.set(path, count);
      if (workflow && count === 1) return response;
      const json = response.json.bind(response);
      response.json = async () => {
        const body: unknown = await json();
        await new Promise<void>((resolve) => {
          releases.push(resolve);
          if (releases.length >= 3) releases.forEach((release) => release());
        });
        return body;
      };
      return response;
    };
  }, { workflowId: workflow.version.id, profileId: profile.version.id });
  await page.reload();
  await expect(prompts.locator(".prompt-card pre")).toHaveJSProperty("textContent", editedText);
  await expect(prompts.getByText(/detached from the Prompt library/)).toBeVisible();
  await expect(prompts.getByRole("button", { name: "Edit Prompt", exact: true })).toBeDisabled();
});
