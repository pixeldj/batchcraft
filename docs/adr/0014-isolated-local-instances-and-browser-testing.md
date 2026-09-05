# ADR 0014: Isolated local instances and browser testing

- Status: Accepted
- Date: 2026-09-04

## Decision

Keep an everyday app at a selected committed revision in a separate Git worktree. Give it an explicit
absolute data root and serve the built frontend through the single local FastAPI process. Keep the
development checkout, persistent development data, and temporary browser-test data separate from that
instance. Local launchers bind loopback by default and use fixed, distinct ports and browser origins.

Amendment, 2026-09-04: allow user-requested LAN access as an explicit everyday-app-only exception.
The optional boolean `lan_access` in `app.local.json` defaults to `false`, including for existing
configurations. Setting it to `true` binds all IPv4 interfaces at `0.0.0.0:8000`. Development and test
instances remain loopback-only and reject the LAN option. The installer accepts `--lan-access` and
builds with `VITE_BATCHCRAFT_API_URL='/'` so the everyday frontend uses same-origin API requests,
including with pinned older client code. It does not replace launcher files already present in the
selected revision. No wildcard CORS or authentication is added.

Development and browser tests inject a network-free fake ComfyUI client at the existing application
factory boundary. Real compilation, workflow preparation, scheduling, persistence, and HTTP remain in
use. This is developer tooling outside the installed Python package, not a production execution mode or
a second domain implementation. Live ComfyUI verification remains opt-in and separate.

Use Playwright Test for real-browser smoke coverage and Playwright MCP for interactive agent inspection.
The MCP browser must use an isolated profile, not a user's active browser. Keep generated browser
artifacts and machine-specific configuration out of Git. No automatic data migration between instances,
production update, or reset of persistent data is introduced.

## Consequences

Users can continue using a known-good app while development changes hot-reload independently. Browser
testing no longer depends entirely on mocked frontend APIs, and normal checks do not use a GPU host.
The fake cannot verify ComfyUI protocol or model compatibility. The temporary test root is disposable;
everyday databases and valid Project files retain the existing forward-only persistence policy.

LAN access is for trusted networks only. Anyone who can reach the unauthenticated app can read and
modify its data and start GPU Jobs. Do not port-forward it or expose it to the internet; the host
firewall may need to allow inbound TCP port 8000. Different browser origins and devices retain separate
unsaved working sessions even when they share the everyday backend.

Git worktrees share repository metadata; they are not standalone distributable installations. Updates,
backups, bootstrap handling for older revisions, and process shutdown are explicit operations described
in `docs/LOCAL_INSTANCES.md`. A packaged desktop app and automatic updater remain outside this decision.
