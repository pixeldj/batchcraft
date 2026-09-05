# ADR 0015: Local browser security and materialization budgets

Status: Accepted
Date: 2026-09-05

## Context

BC-025 prepares batchcraft for public source release. A trusted local/LAN deployment still receives
untrusted browser requests and may inspect imported Results or output from ComfyUI custom nodes.
CORS alone does not reject all cross-site mutations. Hash validation establishes artifact identity,
not whether opening that artifact can execute script. Small Cartesian inputs can allocate enormous
plans, and filesystem paths can refer to special files that block before validation.

## Decision

- Keep the existing single-user, unauthenticated deployment. This is not an internet-facing service.
- Validate Host against loopback, an explicit bind host, or the actual socket destination IP for a LAN
  wildcard listener. Do not resolve arbitrary supplied hostnames or trust forwarded Host headers.
- Require browser mutation Origins to match the validated request origin or configured frontend origin.
  Reject malformed, duplicate, and null Origins. No-Origin CLI requests remain supported. Apply CORS
  to admission errors so the configured development frontend can display their structured messages.
- Render Results inline only for PNG, JPEG, GIF, and WebP MIME types with matching signatures. Other
  content downloads as an octet-stream attachment. Send nosniff and sandbox CSP headers. Preserve
  stored MIME, bytes, hashes, and immutable provenance.
- Admit at most 64 MiB of request body by default, including multipart framing and chunked bodies,
  before handlers run. Spool admitted bodies to owned temporary storage rather than retaining them
  entirely in RAM. Direct startup can configure `BATCHCRAFT_MAX_REQUEST_BYTES`.
- Default new-plan materialization to at most 10,000 Jobs. Direct startup can configure
  `BATCHCRAFT_MAX_JOBS`. Enforce the final Random count before expansion. Saved Batch writes bound
  parameter combinations while preserving incomplete drafts; Preview checks every dimension.
- Preserve readability of valid historical Runs and Saved Batches independent of the new-plan budget.
  Do not rewrite migrations, historical files, or stored intent to impose this runtime policy.
- Use nonblocking, no-follow regular-file descriptors for Result/Asset serving and Result integrity
  scans. Hash integrity-only Result reads in chunks. Preview runs in a worker thread.
- Summarize public diagnostics with bounded approved text and safe numeric context. Preserve useful
  Base Image Input/parameter rejection guidance from structured evidence without echoing labels,
  values, or upstream prose. Do not rewrite historical records or redact requested frozen provenance.
- Catch HTTP application failures outside Starlette's rethrow boundary so Uvicorn cannot format raw
  exception chains. Controlled HTTP/task logs retain normalized categories, fixed errno reasons,
  package-relative locations, and hashed Run correlation. Failed streams remain incomplete.

The new-plan budget deliberately supersedes the warning-only recommendation in `BATCH_COMPILER.md`.
The pure compiler retains its optional limit and deterministic semantics. Isolated launchers keep
explicit defaults instead of inheriting environment overrides.

## Consequences and limits

These controls do not authenticate reachable clients, sandbox ComfyUI workflows, scan downloaded files
for malware, or make all application work nonblocking. Arbitrary LAN DNS aliases and reverse proxies
are not supported. A browser may not expose telemetry from a rejected request to an untrusted origin.

Request limits do not bound aggregate concurrent requests, upload time, downloaded ComfyUI artifacts,
historical metadata, or the total bytes in a resolved plan. Persisted reads may still recompile complete
plans, and selected downloads still allocate whole content. Those resource-control tasks remain explicit
BC-025 follow-ups rather than completed security guarantees. Public diagnostic summarization does not
redact on-disk evidence, access logs, startup/lifespan errors, or independent dependency logs.

Verification uses isolated fake-backed tests for hostile Hosts/Origins, admission without side effects,
chunked and multipart limits, HTML/SVG downloads without execution, PNG decoding, FIFO rejection,
oversized-plan rejection before publication, and persisted readability after lowering the budget.
No everyday data or live ComfyUI execution is needed for these checks.
