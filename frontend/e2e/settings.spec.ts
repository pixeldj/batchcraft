import { expect, test } from "@playwright/test";
import { palettes } from "../src/features/settings/appearance";

test("Appearance settings persist, override OS theme, and behave as a keyboard-accessible modal", async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-theme", "dark");
  const trigger = page.getByRole("button", { name: "Settings", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("button", { name: "Close settings" })).toBeFocused();
  await expect(page.getByRole("radio", { name: "System", exact: true })).toBeChecked();
  await expect(dialog).toHaveCSS("background-color", "rgb(32, 39, 34)");
  await page.screenshot({ path: testInfo.outputPath("settings-dark.png") });

  // Native modal behavior keeps keyboard navigation away from the Batch editor.
  await dialog.getByRole("button", { name: "Done", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Close settings" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Done", exact: true })).toBeFocused();

  await page.getByRole("radio", { name: "Light", exact: true }).check();
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(dialog).toHaveCSS("background-color", "rgb(247, 245, 236)");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(232, 230, 220)");
  await page.screenshot({ path: testInfo.outputPath("settings-light.png") });
  const fits = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
      && element.scrollWidth <= element.clientWidth;
  });
  expect(fits).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "light");
  await trigger.click();
  await expect(page.getByRole("radio", { name: "Light", exact: true })).toBeChecked();
  await page.getByRole("radio", { name: "System", exact: true }).check();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).toHaveAttribute("data-theme", "light");
  await page.getByRole("radio", { name: "Dark", exact: true }).check();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(trigger).toBeFocused();
  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "dark");
});

test("all palettes apply to the workspace and previews in both modes", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const colors = new Set<string>();
  for (const palette of palettes) {
    await page.getByRole("radio", { name: palette.name, exact: true }).check();
    await expect(page.locator("html")).toHaveAttribute("data-palette", palette.id);
    for (const mode of ["Light", "Dark"] as const) {
      await page.getByRole("radio", { name: mode, exact: true }).check();
      const result = await page.evaluate(({ id, mode }) => {
        const root = getComputedStyle(document.documentElement);
        const preview = getComputedStyle(document.querySelector(`.palette-half[data-palette="${id}"][data-theme="${mode}"]`)!);
        const tokens = ["--paper", "--canvas", "--ink", "--muted", "--accent", "--header-bg", "--header-ink", "--on-accent"];
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d", { willReadFrequently: true })!;
        function luminance(token: string) {
          context.fillStyle = root.getPropertyValue(token).trim();
          context.fillRect(0, 0, 1, 1);
          const channels = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3).map((value) => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        }
        const pairs = [
          ["--ink", "--paper"], ["--muted", "--paper"], ["--accent", "--paper"],
          ["--on-accent", "--accent-fill"], ["--header-ink", "--header-bg"],
          ["--danger-text", "--danger-bg"], ["--warning-text", "--warning-bg"],
        ];
        return {
          signature: `${root.getPropertyValue("--canvas")}/${root.getPropertyValue("--accent")}`,
          matches: tokens.every((token) => root.getPropertyValue(token).trim() === preview.getPropertyValue(token).trim()),
          contrast: pairs.map(([foreground, background]) => {
            const a = luminance(foreground);
            const b = luminance(background);
            return { foreground, background, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
          }),
          headerMatches: getComputedStyle(document.querySelector(".app-header")!).backgroundColor
            === getComputedStyle(document.querySelector(`.palette-half[data-palette="${id}"][data-theme="${mode}"] .palette-mini-header`)!).backgroundColor,
        };
      }, { id: palette.id, mode: mode.toLowerCase() });
      expect(result.matches, `${palette.id} ${mode} preview tokens`).toBe(true);
      expect(result.headerMatches, `${palette.id} ${mode} header`).toBe(true);
      colors.add(result.signature);
      for (const pair of result.contrast) {
        expect(pair.ratio, `${palette.id} ${mode} ${pair.foreground} on ${pair.background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
  expect(colors.size).toBe(palettes.length * 2);
  await page.getByRole("radio", { name: "Synthwave", exact: true }).check();
  await page.locator(".palette-fieldset").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("palettes-synthwave.png") });
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.screenshot({ path: testInfo.outputPath("workspace-synthwave.png") });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "synthwave");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Synthwave", exact: true })).toBeChecked();
  // Arrow navigation uses the native radio group and changes only the palette.
  await page.getByRole("radio", { name: "Synthwave", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Solarized", exact: true })).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("radio", { name: "Light", exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "solarized");
  await page.locator(".palette-fieldset").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("palettes-solarized-light.png") });
  await expect(dialog.getByRole("button", { name: "Done", exact: true })).toBeInViewport();
});

test("palette choices fit narrow and intermediate widths without clipping", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const width of [320, 620, 700, 800, 900]) {
    await page.setViewportSize({ width, height: 720 });
    await page.getByRole("radio", { name: "Catppuccin", exact: true }).check();
    const fits = await page.locator(".settings-content").evaluate((content) => {
      const tiles = Array.from(content.querySelectorAll<HTMLElement>(".palette-tile, .theme-option"));
      return content.scrollWidth <= content.clientWidth && tiles.every((tile) => tile.scrollWidth <= tile.clientWidth);
    });
    expect(fits, `settings content at ${width}px`).toBe(true);
    await expect(page.getByRole("button", { name: "Close settings" })).toBeInViewport();
  }
});
