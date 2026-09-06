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
- Permit at most four in-flight admitted bodies, with no capacity waiting queue, and a 120-second
  total receiving/spooling deadline. Direct startup can configure `BATCHCRAFT_MAX_INFLIGHT_REQUEST_BODIES`
  and `BATCHCRAFT_REQUEST_BODY_TIMEOUT`. Keep leases through handler consumption and joined off-thread
  cleanup. Reject saturation with `429 request_capacity_exceeded` and deadline expiry with
  `408 request_body_timeout`. Completed empty bodies bypass admission; HTTP method alone does not.
- Default new-plan materialization to at most 10,000 Jobs. Direct startup can configure
  `BATCHCRAFT_MAX_JOBS`. Enforce the final Random count before expansion. Saved Batch writes bound
  parameter combinations while preserving incomplete drafts; Preview checks every dimension.
- Default new resolved prompts to 1 MiB each and aggregate resolved text to 32 MiB per final plan.
  Pass all three plan limits into request preflight before Range allocation, then enforce them in the
  service compiler. Raw UTF-8 accounting includes each Job's prompt, used variable values once per name,
  and string parameters including linked cells. `BATCH_COMPILER.md` defines exclusions; this is not a
  serialized-size or process-memory limit. `API.md` lists the direct-start configuration knobs.
- Bound newly received ComfyUI JSON/error bodies to 8 MiB, successful artifact bodies to 256 MiB, and
  WebSocket messages to 4 MiB by default. Require identity HTTP content encoding and check raw received
  bytes before over-cap buffering. Preserve definite 4xx rejection versus ambiguous submission outcomes
  and advisory WebSocket failure; never retry a submission merely because its response exceeds a cap.
- Preserve readability of valid historical Runs and Saved Batches independent of the new-plan budget.
  Do not rewrite migrations, historical files, or stored intent to impose this runtime policy.
  Validate historical Jobs against intent without building another full Job plan or full resolved prompt
  strings; Saved Batch validation uses counts rather than Job construction.
- Use nonblocking, no-follow regular-file descriptors for Result/Asset serving and Result integrity
  scans. Canonicalize only trusted configured storage anchors at Settings construction, including
  macOS `/var` aliases; reject symlinks within the store rather than resolving artifact paths.
  Hash integrity-only Result reads in chunks. Verify downloads into owned disk snapshots before HTTP
  success and stream those same snapshots with bounded buffers. Preview runs in a worker thread.
- Limit bulk historical/Asset/Result reads to four active requests per process, including download
  streaming and cleanup, with at most eight FIFO waiters. Execution-detail polling has two separate
  active slots and at most four FIFO waiters. Both queues have a five-second acquisition deadline and
  allocate no read workers or snapshots while waiting. Reject queue overflow immediately and expired
  waiters at their deadline with `503 read_capacity_exceeded` and `Retry-After: 1`. This bounded waiting
  deliberately replaces fail-fast slot admission so ordinary six-image browser bursts can complete.
  Remove cancelled/timed-out waiters and return cancelled grants without leaking slots. Offload reads and
  serialization without consuming the shared AnyIO pool. Trivial dependencies and task-registry reads
  remain on the event loop; health, discovery, and control bypass these read limits. Join file workers
  before releasing capacity or closing request-owned tempfiles, including during shutdown cancellation.
- Offload Run creation, Project Asset import, and cancellation filesystem validation through joined
  workers. Keep multipart files open until import workers finish, including on request cancellation.
  This is scoped filesystem offloading, not a claim that every mutation or compiler step is nonblocking.
- Limit Project History Result-list fan-out to two Runs. Retry only structured read-capacity GET failures
  at most twice with abortable 1-5 second delays. Do not retry mutations or other errors; do not turn
  image failures into an unbounded retry loop.
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

Request admission does not bound connection count, transport buffering, or handler time. Separate
ComfyUI body/message and logical resolved-text caps do not bound headers, decoded object overhead,
historical metadata, serialization, or process memory. ComfyUI HTTP timeouts govern inactivity/transport
phases, not absolute whole-response duration; a progressing transfer can outlast the timeout.
An OS file operation cannot be forcibly interrupted; timeout/cancellation waits for it before cleanup
and can exceed the nominal
admission deadline. Persisted reads still parse and validate complete metadata.
Verified download snapshots finish verification before responding; there is no historical size cap.
At most four download snapshots occupy bulk read slots, but their combined disk size is unbounded.
Slow streams retain disk and capacity until completion/cleanup. Read concurrency limits do not bound
metadata size or active read/stream duration, guarantee control latency under unrelated load, or make
all mutation paths nonblocking. The five-second deadline applies only to waiting for read capacity.
Disk quotas, active-stream duration, and whole-process resource bounds remain BC-025 follow-ups rather
than completed security guarantees. Public diagnostic summarization does not redact on-disk evidence,
access logs, startup/lifespan errors, or independent dependency logs.

Verification uses isolated fake-backed tests for hostile Hosts/Origins, admission without side effects,
chunked and multipart limits, HTML/SVG downloads without execution, PNG decoding, FIFO rejection,
oversized-plan rejection before publication, and persisted readability after lowering the budget.
Resource tests also cover shutdown cancellation while file workers run, real macOS temporary aliases,
bounded upload and read saturation, six-image bursts, independent polling, and no mutation retries.
No everyday data or live ComfyUI execution is needed for these checks.
