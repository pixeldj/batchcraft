import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { buildToolNotices, checkBundledModule, installedNotice, runtimePackages } from "./build-notices.ts";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), {
    name: "batchcraft-license",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk") output.moduleIds.forEach(checkBundledModule);
      }
      runtimePackages.forEach((name) => installedNotice(name));
      this.emitFile({
        type: "asset",
        fileName: "LICENSE",
        source: readFileSync(new URL("../LICENSE", import.meta.url)),
      });
      this.emitFile({
        type: "asset",
        fileName: "BUILD-TOOL-NOTICES.json",
        source: JSON.stringify(buildToolNotices(), null, 2),
      });
    },
  }],
  build: {
    license: { fileName: "THIRD-PARTY-NOTICES.json" },
    rolldownOptions: {
      output: {
        postBanner: "/* batchcraft: GPL-3.0-only. See LICENSE, THIRD-PARTY-NOTICES.json and BUILD-TOOL-NOTICES.json. */",
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    watch: { ignored: ["**/test-results/**", "**/playwright-report/**"] },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    restoreMocks: true,
  },
});
