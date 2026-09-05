import { defineConfig, devices } from "@playwright/test";

const builtFrontend = process.env.BATCHCRAFT_E2E_BUILT === "1";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: builtFrontend ? "http://localhost:8002" : "http://127.0.0.1:5175",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    serviceWorkers: "block",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: builtFrontend
        ? "npm run build && uv run --frozen --directory ../backend python -m tools.runtime test --built-frontend"
        : "uv run --frozen --directory ../backend python -m tools.runtime test",
      env: {
        VITE_BATCHCRAFT_API_URL: "/",
        VITE_BATCHCRAFT_INSTANCE: "Browser test - simulated ComfyUI",
      },
      url: "http://127.0.0.1:8002/api/health",
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      timeout: 60_000,
    },
    ...(!builtFrontend ? [{
      command: "npm run dev -- --host 127.0.0.1 --port 5175 --strictPort",
      url: "http://127.0.0.1:5175",
      env: {
        VITE_BATCHCRAFT_API_URL: "http://127.0.0.1:8002",
        VITE_BATCHCRAFT_INSTANCE: "Browser test - simulated ComfyUI",
      },
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM" as const, timeout: 5_000 },
    }] : []),
  ],
});
