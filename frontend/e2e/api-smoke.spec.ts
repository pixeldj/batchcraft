import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

import type { ProjectResponse } from "../src/api/types";

test("browser API startup and Project creation use the configured origin", async ({ page, baseURL }) => {
  const browserOrigin = new URL(baseURL!).origin;
  const apiOrigin = process.env.BATCHCRAFT_E2E_BUILT === "1"
    ? browserOrigin
    : "http://127.0.0.1:8002";
  const statusRead = page.waitForResponse(`${apiOrigin}/api/comfyui/status`);
  await page.goto("/");
  expect((await statusRead).ok()).toBe(true);
  await expect(page.getByText("Browser test - simulated ComfyUI", { exact: true })).toBeVisible();
  await expect(page.getByText("ComfyUI Online", { exact: true })).toBeVisible();
  await expect(page.getByText("sandbox (simulated)", { exact: true })).toBeVisible();

  const name = `API smoke ${randomUUID()}`;
  await page.getByRole("button", { name: "New Project", exact: true }).click();
  await page.getByLabel("Project name", { exact: true }).fill(name);
  const created = page.waitForResponse((response) => response.url() === `${apiOrigin}/api/projects`
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Create Project", exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  expect(await response.request().headerValue("origin")).toBe(browserOrigin);
  if (apiOrigin !== browserOrigin) {
    expect(await response.headerValue("access-control-allow-origin")).toBe(browserOrigin);
  }
  const project = await response.json() as ProjectResponse;
  expect(project.name).toBe(name);
  await expect(page.getByLabel("Active Project")).toHaveValue(project.id);
  await expect(page.getByLabel("Active Project").locator("option:checked")).toHaveText(name);
});
