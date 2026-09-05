import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const frontendRoot = fileURLToPath(new URL("./", import.meta.url));
export const runtimePackages = ["react", "react-dom", "scheduler"];

export function installedNotice(name: string, licenseFile = "LICENSE") {
  const directory = new URL(`./node_modules/${name}/`, import.meta.url);
  const metadata = JSON.parse(readFileSync(new URL("package.json", directory), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("./package-lock.json", import.meta.url), "utf8"));
  const text = readFileSync(new URL(licenseFile, directory), "utf8").trim();
  assert.equal(metadata.name, name);
  assert.equal(metadata.version, lock.packages[`node_modules/${name}`].version);
  assert.equal(metadata.license, "MIT", `Review changed license for ${name}`);
  assert.match(text, /Copyright/);
  assert.match(text, /Permission is hereby granted, free of charge/);
  assert.match(text, /THE SOFTWARE IS PROVIDED "AS IS"/);
  return { name, version: metadata.version as string, identifier: "MIT", text };
}

export function checkBundledModule(id: string) {
  const normalized = id.replaceAll("\\", "/");
  if (!normalized.includes("/node_modules/")) return;
  const dependency = normalized.slice(normalized.lastIndexOf("/node_modules/") + 14);
  const name = dependency.startsWith("@")
    ? dependency.split("/").slice(0, 2).join("/")
    : dependency.split("/")[0];
  assert.ok(runtimePackages.includes(name), `Review newly bundled dependency: ${id}`);
}

export function buildToolNotices() {
  // Native Vite license emission skips virtual modules, including injected build helpers.
  // Retain the tools' complete installed notices, including their bundled-dependency notices.
  return [
    installedNotice("vite", "LICENSE.md"),
    {
      ...installedNotice("rolldown"),
      thirdPartyText: readFileSync(
        new URL("./node_modules/rolldown/THIRD-PARTY-LICENSE", import.meta.url), "utf8",
      ),
    },
  ];
}
