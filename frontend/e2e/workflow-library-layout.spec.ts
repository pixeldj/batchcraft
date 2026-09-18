import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import type { GlobalCopyResponse, GlobalWorkflowVersion, GlobalProfileVersion, ProjectResponse, ProjectCopyResponse } from "../src/api/types";
import { appearanceStorageKey, paletteStorageKey } from "../src/features/settings/appearance";

// BC-026 layout regression and AFTER evidence. Never point output at the BEFORE directory.
const apiUrl = "http://127.0.0.1:8002";
const baseWorkflowName = "Alpine editorial portrait and reference-guided cinematic landscape exploration";
const profileName = "Reference-guided portrait with reproducible sampling and carefully controlled lighting";
const workflow = {
  "1": { class_type: "CLIPTextEncode", inputs: { text: "Alpine landscape" } },
  "2": { class_type: "KSampler", inputs: { seed: 1, steps: 20, cfg: 7.5 } },
  "3": { class_type: "SaveImage", inputs: { filename_prefix: "synthetic-layout" } },
  "4": { class_type: "LoadImage", inputs: { image: "synthetic-reference.png" } },
  "5": { class_type: "LayoutFixture", inputs: { enabled: true, style: "cinematic" } },
};
const mappings = {
  prompt: { node_id: "1", input_name: "text", value_type: "string" },
  seed: { node_id: "2", input_name: "seed", value_type: "integer" },
  output_prefix: { node_id: "3", input_name: "filename_prefix", value_type: "string" },
};

// Narrow real-API seed pattern copied from newglobal-workflows.spec.ts; no shared file edits.
async function post<T>(request: APIRequestContext, path: string, data: object): Promise<T> {
  const response = await request.post(`${apiUrl}${path}`, { data: { request_id: randomUUID(), ...data } });
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as T;
}

async function capture(page: Page, testInfo: TestInfo, state: string) {
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(async () => {
      await document.fonts.ready;
      document.querySelectorAll(".global-library-workflow-list, .global-library-profile-list").forEach((element) => element.scrollTo(0, 0));
      window.scrollTo(0, 0);
    });
    const dialogs = page.getByRole("dialog");
    if (await dialogs.count()) {
      await dialogs.evaluateAll((elements) => elements.forEach((element) => element.scrollTo(0, 0)));
      const dialogGeometry = await dialogs.evaluateAll((elements) => elements.map((element) => ({
        bounds: element.getBoundingClientRect().toJSON(), width: element.clientWidth, scrollWidth: element.scrollWidth,
      })));
      for (const { bounds, width: clientWidth, scrollWidth } of dialogGeometry) {
        expect.soft(bounds.x).toBeGreaterThanOrEqual(0);
        expect.soft(bounds.right).toBeLessThanOrEqual(width);
        expect.soft(bounds.y).toBeGreaterThanOrEqual(0);
        expect.soft(bounds.bottom).toBeLessThanOrEqual(900);
        expect.soft(scrollWidth).toBeLessThanOrEqual(clientWidth);
      }
      await page.screenshot({ path: testInfo.outputPath(`${state}-${width}-viewport.png`), scale: "css" });
    }
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute("data-palette", "synthwave");
    await page.screenshot({ path: testInfo.outputPath(`${state}-${width}.png`), fullPage: true, scale: "css" });
    const appearance = await page.evaluate(() => ({
        theme: document.documentElement.dataset.theme,
        palette: document.documentElement.dataset.palette,
        font: getComputedStyle(document.body).fontFamily,
        viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
        foreground: getComputedStyle(document.documentElement).color,
        tokens: Object.fromEntries(["--canvas", "--paper", "--ink", "--line", "--line-strong", "--accent", "--accent-bright"].map((key) => [key, getComputedStyle(document.documentElement).getPropertyValue(key).trim()])),
      }));
    await writeFile(testInfo.outputPath(`${state}-${width}-appearance.json`), JSON.stringify(appearance, null, 2));
    // These values come from the unchanged Synthwave palette, not test-injected CSS.
    expect.soft(appearance.foreground).toBe("rgb(224, 220, 244)");
    expect.soft(appearance.tokens).toMatchObject({ "--paper": "#1a1b26", "--ink": "#e0dcf4", "--accent": "#ff7edb", "--accent-bright": "#7dcfff" });
    expect.soft(appearance.documentWidth, `${state}/${width}: no page overflow`).toBeLessThanOrEqual(width);
    const geometry = await page.locator(".global-library").evaluate((element) => {
      const sidebar = element.querySelector(".global-library-sidebar")!;
      const heading = element.querySelector("h2")!.getBoundingClientRect();
      const actions = element.querySelector(".global-library-header > .global-library-actions")!.getBoundingClientRect();
      const checkbox = element.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      const label = checkbox.parentElement!;
      const range = document.createRange(); range.selectNodeContents(label); range.setStartAfter(checkbox);
      const footer = element.querySelector(".global-library-copy-footer");
      const detailHeader = element.querySelector("header.global-library-detail-header");
      const lists = [...element.querySelectorAll(".global-library-workflow-list, .global-library-profile-list")].map((list) => {
        const pager = list.parentElement!.querySelector(":scope > .global-library-pager")!;
        const search = list.parentElement!.querySelector(":scope > .global-library-search")!;
        const pagerBefore = pager.getBoundingClientRect();
        list.scrollTop = list.scrollHeight;
        const scrolled = list.scrollTop;
        const pagerAfter = pager.getBoundingClientRect();
        list.scrollTop = 0;
        return {
          name: list.getAttribute("aria-label"), role: list.getAttribute("role"),
          count: list.children.length, height: list.clientHeight, scrollHeight: list.scrollHeight,
          overflowY: getComputedStyle(list).overflowY, scrolled,
          bounds: list.getBoundingClientRect().toJSON(), pager: pagerBefore.toJSON(), search: search.getBoundingClientRect().toJSON(),
          pagerMovement: pagerAfter.top - pagerBefore.top,
          controlsInside: list.querySelectorAll("input, .global-library-pager").length,
        };
      });
      return {
        lists, rootFontSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
        footer: footer?.getBoundingClientRect().toJSON(),
        footerGap: footer ? footer.getBoundingClientRect().top - footer.previousElementSibling!.getBoundingClientRect().bottom : null,
        detailHeaderActions: detailHeader ? [...detailHeader.querySelector(".global-library-actions")!.children].map((child) => child.getBoundingClientRect().toJSON()) : [],
        sidebarWidth: sidebar.getBoundingClientRect().width,
        divider: getComputedStyle(sidebar).borderRightWidth,
        heading: heading.toJSON(), actions: actions.toJSON(),
        checkboxWidth: checkbox.getBoundingClientRect().width,
        checkboxGap: range.getBoundingClientRect().left - checkbox.getBoundingClientRect().right,
        rows: [...element.querySelectorAll(".global-profile-row > .global-library-actions")].map((row) => [...row.children].map((child) => child.getBoundingClientRect().toJSON())),
      };
    });
    await writeFile(testInfo.outputPath(`${state}-${width}-geometry.json`), JSON.stringify(geometry, null, 2));
    if (width >= 1024) {
      expect.soft(geometry.sidebarWidth).toBeGreaterThanOrEqual(260);
      expect.soft(geometry.sidebarWidth).toBeLessThanOrEqual(300);
      expect.soft(parseFloat(geometry.divider)).toBeGreaterThan(0);
      expect.soft(geometry.heading.right).toBeLessThan(geometry.actions.left);
      expect.soft(Math.abs(geometry.heading.top - geometry.actions.top)).toBeLessThan(10);
    }
    expect.soft(geometry.checkboxWidth).toBeLessThan(24);
    expect.soft(geometry.checkboxGap).toBeGreaterThanOrEqual(0);
    expect.soft(geometry.checkboxGap).toBeLessThanOrEqual(12);
    for (const list of geometry.lists) {
      const workflowList = list.name === "Workflow entries";
      const limit = Math.min(900 * (workflowList && width > 640 ? .55 : .4), geometry.rootFontSize * (workflowList ? 32 : 24));
      expect.soft(list.role).toBe("group");
      expect.soft(list.height, `${state}/${width}: ${list.name} height cap`).toBeLessThanOrEqual(limit + 1);
      expect.soft(list.overflowY).toBe("auto");
      expect.soft(list.controlsInside).toBe(0);
      expect.soft(list.search.bottom).toBeLessThanOrEqual(list.bounds.top);
      expect.soft(list.pager.top).toBeGreaterThanOrEqual(list.bounds.bottom);
      expect.soft(list.pager.top - list.bounds.bottom).toBeLessThanOrEqual(48);
      expect.soft(list.pagerMovement).toBe(0);
      if (list.count >= 20) {
        expect.soft(list.scrollHeight, `${state}/${width}: ${list.name} scrolls internally`).toBeGreaterThan(list.height);
        expect.soft(list.scrolled).toBeGreaterThan(0);
      }
    }
    if (geometry.footerGap !== null) {
      expect.soft(geometry.footerGap, `${state}/${width}: no sidebar-driven blank space before copy footer`).toBeGreaterThanOrEqual(0);
      expect.soft(geometry.footerGap).toBeLessThanOrEqual(16);
    }
    if (state === "04-many-needs-review" && width >= 1024) {
      expect.soft(geometry.footer!.bottom, `${width}: many-Workflow footer stays near the first viewport`).toBeLessThanOrEqual(1100);
    }
    if (geometry.detailHeaderActions.length) {
      const [edit, menu] = geometry.detailHeaderActions;
      expect.soft(Math.abs(edit.top - menu.top), `${state}/${width}: Workflow header actions do not wrap`).toBeLessThan(5);
      expect.soft(menu.left - edit.right).toBeGreaterThanOrEqual(4);
    }
    for (const [edit, menu] of geometry.rows) {
      expect.soft(Math.abs(edit.top - menu.top), `${state}/${width}: row actions stay horizontal`).toBeLessThan(5);
      expect.soft(menu.left - edit.right).toBeGreaterThanOrEqual(4);
    }
  }
}

test("BC-026 Workflow Library layout, exact selections and copy review", async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(({ appearanceStorageKey, paletteStorageKey }) => {
    localStorage.setItem(appearanceStorageKey, "dark");
    localStorage.setItem(paletteStorageKey, "synthwave");
  }, { appearanceStorageKey, paletteStorageKey });
  const initial = await request.get(`${apiUrl}/api/library/workflows`);
  expect(initial.ok()).toBe(true);
  // Full suites share a server. Scope only when earlier tests already populated it.
  const scope = (await initial.json()).items.length ? `layout-${randomUUID().slice(0, 8)}` : "";
  const workflowName = `${baseWorkflowName}${scope ? ` ${scope}` : ""}`;
  await page.goto("/?view=workflows");
  const library = page.getByRole("region", { name: "Global Workflow Library" });
  if (scope) {
    await library.getByLabel("Search Workflow Library").fill(scope);
    await library.getByLabel("Search Workflow Library").press("Enter");
  }
  await expect(library.getByText("No Workflows found. Create a Workflow or import a Project setup.")).toBeVisible();
  await capture(page, testInfo, "01-empty");

  const source = await post<GlobalCopyResponse["workflow"]>(request, "/api/library/workflows", { name: workflowName, workflow });
  await library.getByRole("button", { name: "Reload library", exact: true }).click();
  await library.getByRole("button", { name: workflowName, exact: true }).click();
  await expect(library.getByText("No Profiles found.", { exact: true })).toBeVisible();
  await expect(library.getByRole("button", { name: "Add to Project", exact: true })).toBeDisabled();
  await capture(page, testInfo, "01b-no-profiles");
  const primary = await post<GlobalCopyResponse["profiles"][number]>(request, `/api/library/workflows/${source.workflow.id}/profiles`, {
    name: profileName, workflow_version_id: source.version.id, mappings,
    image_inputs: [{ key: "reference", label: "Portrait reference image", node_id: "4", input_name: "image" }],
    parameters: [
      { key: "steps", label: "Sampling steps", node_id: "2", input_name: "steps", value_type: "integer" },
      { key: "cfg", label: "Guidance strength", node_id: "2", input_name: "cfg", value_type: "float" },
    ],
  });
  await library.getByRole("button", { name: "Reload library", exact: true }).click();
  await library.getByRole("button", { name: workflowName, exact: true }).click();
  await expect(library.getByRole("button", { name: profileName, exact: true })).toBeVisible();
  await expect(library.getByRole("button", { name: profileName, exact: true })).toContainText("1 named inputs / 2 parameters");
  await capture(page, testInfo, "02-one-workflow");
  const detailRead = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/library/workflow-profile-versions/${primary.version.id}`);
  await library.getByRole("button", { name: profileName, exact: true }).click();
  expect((await detailRead).ok()).toBe(true);
  await expect(library.getByRole("region", { name: "Selected Profile" })).toBeVisible();
  const selected = library.getByRole("region", { name: "Selected Profile" });
  await expect(selected.locator("dt")).toHaveText(["Prompt", "Seed", "Output Prefix"]);
  await expect(selected.locator("dd")).toHaveText(["CLIPTextEncode", "KSampler", "SaveImage"]);
  await expect(selected).toContainText("Portrait reference image");
  await expect(selected).toContainText("Sampling steps integer");
  await expect(selected).toContainText("Guidance strength float");
  await expect(selected.locator("input, select, textarea")).toHaveCount(0);
  await expect(library.getByRole("button", { name: profileName, exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(library.getByRole("button", { name: workflowName, exact: true })).toHaveAttribute("aria-pressed", "true");
  await capture(page, testInfo, "03-profile-selected");

  const alternate = await post<GlobalCopyResponse["profiles"][number]>(request, `/api/library/workflows/${source.workflow.id}/profiles`, {
    name: "Boolean and string controls", workflow_version_id: source.version.id, mappings, image_inputs: [],
    parameters: [
      { key: "enabled", label: "Enable styling", node_id: "5", input_name: "enabled", value_type: "boolean" },
      { key: "style", label: "Style text", node_id: "5", input_name: "style", value_type: "string" },
    ],
  });
  const latest = await post<GlobalWorkflowVersion>(request, `/api/library/workflows/${source.workflow.id}/versions`, {
    workflow: { ...workflow, "2": { ...workflow["2"], inputs: { seed: 1, iterations: 30, cfg: 7.5 } } },
    note: "Synthetic revision: sampling steps renamed; old Profiles stay bound to revision 1.",
  });
  for (let index = 1; index <= 21; index++) {
    await post(request, "/api/library/workflows", { name: `Study ${String(index).padStart(2, "0")} - ${index % 2 ? "Reference lighting exploration" : "Landscape composition study"}${scope ? ` ${scope}` : ""}`, workflow });
  }
  await library.getByRole("button", { name: "Reload library", exact: true }).click();
  // Refresh must NOT jump from the selected revision 1 to the newly appended revision 2.
  await expect(library.locator(".global-library-detail-header").first()).toContainText("Revision 1");
  await expect(selected).toContainText("Selected revision 1");
  await library.getByRole("button", { name: `Actions for Workflow ${workflowName}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Workflow History", exact: true }).click();
  const history = library.getByRole("region", { name: "Workflow History", exact: true });
  await history.getByRole("button", { name: /^Revision 2 \// }).click();
  await expect(library.getByRole("button", { name: `Review mappings for ${profileName}`, exact: true })).toBeVisible();
  await library.getByRole("button", { name: `Actions for Workflow ${workflowName}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Workflow History", exact: true }).click();
  await expect(library.getByRole("button", { name: "Next Workflows", exact: true })).toBeEnabled();
  await capture(page, testInfo, "04-many-needs-review");
  await library.getByRole("button", { name: "Next Workflows", exact: true }).click();
  await expect(library.getByRole("button", { name: "Next Workflows", exact: true })).toBeDisabled();
  await expect(library.getByRole("button", { name: "Previous Workflows", exact: true })).toBeEnabled();
  await capture(page, testInfo, "05-second-page");
  await library.getByRole("button", { name: "Previous Workflows", exact: true }).click();
  await expect(library.getByRole("button", { name: workflowName, exact: true })).toBeVisible();
  await expect(library.getByRole("button", { name: "Previous Workflows", exact: true })).toBeDisabled();

  // A real v1 Profile remains incompatible with the selected v2 Workflow.
  await library.getByRole("button", { name: profileName, exact: true }).click();
  await expect(selected).toContainText("This Profile targets a different Workflow revision");
  await expect(selected.locator("dd")).toHaveText(["Unavailable node", "Unavailable node", "Unavailable node"]);
  await capture(page, testInfo, "05b-no-compatible-profile");

  const trigger = library.getByRole("button", { name: `Actions for Profile ${profileName}`, exact: true });
  const menu = page.getByRole("menu", { name: `Actions for Profile ${profileName}`, exact: true });
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.evaluate((element) => window.scrollBy(0, element.getBoundingClientRect().bottom - (innerHeight - 12)));
    await trigger.focus();
    await trigger.press("ArrowDown");
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: `History for ${profileName}`, exact: true })).toBeFocused();
    const bounds = await menu.boundingBox();
    expect.soft(bounds!.x).toBeGreaterThanOrEqual(0);
    expect.soft(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect.soft(bounds!.y).toBeGreaterThanOrEqual(0);
    expect.soft(bounds!.y + bounds!.height).toBeLessThanOrEqual(900);
    await page.screenshot({ path: testInfo.outputPath(`menu-edge-${width}.png`), scale: "css" });
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await library.getByLabel("Search Workflow Library").click();
    await expect(menu).toHaveCount(0);
    await expect(library.getByLabel("Search Workflow Library")).toBeFocused();
    await trigger.click();
    await menu.getByRole("menuitem", { name: `Metadata for ${profileName}`, exact: true }).click();
    await expect(menu).toHaveCount(0);
    const metadata = page.getByRole("dialog", { name: `Edit metadata: ${profileName}`, exact: true });
    await expect(metadata.getByLabel("Name", { exact: true })).toBeFocused();
    await metadata.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(trigger).toBeFocused();
  }

  // Create recovery through the application, not a hand-authored recovery JSON envelope.
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Batch", exact: true }).click();
  await page.getByRole("textbox", { name: "Batch name", exact: true }).fill("Synthetic unsaved layout draft");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Batch name", exact: true })).toHaveValue("Synthetic unsaved layout draft");
  const notice = page.getByText("Draft restored from this browser. Preview to verify the Job plan.", { exact: true });
  await expect(notice).toBeVisible();
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Workflow Library", exact: true }).click();
  await library.getByRole("button", { name: workflowName, exact: true }).click();
  await expect(library.getByRole("button", { name: `Review mappings for ${profileName}`, exact: true })).toBeVisible();
  await expect(notice).not.toBeVisible();
  await capture(page, testInfo, "06-recovered-draft");

  await library.getByRole("button", { name: "Choose Project", exact: true }).click();
  await expect(page.getByLabel("Active Project")).toHaveValue("");
  await expect(notice).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Batch name", exact: true })).toHaveValue("Synthetic unsaved layout draft");
  const projectResponse = await request.post(`${apiUrl}/api/projects`, { data: { name: `Layout destination ${randomUUID().slice(0, 8)}`, filesystem_key: `layout_${randomUUID().slice(0, 8)}` } });
  expect(projectResponse.ok(), await projectResponse.text()).toBe(true);
  const project = await projectResponse.json() as ProjectResponse;
  await page.reload();
  await page.getByLabel("Active Project").selectOption(project.id);
  await page.getByRole("dialog", { name: "Change Project?", exact: true }).getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel("Active Project")).toHaveValue(project.id);
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Workflow Library", exact: true }).click();
  await library.getByRole("button", { name: workflowName, exact: true }).click();
  await library.getByRole("button", { name: `Actions for Workflow ${workflowName}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Workflow History", exact: true }).click();
  await history.getByRole("button", { name: /^Revision 1 \// }).click();
  const appended = await post<GlobalProfileVersion>(request, `/api/library/workflow-profiles/${primary.workflow_profile.id}/versions`, {
    workflow_version_id: source.version.id, mappings, image_inputs: [], parameters: [],
  });
  await library.getByRole("button", { name: `Actions for Profile ${profileName}`, exact: true }).click();
  await page.getByRole("menuitem", { name: `History for ${profileName}`, exact: true }).click();
  await library.getByRole("region", { name: "Profile History", exact: true }).getByRole("button", { name: /^Revision 1 \// }).click();
  await expect(selected).toContainText("Selected revision 1");
  await library.getByRole("button", { name: "Reload library", exact: true }).click();
  await expect(selected).toContainText("Selected revision 1");
  await expect(history).toContainText("Viewing revision 1.");
  await library.getByRole("button", { name: "Add to Project", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Add workflow to Project" });
  await expect(review.getByRole("checkbox", { name: profileName, exact: true })).toBeChecked();
  await expect(review.getByText("1 selected", { exact: true })).toBeVisible();
  await capture(page, testInfo, "07-copy-one-historical");
  await review.getByRole("checkbox", { name: profileName, exact: true }).uncheck();
  await expect(review.getByText("0 selected", { exact: true })).toBeVisible();
  await expect(review.getByText("Only the Workflow will be added", { exact: true })).toBeVisible();
  await expect(review.getByRole("button", { name: "Add to Project", exact: true })).toBeEnabled();
  await capture(page, testInfo, "08-copy-workflow-only");
  await review.getByRole("checkbox", { name: profileName, exact: true }).check();
  await review.getByRole("checkbox", { name: "Boolean and string controls", exact: true }).check();
  await expect(review.getByText("2 selected", { exact: true })).toBeVisible();
  await capture(page, testInfo, "09-copy-multiple");
  const copiedResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/library/workflows/use-in-project");
  await review.getByRole("button", { name: "Add to Project", exact: true }).click();
  const received = await copiedResponse;
  expect(received.ok()).toBe(true);
  expect(received.request().postDataJSON()).toMatchObject({ workflow_version_id: source.version.id, profiles: expect.arrayContaining([{ version_id: primary.version.id, name: profileName }]) });
  const copy = await received.json() as ProjectCopyResponse;
  expect(copy.profiles).toHaveLength(2);
  const confirmation = library.getByRole("region", { name: "Added to Project", exact: true });
  await expect(review).not.toBeVisible();
  await expect(confirmation).toContainText("Your Batch has not changed");
  await expect(confirmation.getByRole("button", { name: "Apply to Batch", exact: true })).toBeDisabled();
  await confirmation.getByRole("combobox", { name: "Copied Profile to apply" }).selectOption(copy.profiles[0].version.id);
  await expect(confirmation.getByRole("button", { name: "Apply to Batch", exact: true })).toBeEnabled();

  await post(request, `/api/library/workflow-profiles/${alternate.workflow_profile.id}/archive`, { archived: true });
  await library.getByRole("checkbox", { name: "Show archived entries", exact: true }).check();
  await expect(library.getByText("Archived Profile", { exact: true })).toBeVisible();
  await capture(page, testInfo, "10-archived-profile");
  await writeFile(testInfo.outputPath("fixture-identities.json"), JSON.stringify({
    workflowCount: 22, profileCount: 2, source, primary, alternate, latest,
    appended, project, copy, runsCreated: 0,
  }, null, 2));
  expect(errors).toEqual([]);
});

test("BC-026 bounded summary loading, errors, search and 50-Profile copy cap", async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(10_000);
  await page.addInitScript(({ appearanceStorageKey, paletteStorageKey }) => {
    localStorage.setItem(appearanceStorageKey, "dark");
    localStorage.setItem(paletteStorageKey, "synthwave");
  }, { appearanceStorageKey, paletteStorageKey });
  const name = `Summary stress ${randomUUID().slice(0, 8)}`;
  const longLabel = "Portrait reference image with deliberately long descriptive mapping labels for narrow viewport inspection";
  const zeroWorkflow = { ...workflow, "1": { ...workflow["1"], inputs: { text: "" } }, "2": { ...workflow["2"], inputs: { seed: 0, steps: 0, cfg: 0 } }, "5": { ...workflow["5"], inputs: { enabled: false, style: "" } } };
  const source = await post<GlobalCopyResponse["workflow"]>(request, "/api/library/workflows", { name, workflow: zeroWorkflow });
  const profiles: GlobalCopyResponse["profiles"] = [];
  for (let index = 1; index <= 51; index++) {
    profiles.push(await post(request, `/api/library/workflows/${source.workflow.id}/profiles`, {
      name: `Profile ${String(index).padStart(2, "0")} - controlled synthetic mapping`,
      workflow_version_id: source.version.id, mappings,
      image_inputs: [{ key: "reference", label: longLabel, node_id: "4", input_name: "image" }],
      parameters: [
        { key: "steps", label: "Sampling steps", node_id: "2", input_name: "steps", value_type: "integer" },
        { key: "cfg", label: "Guidance strength", node_id: "2", input_name: "cfg", value_type: "float" },
        { key: "enabled", label: "Enable styling", node_id: "5", input_name: "enabled", value_type: "boolean" },
        { key: "style", label: "Style text", node_id: "5", input_name: "style", value_type: "string" },
      ],
    }));
  }
  const library = page.getByRole("region", { name: "Global Workflow Library" });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let inflight = 0;
  let maximum = 0;
  let reads = 0;
  let failed = false;
  const readIds: string[] = [];
  const abortedReads: string[] = [];
  page.on("requestfailed", (sent) => {
    if (new URL(sent.url()).pathname.startsWith("/api/library/workflow-profile-versions/")) abortedReads.push(sent.url());
  });
  // Only this phase injects a delayed/failed HTTP response; all records are real API fixtures.
  const summaryPattern = "**/api/library/workflow-profile-versions/*";
  await page.route(summaryPattern, async (route) => {
    inflight++; reads++; maximum = Math.max(maximum, inflight);
    readIds.push(new URL(route.request().url()).pathname);
    await pending;
    try {
      if (!failed) {
        failed = true;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "synthetic_summary_error", message: "Synthetic summary read unavailable" } }) });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 30));
        await route.continue();
      }
    } finally { inflight--; }
  });
  await page.goto("/?view=workflows");
  await library.getByLabel("Search Workflow Library").fill(name);
  await library.getByLabel("Search Workflow Library").press("Enter");
  await library.getByRole("button", { name, exact: true }).click();
  await expect.poll(() => reads).toBe(2);
  await expect(library.getByText("Loading mappings...", { exact: true })).toHaveCount(20);
  await expect(library.getByText("0 named inputs / 0 parameters", { exact: true })).toHaveCount(0);
  await capture(page, testInfo, "11-summary-loading-simulated");
  release();
  await expect(library.getByText("Loading mappings...", { exact: true })).toHaveCount(0);
  await expect(library.getByText("Summary unavailable", { exact: true })).toHaveCount(1);
  await expect(library.getByText("1 named inputs / 4 parameters", { exact: true })).toHaveCount(19);
  expect(reads).toBe(20);
  expect(maximum).toBeLessThanOrEqual(2);
  await capture(page, testInfo, "12-summary-error-simulated");
  // Exercise a portaled menu after normal locator scrolling reaches the last visible-page row.
  const lastTrigger = library.getByRole("button", { name: `Actions for Profile ${profiles[19].workflow_profile.name}`, exact: true });
  const rowMenu = page.getByRole("menu", { name: `Actions for Profile ${profiles[19].workflow_profile.name}`, exact: true });
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await lastTrigger.scrollIntoViewIfNeeded();
    await lastTrigger.press("ArrowDown");
    await expect(rowMenu.getByRole("menuitem").first()).toBeFocused();
    const placement = await rowMenu.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return {
        bounds: box.toJSON(), portaled: element.parentElement === document.body,
        unobscured: element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)),
      };
    });
    expect.soft(placement.portaled).toBe(true);
    expect.soft(placement.unobscured).toBe(true);
    expect.soft(placement.bounds.left).toBeGreaterThanOrEqual(0);
    expect.soft(placement.bounds.right).toBeLessThanOrEqual(width);
    expect.soft(placement.bounds.top).toBeGreaterThanOrEqual(0);
    expect.soft(placement.bounds.bottom).toBeLessThanOrEqual(900);
    await page.screenshot({ path: testInfo.outputPath(`profile-list-menu-${width}.png`), scale: "css" });
    await page.keyboard.press("Escape");
    await expect(rowMenu).toHaveCount(0);
    await expect(lastTrigger).toBeFocused();
  }
  await library.getByRole("button", { name: "Reload library", exact: true }).click();
  await expect(library.getByText("1 named inputs / 4 parameters", { exact: true })).toHaveCount(20);
  expect.soft(reads, "Refresh retries only the failed summary, not 19 cached immutable versions").toBe(21);
  expect.soft(maximum, "Refresh preserves the two-reader concurrency bound").toBeLessThanOrEqual(2);
  await page.unroute(summaryPattern);

  await library.getByRole("button", { name: profiles[0].workflow_profile.name, exact: true }).click();
  const selected = library.getByRole("region", { name: "Selected Profile", exact: true });
  await expect(selected).toContainText(longLabel);
  await expect(selected).toContainText("Enable styling boolean");
  await expect(selected).toContainText("Style text string");
  await selected.getByText("Selected Profile JSON", { exact: true }).click();
  const profileJson = selected.locator("details").last().locator("pre");
  expect(JSON.parse(await profileJson.innerText())).toEqual(profiles[0].version.profile);
  await library.getByText("Workflow JSON", { exact: true }).click();
  expect(JSON.parse(await library.locator(".global-library-technical pre").innerText())).toEqual(zeroWorkflow);
  await capture(page, testInfo, "13-long-mappings-zero-false-empty");

  const catalogPattern = "**/api/library/workflows?*";
  let releaseSearch!: () => void;
  const searchPending = new Promise<void>((resolve) => { releaseSearch = resolve; });
  await page.route(catalogPattern, async (route) => { await searchPending; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "synthetic_search_error", message: "Synthetic catalog search unavailable" } }) }); });
  await library.getByLabel("Search Workflow Library").fill(`${name} missing`);
  await library.getByLabel("Search Workflow Library").press("Enter");
  await expect(library.getByText("Loading library...", { exact: true })).toBeVisible();
  await capture(page, testInfo, "14-search-loading-simulated");
  releaseSearch();
  await expect(library.getByRole("alert")).toContainText("Synthetic catalog search unavailable");
  await capture(page, testInfo, "15-search-error-simulated");
  await page.unroute(catalogPattern);
  await library.getByRole("button", { name: "Reload library", exact: true }).click();
  await expect(library.getByText("No Workflows found. Create a Workflow or import a Project setup.")).toBeVisible();
  await expect(library.getByRole("alert")).toHaveCount(0);
  await capture(page, testInfo, "16-search-no-results");
  await library.getByLabel("Search Workflow Library").fill(name);
  await library.getByLabel("Search Workflow Library").press("Enter");
  await expect(library.getByRole("button", { name, exact: true })).toBeVisible();

  const response = await request.post(`${apiUrl}/api/projects`, { data: { name: `Copy limit destination ${randomUUID().slice(0, 8)}`, filesystem_key: `cap_${randomUUID().slice(0, 8)}` } });
  expect(response.ok(), await response.text()).toBe(true);
  const project = await response.json() as ProjectResponse;
  await page.reload();
  await library.getByRole("button", { name, exact: true }).click();
  await library.getByRole("button", { name: "Choose Project", exact: true }).click();
  await page.getByLabel("Active Project").selectOption(project.id);
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Workflow Library", exact: true }).click();
  await library.getByRole("button", { name: "Add to Project", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Add workflow to Project", exact: true });
  for (let index = 0; index < 50; index++) {
    if (index > 0 && index % 20 === 0) {
      await review.getByRole("button", { name: "Next Profiles", exact: true }).click();
    }
    await review.getByRole("checkbox", { name: profiles[index].workflow_profile.name, exact: true }).check();
    if (index === 43) await expect(review).not.toContainText("/50 selected");
    if (index === 44) await expect(review).toContainText("45/50 selected");
  }
  await expect(review).toContainText("50/50 selected");
  await expect(review.getByRole("checkbox", { name: profiles[50].workflow_profile.name, exact: true })).toBeDisabled();
  await expect(review.getByRole("button", { name: "Add to Project", exact: true })).toBeEnabled();
  await capture(page, testInfo, "17-copy-cap-50");
  await review.getByRole("button", { name: "Previous Profiles", exact: true }).click();
  await expect(review.getByRole("checkbox", { name: profiles[20].workflow_profile.name, exact: true })).toBeChecked();
  await expect(review).toContainText("50/50 selected");
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  await writeFile(testInfo.outputPath("summary-read-accounting.json"), JSON.stringify({ reads, maximum, readIds, abortedReads, profileCount: 51, copiesPerformed: 0, simulation: "Summary reads held, one 503; catalog search held then 503; routes removed afterward." }, null, 2));
});
