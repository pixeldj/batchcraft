// Exercise the configured stdio MCP server without requiring an OpenCode restart.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { rename } from "node:fs/promises";

const server = spawn("npm", ["run", "--silent", "browser:mcp"], {
  stdio: ["pipe", "pipe", "inherit"],
});
const pending = new Map();
let sequence = 0;
const lines = createInterface({ input: server.stdout });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  const handler = pending.get(message.id);
  if (!handler) return;
  pending.delete(message.id);
  if (message.error) handler.reject(new Error(JSON.stringify(message.error)));
  else handler.resolve(message.result);
});
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}
const timeout = setTimeout(() => {
  server.kill("SIGTERM");
  console.error("Browser MCP smoke check timed out");
  process.exit(1);
}, 60_000);
try {
  await request("initialize", {
    protocolVersion: "2024-11-05", capabilities: {},
    clientInfo: { name: "batchcraft-browser-check", version: "1.0.0" },
  });
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  for (const [name, args] of [
    ["browser_navigate", { url: "http://127.0.0.1:5174" }],
    ["browser_wait_for", { text: "Fake ComfyUI - no GPU or network" }],
    ["browser_take_screenshot", { filename: "mcp-smoke.png", fullPage: true, scale: "css" }],
    ["browser_close", {}],
  ]) {
    const result = await request("tools/call", { name, arguments: args });
    if (result.isError) throw new Error(JSON.stringify(result));
    if (name === "browser_take_screenshot") {
      await rename("mcp-smoke.png", "../.local/browser/mcp-smoke.png");
    }
    console.log(`${name}: passed`);
  }
} finally {
  clearTimeout(timeout);
  server.stdin.end();
  lines.close();
}
