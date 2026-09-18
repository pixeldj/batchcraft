import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import type { GlobalCopyResponse, GlobalProfileFamily, LibraryPage, ProjectResponse, ProjectCopyResponse, SetupCopyRequest } from "../src/api/types";
import { appearanceStorageKey, paletteStorageKey } from "../src/features/settings/appearance";

// BC-026: reusable real-API before/after fixtures. Use a fresh output directory per capture.
// BATCHCRAFT_COPY_CAPTURE_DIR keeps evidence outside Playwright's cleaned output directory.
const apiUrl = "http://127.0.0.1:8002";
const workflow = {
  "1": { class_type: "CLIPTextEncode", inputs: { text: "Alpine landscape" } },
  "2": { class_type: "KSampler", inputs: { seed: 1, steps: 20, cfg: 7.5 } },
  "3": { class_type: "SaveImage", inputs: { filename_prefix: "synthetic-copy" } },
};
const cases = ["one-profile", "many-profiles", "long-names", "no-profiles", "name-collision"] as const;

async function post<T>(request: APIRequestContext, path: string, data: object): Promise<T> {
  const response = await request.post(`${apiUrl}${path}`, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as T;
}

test("BC-026 singleton intent, direct Refresh recovery and conservative discovery", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  await page.addInitScript(({ appearanceStorageKey, paletteStorageKey }) => {
    localStorage.setItem(appearanceStorageKey, "dark");
    localStorage.setItem(paletteStorageKey, "synthwave");
  }, { appearanceStorageKey, paletteStorageKey });
  const name = `Singleton ${randomUUID()}`;
  const project = await post<ProjectResponse>(request, "/api/projects", { name, filesystem_key: `copy_${randomUUID()}` });
  const source = await post<GlobalCopyResponse["workflow"]>(request, "/api/library/workflows", { request_id: randomUUID(), name, workflow });
  const profile = await post<GlobalCopyResponse["profiles"][number]>(request, `/api/library/workflows/${source.workflow.id}/profiles`, {
    request_id: randomUUID(), name: "Sampling controls", workflow_version_id: source.version.id,
    mappings: {
      prompt: { node_id: "1", input_name: "text", value_type: "string" },
      seed: { node_id: "2", input_name: "seed", value_type: "integer" },
      output_prefix: { node_id: "3", input_name: "filename_prefix", value_type: "string" },
    }, image_inputs: [], parameters: [],
  });
  await page.goto("/");
  await page.getByLabel("Active Project").selectOption(project.id);
  const unchangedWorkflow = await page.getByLabel("Workflow JSON", { exact: true }).inputValue();
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Workflow Library", exact: true }).click();
  const library = page.getByRole("region", { name: "Global Workflow Library" });
  await library.getByLabel("Search Workflow Library").fill(name);
  await library.getByLabel("Search Workflow Library").press("Enter");
  await library.getByRole("button", { name, exact: true }).click();
  const path = `/api/library/workflows/${source.workflow.id}/profiles`;
  const pattern = `**${path}?*`;
  const discovery = page.waitForResponse((response) => new URL(response.url()).pathname === path);
  await library.getByRole("button", { name: "Add to Project", exact: true }).click();
  const response = await discovery;
  expect(response.ok()).toBe(true);
  expect(new URL(response.url()).searchParams.get("workflow_version_id")).toBe(source.version.id);
  const metadata = await response.json() as LibraryPage<GlobalProfileFamily>;
  expect(metadata.next_cursor).toBeNull();
  expect(metadata.items).toHaveLength(1);
  expect(metadata.items[0].latest_compatible_version_id).toBe(profile.version.id);
  const review = page.getByRole("dialog", { name: "Add workflow to Project", exact: true });
  const add = review.getByRole("button", { name: "Add to Project", exact: true });
  const refresh = review.getByRole("button", { name: "Refresh", exact: true });
  const checkbox = review.getByRole("checkbox", { name: profile.workflow_profile.name, exact: true });
  const label = review.locator("label.checkbox-row > span").filter({ hasText: profile.workflow_profile.name });
  const trigger = review.getByRole("button", { name: `Copy actions for ${profile.workflow_profile.name}`, exact: true });
  const writes: SetupCopyRequest[] = [];
  page.on("request", (sent) => { if (sent.method() === "POST" && sent.url().endsWith("/use-in-project")) writes.push(sent.postDataJSON() as SetupCopyRequest); });
  await expect(add).toBeEnabled();
  await expect(checkbox).toBeChecked();
  await expect(review.getByRole("button", { name: "Profile list actions", exact: true })).toHaveCount(0);
  await expect(refresh.locator("svg")).toBeVisible();
  await expect(refresh.locator("svg")).toHaveAttribute("aria-hidden", "true");
  await expect(review.getByText("1 selected", { exact: true })).toHaveCount(0);
  await trigger.press("ArrowDown");
  await expect(review.getByRole("menuitem")).toHaveText(["Inspect mappings", "Rename", "Choose revision"]);
  await page.keyboard.press("ArrowDown");
  await expect(review.getByRole("menuitem", { name: "Rename", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  const rename = review.getByLabel(`Copy name for ${profile.workflow_profile.name}`);
  await expect(rename).toBeFocused();
  await rename.fill("Pinned copy name");
  await expect(checkbox).toBeChecked();

  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  await page.route(pattern, async (route) => {
    reads++;
    await barrier;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "fixture_unavailable", message: "Synthetic refresh unavailable" } }) });
  });
  await refresh.click();
  await expect(refresh).toBeDisabled();
  await refresh.evaluate((element: HTMLButtonElement) => { element.click(); element.click(); });
  await expect.poll(() => reads).toBe(1);
  await expect(add).toBeDisabled();
  await expect(checkbox).toBeChecked();
  await expect(rename).toHaveValue("Pinned copy name");
  await capture(page, testInfo, "singleton-refresh-loading");
  release();
  await expect(review.getByRole("alert")).toContainText("Synthetic refresh unavailable");
  await expect(checkbox).toBeChecked();
  await expect(rename).toHaveValue("Pinned copy name");
  await capture(page, testInfo, "singleton-refresh-failure");
  await page.unroute(pattern);
  await review.getByRole("button", { name: "Retry Profiles", exact: true }).click();
  await expect(add).toBeEnabled();
  await expect(checkbox).toBeChecked();
  await expect(rename).toHaveValue("Pinned copy name");
  expect(writes).toEqual([]);
  const copied = page.waitForResponse((item) => item.url().endsWith("/use-in-project") && item.request().method() === "POST");
  await add.click();
  expect((await copied).ok()).toBe(true);
  expect(writes[0]).toMatchObject({ workflow_version_id: source.version.id, profiles: [{ version_id: profile.version.id, name: "Pinned copy name" }] });
  await expect(review).not.toBeVisible();

  await library.getByRole("button", { name: "Add to Project", exact: true }).click();
  await expect(checkbox).toBeChecked();
  await label.click();
  await expect(checkbox).not.toBeChecked();
  await trigger.click();
  await expect(checkbox).not.toBeChecked();
  await expect(review.getByRole("menuitem", { name: "Rename", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await refresh.click();
  await expect(add).toBeEnabled();
  await expect(checkbox).not.toBeChecked();
  await expect(review.getByText("Only the Workflow will be added", { exact: true })).toBeVisible();
  await expect(review.getByRole("alert")).toHaveCount(0);
  await capture(page, testInfo, "singleton-deliberately-unchecked");
  await review.getByRole("button", { name: "Cancel", exact: true }).click();

  // An older metadata response cannot establish singleton eligibility, even if Refresh later can.
  await page.route(pattern, async (route) => {
    const response = await route.fetch();
    const body = await response.json() as LibraryPage<GlobalProfileFamily>;
    expect(body.items).toHaveLength(1);
    body.items[0].latest_compatible_version = null;
    await route.fulfill({ response, json: body });
  });
  await library.getByRole("button", { name: "Add to Project", exact: true }).click();
  await expect(add).toBeEnabled();
  await expect(checkbox).not.toBeChecked();
  await page.unroute(pattern);
  await refresh.click();
  await expect(add).toBeEnabled();
  await expect(checkbox).not.toBeChecked();
  await review.getByRole("button", { name: "Cancel", exact: true }).click();

  await library.getByRole("button", { name: profile.workflow_profile.name, exact: true }).click();
  await expect(library.getByRole("region", { name: "Selected Profile", exact: true })).toBeVisible();
  await library.getByRole("button", { name: "Clear Profile selection", exact: true }).click();
  await library.getByRole("button", { name: "Reload library", exact: true }).click();
  for (let session = 0; session < 2; session++) {
    await library.getByRole("button", { name: "Add to Project", exact: true }).click();
    await expect(add).toBeEnabled();
    await expect(checkbox).not.toBeChecked();
    await refresh.click();
    await expect(add).toBeEnabled();
    await expect(checkbox).not.toBeChecked();
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
  }
  expect(writes).toHaveLength(1);
  expect(await page.getByLabel("Workflow JSON", { exact: true }).inputValue()).toBe(unchangedWorkflow);
});

test("BC-026 Add recovery, exact revisions, pending receipt and explicit Apply", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(10_000);
  await page.addInitScript(({ appearanceStorageKey, paletteStorageKey }) => {
    localStorage.setItem(appearanceStorageKey, "dark");
    localStorage.setItem(paletteStorageKey, "synthwave");
  }, { appearanceStorageKey, paletteStorageKey });
  const name = `Alpine copy - recovery - ${testInfo.project.name}`;
  const project = await post<ProjectResponse>(request, "/api/projects", { name: `Editorial recovery ${testInfo.project.name}`, filesystem_key: `copy_${randomUUID()}` });
  const source = await post<GlobalCopyResponse["workflow"]>(request, "/api/library/workflows", { request_id: randomUUID(), name, workflow });
  const profile = await post<GlobalCopyResponse["profiles"][number]>(request, `/api/library/workflows/${source.workflow.id}/profiles`, {
    request_id: randomUUID(), name: "Original mapping copy", workflow_version_id: source.version.id,
    mappings: {
      prompt: { node_id: "1", input_name: "text", value_type: "string" },
      seed: { node_id: "2", input_name: "seed", value_type: "integer" },
      output_prefix: { node_id: "3", input_name: "filename_prefix", value_type: "string" },
    }, image_inputs: [], parameters: [],
  });
  const latest = await post<GlobalCopyResponse["profiles"][number]["version"]>(request, `/api/library/workflow-profiles/${profile.workflow_profile.id}/versions`, {
    request_id: randomUUID(), workflow_version_id: source.version.id, mappings: profile.version.profile.mappings,
    image_inputs: [], parameters: [], note: "Later revision must not replace the explicitly chosen original",
  });
  const renamed = "Current mapping copy";
  const metadata = await request.patch(`${apiUrl}/api/library/workflow-profiles/${profile.workflow_profile.id}`, { data: { request_id: randomUUID(), name: renamed } });
  expect(metadata.ok(), await metadata.text()).toBe(true);
  const alternate = await post<GlobalCopyResponse["profiles"][number]>(request, `/api/library/workflows/${source.workflow.id}/profiles`, {
    request_id: randomUUID(), name: "Alternate guidance mapping", workflow_version_id: source.version.id,
    mappings: profile.version.profile.mappings, image_inputs: [],
    parameters: [{ key: "cfg", label: "Alternate guidance", node_id: "2", input_name: "cfg", value_type: "float" }],
  });
  await page.goto("/");
  await page.getByLabel("Active Project").selectOption(project.id);
  const emptyWorkflow = await page.getByLabel("Workflow JSON", { exact: true }).inputValue();
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Workflow Library", exact: true }).click();
  const library = page.getByRole("region", { name: "Global Workflow Library" });
  await library.getByLabel("Search Workflow Library").fill(name);
  await library.getByLabel("Search Workflow Library").press("Enter");
  await library.getByRole("button", { name, exact: true }).click();
  await library.getByRole("button", { name: renamed, exact: true }).click();
  await expect(library.getByRole("region", { name: "Selected Profile" })).toContainText("Selected revision 2");

  let releaseRead!: () => void;
  const readBarrier = new Promise<void>((resolve) => { releaseRead = resolve; });
  const readPattern = `**/api/library/workflows/${source.workflow.id}/profiles?*`;
  await page.route(readPattern, async (route) => {
    await readBarrier;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "fixture_unavailable", message: "Synthetic Profile list unavailable" } }) });
  });
  const writes: SetupCopyRequest[] = [];
  page.on("request", (sent) => { if (sent.method() === "POST" && sent.url().endsWith("/use-in-project")) writes.push(sent.postDataJSON() as SetupCopyRequest); });
  await library.getByRole("button", { name: "Add to Project", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Add workflow to Project", exact: true });
  const add = review.getByRole("button", { name: "Add to Project", exact: true });
  await expect(review).toContainText("Loading compatible Profiles...");
  await expect(add).toBeDisabled();
  await capture(page, testInfo, "recovery-loading");
  releaseRead();
  await expect(review.getByRole("alert")).toContainText("Synthetic Profile list unavailable");
  await capture(page, testInfo, "recovery-list-error");
  expect(writes).toHaveLength(0);
  await page.unroute(readPattern);
  await review.getByRole("button", { name: "Retry Profiles", exact: true }).click();
  await expect(add).toBeEnabled();
  expect(writes).toHaveLength(0);
  const trigger = review.getByRole("button", { name: `Copy actions for ${renamed}`, exact: true });
  await trigger.press("ArrowDown");
  await expect(review.getByRole("menuitem", { name: "Inspect mappings", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(review).toBeVisible();
  await expect(trigger).toBeFocused();
  // Late A revision responses must not replace B's inspection or commit an abandoned choice.
  for (const action of ["close", "switch"]) {
    let releaseRevision!: () => void;
    let reachedRevision!: () => void;
    const barrier = new Promise<void>((resolve) => { releaseRevision = resolve; });
    const reached = new Promise<void>((resolve) => { reachedRevision = resolve; });
    const revisionPath = `/api/library/workflow-profile-versions/${profile.version.id}`;
    await page.route(`**${revisionPath}`, async (route) => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      reachedRevision();
      await barrier;
      await route.fulfill({ response });
    });
    await trigger.click();
    await review.getByRole("menuitem", { name: "Choose revision", exact: true }).click();
    await review.getByRole("region", { name: "Choose Profile revision", exact: true }).getByRole("button", { name: /^Revision 1 \// }).click();
    await reached;
    await expect(add).toBeDisabled();
    const aborted = page.waitForEvent("requestfailed", { predicate: (sent) => new URL(sent.url()).pathname === revisionPath });
    if (action === "close") {
      await page.keyboard.press("Escape");
      await expect(review).toBeVisible();
      await expect(trigger).toBeFocused();
    } else {
      await review.getByRole("button", { name: `Copy actions for ${alternate.workflow_profile.name}`, exact: true }).click();
      await review.getByRole("menuitem", { name: "Inspect mappings", exact: true }).click();
      await expect(review.getByRole("region", { name: "Inspect Profile mappings", exact: true })).toContainText("Alternate guidance");
    }
    await aborted;
    releaseRevision();
    await page.unrouteAll({ behavior: "wait" });
    await expect(add).toBeEnabled();
    if (action === "switch") {
      await expect(review.getByRole("region", { name: "Inspect Profile mappings", exact: true })).toContainText("Alternate guidance");
      await review.getByRole("button", { name: "Close mappings", exact: true }).click();
    }
    const inspectLatest = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/library/workflow-profile-versions/${latest.id}`);
    await trigger.click();
    await review.getByRole("menuitem", { name: "Inspect mappings", exact: true }).click();
    expect((await inspectLatest).ok()).toBe(true);
    await review.getByRole("button", { name: "Close mappings", exact: true }).click();
    await expect(review.getByRole("checkbox", { name: renamed, exact: true })).toBeChecked();
    await expect(review.getByRole("checkbox", { name: alternate.workflow_profile.name, exact: true })).not.toBeChecked();
    expect(writes).toHaveLength(0);
  }
  await trigger.click();
  await review.getByRole("menuitem", { name: "Choose revision", exact: true }).click();
  const chooser = review.getByRole("region", { name: "Choose Profile revision", exact: true });
  await chooser.getByRole("button", { name: /^Revision 1 \// }).click();
  await expect(review.getByText("Loading exact Profile revision...", { exact: true })).toHaveCount(0);
  await expect(chooser.getByText("Technical mapping targets", { exact: true })).toBeVisible();
  await capture(page, testInfo, "recovery-exact-revision");
  await review.getByRole("button", { name: "Close revision chooser", exact: true }).click();
  await expect(trigger).toBeFocused();

  const exactPattern = `**/api/library/workflow-profile-versions/${profile.version.id}`;
  await page.route(exactPattern, (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "not_found", message: "Synthetic missing exact revision" } }) }));
  await review.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(review.getByRole("alert")).toContainText("Synthetic missing exact revision");
  await expect(add).toBeDisabled();
  await expect(review.getByRole("checkbox", { name: renamed, exact: true })).toBeChecked();
  expect(writes).toHaveLength(0);
  await page.unroute(exactPattern);
  await review.getByRole("button", { name: "Retry Profiles", exact: true }).click();
  await expect(add).toBeEnabled();
  await post(request, `/api/library/workflow-profile-versions/${profile.version.id}/archive`, { request_id: randomUUID(), archived: true });
  await review.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(review.getByRole("alert")).toContainText("archived");
  await expect(add).toBeDisabled();
  const pinned = review.getByRole("checkbox", { name: renamed, exact: true });
  await expect(pinned).toBeChecked();
  await pinned.uncheck();
  await expect(add).toBeEnabled();
  await expect(review.getByText("Only the Workflow will be added", { exact: true })).toBeVisible();
  expect(writes).toHaveLength(0);
  await post(request, `/api/library/workflow-profile-versions/${profile.version.id}/archive`, { request_id: randomUUID(), archived: false });
  await review.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(add).toBeEnabled();
  await expect(pinned).not.toBeChecked();
  await pinned.check();
  await expect(add).toBeEnabled();

  let releaseWrite!: () => void;
  let reachedWrite!: () => void;
  const writeBarrier = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const writeReached = new Promise<void>((resolve) => { reachedWrite = resolve; });
  let stored: ProjectCopyResponse | undefined;
  // Commit through the real API, then withhold its response to exercise ambiguous completion.
  await page.route("**/api/library/workflows/use-in-project", async (route) => {
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    stored = await response.json() as ProjectCopyResponse;
    reachedWrite();
    await writeBarrier;
    await route.fulfill({ response });
  });
  await add.click();
  await writeReached;
  await expect(review.getByRole("button", { name: "Adding...", exact: true })).toBeDisabled();
  await review.locator("form").evaluate((form: HTMLFormElement) => { for (let index = 0; index < 10; index++) form.requestSubmit(); });
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ project_id: project.id, workflow_version_id: source.version.id, name, profiles: [{ version_id: profile.version.id, name: renamed }] });
  await capture(page, testInfo, "recovery-pending");
  await review.getByRole("button", { name: "Stop waiting", exact: true }).click();
  await expect(review).not.toBeVisible();
  releaseWrite();
  await page.unrouteAll({ behavior: "wait" });
  await post(request, `/api/library/workflow-profile-versions/${profile.version.id}/archive`, { request_id: randomUUID(), archived: true });
  await library.getByRole("button", { name: "Add to Project", exact: true }).click();
  await expect(review.getByRole("alert")).toContainText("archived");
  await expect(add).toBeEnabled();
  await review.getByRole("button", { name: "Rename Workflow", exact: true }).click();
  await expect(review.getByLabel("New Workflow name (optional)")).toHaveValue(name);
  await review.getByRole("button", { name: "Hide Workflow rename", exact: true }).click();
  const replayPending = page.waitForResponse((response) => response.url().endsWith("/use-in-project") && response.request().method() === "POST");
  await add.click();
  const replay = await replayPending;
  expect(replay.ok(), await replay.text()).toBe(true);
  expect(await replay.json()).toEqual(stored);
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  await expect(review).not.toBeVisible();
  const confirmation = library.getByRole("region", { name: "Added to Project", exact: true });
  await expect(confirmation).toContainText(project.name);
  await expect(confirmation).toContainText(name);
  expect(await page.getByLabel("Workflow JSON", { exact: true }).inputValue()).toBe(emptyWorkflow);
  page.once("dialog", async (dialog) => { expect(dialog.message()).toContain("Replace the Batch Workflow Setup"); await dialog.dismiss(); });
  await confirmation.getByRole("button", { name: "Apply to Batch", exact: true }).click();
  await expect(confirmation).toBeVisible();
  expect(await page.getByLabel("Workflow JSON", { exact: true }).inputValue()).toBe(emptyWorkflow);
  page.once("dialog", async (dialog) => { await dialog.accept(); });
  await confirmation.getByRole("button", { name: "Apply to Batch", exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await page.getByRole("group", { name: "Workflow Setup", exact: true }).getByRole("button", { name: "Change", exact: true }).click();
  expect(JSON.parse(await page.getByLabel("Workflow JSON", { exact: true }).inputValue())).toEqual(workflow);
  expect(JSON.parse(await page.getByLabel("Workflow Profile JSON", { exact: true }).inputValue())).toEqual(stored!.profiles[0].version.profile);
});

async function capture(page: Page, testInfo: TestInfo, state: string) {
  const output = (name: string) => process.env.BATCHCRAFT_COPY_CAPTURE_DIR
    ? join(process.env.BATCHCRAFT_COPY_CAPTURE_DIR, `${testInfo.project.name}-${state}-${name}`)
    : testInfo.outputPath(`${state}-${name}`);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(async () => {
      await document.fonts.ready;
      window.scrollTo(0, 0);
      document.querySelectorAll("dialog, dialog form, dialog fieldset").forEach((element) => element.scrollTo(0, 0));
    });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute("data-palette", "synthwave");
    const modal = page.getByRole("dialog", { name: "Add workflow to Project", exact: true });
    const dialog = await modal.count() ? modal : page.getByRole("region", { name: "Added to Project", exact: true });
    if (!await modal.count()) await dialog.scrollIntoViewIfNeeded();
    await page.screenshot({ path: output(`${width}.png`), scale: "css", animations: "disabled" });
    if (await modal.count()) {
      const geometry = await modal.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const header = element.querySelector("header")!.getBoundingClientRect();
        const footer = element.querySelector("footer")!.getBoundingClientRect();
        return { fits: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
          widthFits: element.scrollWidth <= element.clientWidth, headerTop: header.top, footerBottom: footer.bottom, height: box.height };
      });
      expect.soft(geometry.fits, `${state}/${width}: modal fits viewport`).toBe(true);
      expect.soft(geometry.widthFits, `${state}/${width}: no horizontal overflow`).toBe(true);
      expect.soft(geometry.headerTop).toBeGreaterThanOrEqual(0);
      expect.soft(geometry.footerBottom).toBeLessThanOrEqual(900);
      if (state === "one-profile" && width >= 1024) expect.soft(geometry.height, "Common case is content-sized, not a reserved list panel").toBeLessThan(500);
      const rows = await modal.locator(".project-add-profile").evaluateAll((elements) => elements.map((element) => {
        const checkbox = element.querySelector("input[type=checkbox]")!.getBoundingClientRect();
        const name = element.querySelector("label > span")!.getBoundingClientRect();
        const menu = element.querySelector("button")!.getBoundingClientRect();
        return { centerDelta: Math.abs(checkbox.top + checkbox.height / 2 - name.top - name.height / 2), nameRight: name.right, menuLeft: menu.left, menuWidth: menu.width };
      }));
      for (const row of rows) {
        expect.soft(row.centerDelta, `${state}/${width}: checkbox vertically centered with source name`).toBeLessThanOrEqual(2);
        expect.soft(row.menuLeft - row.nameRight, `${state}/${width}: name does not overlap menu`).toBeGreaterThanOrEqual(4);
        expect.soft(row.menuWidth, `${state}/${width}: compact row menu trigger`).toBeLessThanOrEqual(48);
      }
      const workflowName = modal.locator(".project-add-workflow p");
      if (await workflowName.count()) {
        const value = await workflowName.boundingBox();
        const rename = await modal.getByRole("button", { name: "Rename Workflow", exact: true }).boundingBox();
        expect.soft(Math.abs(value!.y + value!.height - rename!.y - rename!.height), `${state}/${width}: Rename aligned with Workflow value`).toBeLessThanOrEqual(2);
      }
    }
    await writeFile(output(`${width}.json`), JSON.stringify({
      text: await dialog.innerText(),
      geometry: await dialog.evaluate((element) => ({
        bounds: element.getBoundingClientRect().toJSON(),
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
        clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
        focus: document.activeElement?.outerHTML.slice(0, 1000),
        theme: document.documentElement.dataset.theme, palette: document.documentElement.dataset.palette,
      })),
    }, null, 2));
  }
}

for (const scenario of cases) {
  test(`BC-026 Add to Project capture: ${scenario}`, async ({ page, request }, testInfo) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(10_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(({ appearanceStorageKey, paletteStorageKey }) => {
      localStorage.setItem(appearanceStorageKey, "dark");
      localStorage.setItem(paletteStorageKey, "synthwave");
    }, { appearanceStorageKey, paletteStorageKey });
    const project = await post<ProjectResponse>(request, "/api/projects", {
      name: `Alpine editorial - ${scenario} - ${testInfo.project.name}`,
      filesystem_key: `copy_${randomUUID()}`,
    });
    const baseName = scenario === "long-names"
      ? "Alpine editorial portrait and reference-guided cinematic landscape exploration with carefully controlled evening lighting"
      : `Alpine landscape - ${scenario}`;
    const name = `${baseName}${testInfo.project.name === "mobile" ? " - mobile" : ""}`;
    const source = await post<GlobalCopyResponse["workflow"]>(request, "/api/library/workflows", {
      request_id: randomUUID(), name, workflow,
    });
    const profiles: GlobalCopyResponse["profiles"] = [];
    const count = scenario === "no-profiles" ? 0 : scenario === "many-profiles" ? 23 : 1;
    for (let index = 1; index <= count; index++) {
      profiles.push(await post(request, `/api/library/workflows/${source.workflow.id}/profiles`, {
        request_id: randomUUID(),
        name: scenario === "long-names"
          ? "Reference-guided portrait with reproducible sampling and carefully controlled lighting for an extended editorial study"
          : `Profile ${String(index).padStart(2, "0")} - Sampling controls`,
        workflow_version_id: source.version.id,
        mappings: {
          prompt: { node_id: "1", input_name: "text", value_type: "string" },
          seed: { node_id: "2", input_name: "seed", value_type: "integer" },
          output_prefix: { node_id: "3", input_name: "filename_prefix", value_type: "string" },
        },
        image_inputs: [],
        parameters: [{ key: "steps", label: "Sampling steps", node_id: "2", input_name: "steps", value_type: "integer" }],
      }));
    }
    if (scenario === "name-collision") {
      await post(request, `/api/projects/${project.id}/workflows`, { name, workflow });
    }

    await page.goto("/");
    await page.getByLabel("Active Project").selectOption(project.id);
    await expect(page.getByLabel("Active Project")).toHaveValue(project.id);
    const emptyWorkflow = await page.getByLabel("Workflow JSON", { exact: true }).inputValue();
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Workflow Library", exact: true }).click();
    const library = page.getByRole("region", { name: "Global Workflow Library" });
    await library.getByLabel("Search Workflow Library").fill(name);
    await library.getByLabel("Search Workflow Library").press("Enter");
    await library.getByRole("button", { name, exact: true }).click();
    if (profiles.length && scenario !== "one-profile" && scenario !== "many-profiles") {
      await library.getByRole("button", { name: profiles[0].workflow_profile.name, exact: true }).click();
      await expect(library.getByRole("region", { name: "Selected Profile", exact: true })).toBeVisible();
    }
    await library.getByRole("button", { name: "Add to Project", exact: true }).click();
    const review = page.getByRole("dialog", { name: "Add workflow to Project", exact: true });
    const add = review.getByRole("button", { name: "Add to Project", exact: true });
    const confirmation = library.getByRole("region", { name: "Added to Project", exact: true });
    await expect(add).toBeEnabled();
    await expect(review).toContainText(project.name);
    await expect(review.getByRole("heading", { name: "Include Profiles", exact: true })).toBeVisible();
    await expect(review.getByText("Adds independent copies. Your Batch stays unchanged.", { exact: true })).toBeVisible();
    await expect(review.getByRole("textbox")).toHaveCount(0);
    await expect(review.getByLabel("Search compatible Profiles")).toHaveCount(scenario === "many-profiles" ? 1 : 0);
    if (scenario !== "many-profiles") {
      await expect(review.getByRole("button", { name: "Next Profiles", exact: true })).toHaveCount(0);
      await expect(review.getByRole("button", { name: /Review all selected Profiles/ })).toHaveCount(0);
    }
    if (profiles.length) {
      if (scenario === "many-profiles") {
        await expect(review.locator('input[type="checkbox"]:checked')).toHaveCount(0);
        await expect(review.getByText("0 selected", { exact: true })).toBeVisible();
        await review.getByRole("checkbox", { name: profiles[0].workflow_profile.name, exact: true }).check();
      }
      await expect(review.getByRole("checkbox", { name: profiles[0].workflow_profile.name, exact: true })).toBeChecked();
      await expect(review.getByText("1 selected", { exact: true })).toHaveCount(scenario === "many-profiles" ? 1 : 0);
      await expect(review).not.toContainText("1/50");
    }
    await capture(page, testInfo, scenario);

    async function profileAction(profileName: string, action: string) {
      const trigger = review.getByRole("button", { name: `Copy actions for ${profileName}`, exact: true });
      await trigger.click();
      const menu = review.getByRole("menu", { name: `Copy actions for ${profileName}`, exact: true });
      await expect(menu).toBeVisible();
      expect(await menu.evaluate((element) => Boolean(element.closest("dialog:modal")))).toBe(true);
      await menu.getByRole("menuitem", { name: action, exact: true }).click();
      return trigger;
    }

    if (scenario === "long-names") {
      const profileName = profiles[0].workflow_profile.name;
      await review.getByRole("button", { name: `Copy actions for ${profileName}`, exact: true }).click();
      await expect(review.getByRole("menuitem")).toHaveText(["Inspect mappings", "Rename", "Choose revision"]);
      await expect(review.getByRole("checkbox", { name: profileName, exact: true })).toBeChecked();
      await capture(page, testInfo, "long-names-menu");
      await page.keyboard.press("Escape");
      const trigger = await profileAction(profileName, "Inspect mappings");
      await expect(review.getByRole("region", { name: "Inspect Profile mappings" })).toContainText("Sampling steps");
      await review.getByRole("button", { name: "Close mappings", exact: true }).click();
      await expect(trigger).toBeFocused();
      await profileAction(profileName, "Rename");
      await review.getByLabel(`Copy name for ${profileName}`).fill(`${profileName} copy`);
      await profileAction(profileName, "Hide rename");
      await expect(review.getByLabel(`Copy name for ${profileName}`)).toHaveCount(0);
      await profileAction(profileName, "Rename");
      await expect(review.getByLabel(`Copy name for ${profileName}`)).toHaveValue(`${profileName} copy`);
      await review.getByRole("button", { name: "Rename Workflow", exact: true }).click();
      await review.getByLabel("New Workflow name (optional)").fill(`${name} copy`);
      await review.getByRole("button", { name: "Hide Workflow rename", exact: true }).click();
      await review.getByRole("button", { name: "Rename Workflow", exact: true }).click();
      await expect(review.getByLabel("New Workflow name (optional)")).toHaveValue(`${name} copy`);
      await capture(page, testInfo, "long-names-rename");
      for (const [action, region] of [["Inspect mappings", "Inspect Profile mappings"], ["Choose revision", "Choose Profile revision"]]) {
        if (!await review.count()) {
          await library.getByRole("button", { name: "Add to Project", exact: true }).click();
          await expect(add).toBeEnabled();
          await profileAction(profileName, "Rename");
          await review.getByLabel(`Copy name for ${profileName}`).fill(`${profileName} copy`);
          await review.getByRole("button", { name: "Rename Workflow", exact: true }).click();
          await review.getByLabel("New Workflow name (optional)").fill(`${name} copy`);
        }
        const opener = await profileAction(profileName, action);
        await expect(review.getByRole("region", { name: region, exact: true })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(review.getByRole("region", { name: region, exact: true })).toHaveCount(0);
        await expect(review).toBeVisible();
        await expect(opener).toBeFocused();
        await expect(review.getByLabel("New Workflow name (optional)")).toHaveValue(`${name} copy`);
        await expect(review.getByLabel(`Copy name for ${profileName}`)).toHaveValue(`${profileName} copy`);
        await expect(review.getByRole("checkbox", { name: profileName, exact: true })).toBeChecked();
        await page.keyboard.press("Escape");
        await expect(review).not.toBeVisible();
        await expect(library.getByRole("button", { name: "Add to Project", exact: true })).toBeFocused();
      }
    }

    if (scenario === "many-profiles") {
      await review.getByRole("button", { name: "Next Profiles", exact: true }).click();
      await expect(review.getByRole("checkbox", { name: profiles[20].workflow_profile.name, exact: true })).toBeVisible();
      await capture(page, testInfo, "many-profiles-selected-offpage");
      await review.getByRole("checkbox", { name: profiles[20].workflow_profile.name, exact: true }).check();
      await review.getByLabel("Search compatible Profiles", { exact: true }).fill("Profile 23");
      await review.getByLabel("Search compatible Profiles", { exact: true }).press("Enter");
      await expect(review.getByRole("checkbox")).toHaveCount(1);
      await expect(review.getByRole("checkbox", { name: profiles[22].workflow_profile.name, exact: true })).not.toBeChecked();
      await capture(page, testInfo, "many-profiles-selected-filtered");
      await expect(review.getByText("2 selected", { exact: true })).toBeVisible();
      await review.getByRole("button", { name: "Review all selected Profiles (2)", exact: true }).click();
      await expect(review.getByRole("button", { name: `Remove ${profiles[0].workflow_profile.name}`, exact: true })).toBeVisible();
      await review.getByRole("button", { name: `Rename selected ${profiles[20].workflow_profile.name}`, exact: true }).click();
      await review.getByLabel(`Copy name for ${profiles[20].workflow_profile.name}`).fill(profiles[0].workflow_profile.name);
      let writes = 0;
      page.on("request", (sent) => { if (sent.method() === "POST" && sent.url().endsWith("/use-in-project")) writes++; });
      await add.click();
      await expect(review.getByRole("alert")).toContainText("distinct (case-sensitive)");
      expect(writes).toBe(0);
      await capture(page, testInfo, "many-profiles-duplicate-name");
      await review.getByLabel(`Copy name for ${profiles[20].workflow_profile.name}`).fill(profiles[20].workflow_profile.name);
      await review.getByLabel("Search compatible Profiles").fill("No such Profile");
      await review.getByLabel("Search compatible Profiles").press("Enter");
      await expect(review).toContainText("No Profiles match this search.");
      await expect(review.getByLabel("Search compatible Profiles")).toBeVisible();
      await capture(page, testInfo, "many-profiles-empty-search");
      await review.getByRole("button", { name: "Clear search", exact: true }).click();
      await expect(review.getByRole("checkbox")).toHaveCount(20);
    }
    if (scenario !== "long-names") {
      const pending = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/library/workflows/use-in-project" && response.request().method() === "POST");
      await add.click();
      const response = await pending;
      expect(response.request().postDataJSON()).toMatchObject({
        project_id: project.id, workflow_version_id: source.version.id, name,
        profiles: (scenario === "many-profiles" ? [profiles[0], profiles[20]] : profiles).map((profile) => ({ version_id: profile.version.id, name: profile.workflow_profile.name })),
      });
      if (scenario === "name-collision") {
        expect(response.status()).toBe(409);
        await expect(review.getByRole("alert")).toBeVisible();
        await expect(review.getByLabel("New Workflow name (optional)")).toHaveValue(name);
        await expect(review.getByLabel(`Copy name for ${profiles[0].workflow_profile.name}`)).toBeVisible();
      } else {
        expect(response.ok(), await response.text()).toBe(true);
        await expect(review).not.toBeVisible();
        await expect(confirmation.getByRole("status")).toContainText("Your Batch has not changed");
        await expect(confirmation).toContainText(project.name);
        await expect(confirmation).toContainText(name);
      }
      await capture(page, testInfo, `${scenario}-response`);
      if (scenario === "name-collision") {
        const original = response.request().postDataJSON() as SetupCopyRequest;
        const retryPending = page.waitForResponse((item) => item.url().endsWith("/use-in-project") && item.request().method() === "POST");
        await add.click();
        const retry = await retryPending;
        expect(retry.status()).toBe(409);
        expect(retry.request().postDataJSON()).toEqual(original);
        await review.getByLabel("New Workflow name (optional)").fill(`${name} copy`);
        const renamedPending = page.waitForResponse((item) => item.url().endsWith("/use-in-project") && item.request().method() === "POST");
        await add.click();
        const renamed = await renamedPending;
        expect(renamed.ok(), await renamed.text()).toBe(true);
        expect(renamed.request().postDataJSON().request_id).not.toBe(original.request_id);
        await expect(confirmation).toContainText(`${name} copy`);
      }
      if (scenario === "many-profiles") {
        const copied = await response.json() as ProjectCopyResponse;
        await expect(confirmation.getByRole("button", { name: "Apply to Batch", exact: true })).toBeDisabled();
        await confirmation.getByLabel("Copied Profile to apply").selectOption(copied.profiles[0].version.id);
        await expect(confirmation.getByRole("button", { name: "Apply to Batch", exact: true })).toBeEnabled();
      }
    }
    if (await review.count()) await review.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await page.getByLabel("Workflow JSON", { exact: true }).inputValue()).toBe(emptyWorkflow);
    await testInfo.attach("fixture-identities", {
      body: JSON.stringify({ project, source, profiles, runsCreated: 0, appliedToBatch: false }, null, 2),
      contentType: "application/json",
    });
  });
}
