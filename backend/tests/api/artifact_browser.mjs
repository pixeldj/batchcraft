import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(path.resolve("package.json"));
const { chromium, expect } = require("@playwright/test");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ acceptDownloads: true });
  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await page.goto("http://127.0.0.1:8002/");
  await expect(page.locator("#root")).not.toBeEmpty();
  for (const [ordinal, extension] of [[1, "html"], [2, "svg"]]) {
    const url = `/api/runs/run-id/results/1/${ordinal}`;
    const response = await page.request.get(`http://127.0.0.1:8002${url}`);
    assert.equal(response.status(), 200);
    assert.equal(response.headers()["content-type"], "application/octet-stream");
    assert.match(response.headers()["content-disposition"], /^attachment;/);
    assert.equal(response.headers()["x-content-type-options"], "nosniff");
    assert.equal(response.headers()["content-security-policy"], "sandbox; default-src 'none'; frame-ancestors 'none'");

    // A plain navigation link, with no download attribute to manufacture the result.
    await page.evaluate((href) => {
      const link = document.createElement("a");
      link.id = "security-artifact";
      link.href = href;
      link.textContent = "Open artifact";
      document.body.append(link);
    }, url);
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#security-artifact").click();
    const download = await downloadPromise;
    assert.equal(await download.failure(), null);
    assert.equal(download.suggestedFilename(), `000001-0${ordinal}.${extension}`);
    assert.deepEqual(await readFile(await download.path()), await response.body());
    assert.equal(page.url(), "http://127.0.0.1:8002/");
    await page.locator("#security-artifact").evaluate((element) => element.remove());
  }
  await page.evaluate(() => {
    const image = document.createElement("img");
    image.id = "security-png";
    image.src = "/api/runs/run-id/results/1/3";
    document.body.append(image);
  });
  await expect(page.locator("#security-png")).toHaveJSProperty("naturalWidth", 1);
  const burstWidths = await page.evaluate(() => Promise.all(
    Array.from({ length: 6 }, (_, index) => new Promise((resolve, reject) => {
      const image = document.createElement("img");
      image.id = `burst-${index}`;
      image.onload = () => resolve(image.naturalWidth);
      image.onerror = () => reject(new Error(`Image ${index} failed without retry`));
      image.src = `/api/runs/run-id/results/1/${index + 4}`;
      document.body.append(image);
    })),
  ));
  assert.deepEqual(burstWidths, [1, 1, 1, 1, 1, 1]);
  assert.equal(await page.evaluate(() => localStorage.getItem("artifact-executed")), null);
  assert.deepEqual(await (await page.request.get("http://127.0.0.1:8002/api/projects")).json(), { projects: [] });
  assert.deepEqual(dialogs, []);
  console.log("PASS: HTML/SVG download without execution; PNG and six-image queued burst decode without retry in built frontend");
} finally {
  await browser.close();
}
