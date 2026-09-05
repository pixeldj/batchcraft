import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { build } from "vite";
import {
  buildToolNotices, checkBundledModule, frontendRoot, installedNotice, runtimePackages,
} from "../build-notices.ts";

const checkout = path.dirname(frontendRoot.replace(/\/$/, ""));
const tracked = new Set(execFileSync("git", ["ls-files", "-z"], { cwd: checkout })
  .toString().split("\0"));
const json = async (file) => JSON.parse(await readFile(file, "utf8"));

function checkNotices(notices) {
  assert.deepEqual(notices, runtimePackages.map((name) => installedNotice(name))
    .sort((a, b) => `${a.name}@${a.version}` < `${b.name}@${b.version}` ? -1 : 1));
}

async function checkDist(directory, sourceMaps) {
  assert.deepEqual(await readFile(path.join(directory, "LICENSE")),
    await readFile(path.join(checkout, "LICENSE")));
  checkNotices(await json(path.join(directory, "THIRD-PARTY-NOTICES.json")));
  assert.deepEqual(await json(path.join(directory, "BUILD-TOOL-NOTICES.json")), buildToolNotices());
  const dependencies = new Set();
  const files = await readdir(directory, { recursive: true, withFileTypes: true });
  let chunks = 0;
  for (const entry of files) {
    assert.ok(!entry.isSymbolicLink(), `Symlink in dist: ${entry.name}`);
    if (entry.isDirectory()) continue;
    const filename = path.join(entry.parentPath, entry.name);
    const relative = path.relative(directory, filename);
    assert.match(relative, /^(index\.html|LICENSE|THIRD-PARTY-NOTICES\.json|BUILD-TOOL-NOTICES\.json|assets\/[^/]+\.(js|css|js\.map))$/,
      `Unreviewed dist artifact: ${relative}`);
    if (!relative.endsWith(".js")) continue;
    chunks++;
    assert.match(await readFile(filename, "utf8"), /GPL-3\.0-only.*THIRD-PARTY-NOTICES\.json.*BUILD-TOOL-NOTICES\.json/);
    if (!sourceMaps) continue;
    const map = await json(`${filename}.map`);
    assert.ok(map.sources.length > 0);
    for (const source of map.sources) {
      checkBundledModule(source);
      if (source.includes("/node_modules/")) {
        dependencies.add(source.split("/node_modules/").at(-1).split("/")[0]);
      } else {
        const relativeSource = path.relative(checkout, path.resolve(path.dirname(filename), source));
        assert.ok(tracked.has(relativeSource) && relativeSource.startsWith("frontend/src/"),
          `Unreviewed source map input: ${source}`);
      }
    }
  }
  assert.ok(chunks > 0, "No JavaScript assets");
  if (sourceMaps) assert.deepEqual([...dependencies].sort(), [...runtimePackages].sort());
}

test("production dist has complete licenses and installed versions", async () => {
  await checkDist(path.join(frontendRoot, "dist"), false);
});

test("isolated source-map build covers bundled packages and only reviewed source inputs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "batchcraft-notices-"));
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("VITE_")));
  try {
    for (const key of Object.keys(saved)) delete process.env[key];
    await build({
      root: frontendRoot,
      configFile: path.join(frontendRoot, "vite.config.ts"),
      envDir: false,
      build: { outDir: directory, sourcemap: true, emptyOutDir: false },
    });
    await checkDist(directory, true);
  } finally {
    Object.assign(process.env, saved);
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown dependencies and incomplete or stale notices fail closed", () => {
  assert.throws(() => checkBundledModule("/checkout/node_modules/unreviewed/index.js"), /newly bundled/);
  assert.throws(() => checkBundledModule("/checkout/node_modules/@scope/unreviewed/index.js"), /newly bundled/);
  const notices = runtimePackages.map((name) => installedNotice(name))
    .sort((a, b) => `${a.name}@${a.version}` < `${b.name}@${b.version}` ? -1 : 1);
  checkNotices(notices);
  assert.throws(() => checkNotices(notices.slice(1)));
  assert.throws(() => checkNotices(notices.map((notice) => ({ ...notice, text: "MIT" }))));
  assert.throws(() => checkNotices(notices.map((notice) => ({ ...notice, version: "0.0.0" }))));
});
