# batchcraft v1.2.0

This source-only macOS release adds the global Workflow Library (BC-026) and Workflow prompt
copying plus Prompt editing, notes and guarded deletion (BC-027). ComfyUI remains the workflow editor
and generation engine.

Scope: changes since `v1.1.0` through main commit
`516ed8d1633fdf310c8744de133e74dd6e933fa0` (merged PRs
[#10](https://github.com/pixeldj/batchcraft/pull/10) and
[#11](https://github.com/pixeldj/batchcraft/pull/11)), plus the 1.2.0 metadata and release documentation.
See the [full comparison](https://github.com/pixeldj/batchcraft/compare/v1.1.0...v1.2.0) and
[v1.2.0 Release](https://github.com/pixeldj/batchcraft/releases/tag/v1.2.0).

## Included

### Global Workflow Library

- Browse and search reusable Workflows without selecting a Project. Inspect exact Workflow revisions
  and compatible Profile revisions with paged global lists and History.
- Create a Workflow from pasted ComfyUI API-format JSON or a JSON-object file, then use the shared
  Profile mapper. Cancelling Profile creation retains the saved Workflow. Editor-format conversion
  and a competing node editor are not included.
- Edit content through new immutable revisions, change logical names/descriptions separately, restore
  old content as a new revision, and archive/unarchive families or revisions. Archive retains names;
  it is not hard deletion. Profiles retain exact WorkflowVersion targets and never silently retarget.
- Import exact Project setups into the global library without switching the active Project or Batch.
  **Add to Project** creates independent Project-owned copies with new identities. **Apply to Batch**
  is a separate guarded action with replacement confirmation and normal Preview invalidation.
  Browsing, importing and copying alone preserve the draft and valid Preview. Copies do not follow
  future source edits or merge merely because names/content match.
- Import from current or historical Run Plan and Result Details, including image-viewer Details.
  Historical import creates one global **base Workflow plus exactly one Profile**, not a concrete
  Job's prompt, seed, Image Input or parameter overrides. It creates no intermediate Project copies.
  The independent frozen-setup reader can work when execution/outputs are unavailable, but still
  verifies immutable files, hashes and registered Project ownership.
- Atomic copy and authoring receipts make unchanged retries return the same completed operation;
  conflicting operation-ID reuse is rejected. Historical copy receipts can replay after source loss.
  Closing a pending dialog stops browser waiting, not an already-running server transaction.

Global lists use 20-row pages and 20 sliding Previous bookmarks without limiting forward paging;
Project-source pickers retain their existing unpaginated contracts. These are UI/read bounds, not an
end-to-end performance guarantee. Unsent dialogs and the inline Added result are not durable recovery
state; successfully persisted copies remain available in their library.

### Prompt Management

- Inspect the exact mapped **Workflow prompt** without changing the Workflow or creating a Prompt.
  When no Prompt is selected, **Use this prompt** explicitly copies nonblank literal text into a new
  Project Prompt Template and its first revision, preserving whitespace and placeholders. Review the
  editable name first; defaults are `Workflow prompt`, `Workflow prompt 2`, and so on. Missing,
  connected or non-string inputs are not guessed. Normal Variable Binding validation still applies.
- **Edit Prompt** on a selected row opens that exact revision. Saving changed text creates a new
  revision and replaces only that row, preserving order and Variable Bindings while invalidating
  Preview. Changed Project/Batch/selection guards prevent late application; library edits do not
  automatically replace Batch selections. Unchanged text does not create another revision.
- Mutable **general notes** belong to Prompt metadata, separate from immutable revision notes.
  Name/general-note edits do not create a revision or invalidate Preview.
- **Delete Prompt** permanently deletes a library Prompt and all its revisions after a named warning
  and explicit confirmation. Remove it from the current unsaved Batch first. Any Saved Batch reference,
  including archived Batches and any revision, blocks deletion until explicitly removed and saved.
  No references or Batches are automatically cleared. Frozen Runs/Results remain unchanged; other
  browser recovery snapshots keep unavailable exact text as detached resources.

## Data And Upgrade Safety

Application version **1.2.0** does not change the **v1 historical filesystem formats** or browser
working-session **Recovery v4**. Existing Run bytes and the byte-locked v1 fixture remain unchanged.
BC-026 adds forward SQLite migrations relative to v1.1.0:

- `0005_global_workflow_library.sql`: global catalog and atomic copy receipts.
- `0006_global_workflow_authoring.sql`: authoring receipts and bounded family/History indexes.

All previously applied migration bytes are preserved. Release finalization adds no migration,
dependency upgrade, compiler change or durable schema change. A supported v1.1.0 database advances through 0005/0006 on
normal backend startup; it is never reset. Existing Project records and Saved Batch ownership remain
Project-scoped. Maintenance code/build updates do not themselves apply migrations.

**Back up the entire data root before upgrading.** Finish active Runs and stop
all backends/data users first. Keep SQLite and any `-wal`/`-shm` sidecars together with Projects, Assets
and Run outputs; never delete sidecars manually. Unused global library resources are durable SQLite
application state, not a rebuildable historical index and **not portable in a Project folder**.
Project folders preserve setups captured by Runs, not every unused library item or Saved Batch.
SQLite alone does not preserve historical artifacts.

**Rollback is not a code-only downgrade.** After migration, restore the matching whole-data backup
deliberately, with consistent older code, dependencies, frontend build and installation metadata.
There is no automatic rollback or data restore. Test migration/restore on a separate copy, never the
only copy of user data. See [backup policy](LOCAL_INSTANCES.md#updating-and-backing-up),
[ADR 0012](adr/0012-v1-filesystem-portability-recovery-draft.md) and
[ADR 0016](adr/0016-global-workflow-library-project-copies.md).

Installation remains source-only on macOS, using Git, uv with Python 3.13 or newer, and npm with Node.js
`^22.22.2 || ^24.15.0 || >=26.0.0` (Node 24.15+ in the 24.x line recommended). Retain the source clone
and Git metadata: the installed app is a linked worktree, not a standalone bundle. ComfyUI, models and
custom nodes must be installed separately. For an existing installation, after finishing active Runs
and stopping daily and candidate backends, run from the source checkout:

```bash
uv run --directory backend python -m tools.update_daily --fetch --tag v1.2.0
```

The updater confirms the selected revision, takes a timestamped whole-data backup, preserves configuration,
and installs locked dependencies and the built frontend. It leaves the app stopped. Start its `app.command`
after success; forward migrations run at normal startup. See [maintenance instructions](LOCAL_INSTANCES.md#update-daily-to-a-stable-release).

## Verification

Post-metadata local verification passed on macOS using Python 3.14.7 and Node.js 24.19.0:

- **1,503 backend tests** and **1,023 frontend tests**.
- **56 desktop/mobile Chromium tests in each of Vite and built same-origin modes**, with zero retries
  and fresh temporary fake-backed data.
- Ruff lint/format, mypy, ESLint, TypeScript, production build and frozen lockfile checks.
- 1.2.0 wheel/sdist identity, license and contents checks, plus three frontend distribution checks.
- Artifact-browser security: HTML/SVG download without execution; PNG and six-image queued bursts decode.

The owner explicitly accepted BC-026 and authorized publication and the safe everyday update. BC-027
also retains its recorded owner acceptance and requested default-name follow-up. Publication requires
green hosted checks on the release revision, including checkout/history secret scans; see
[GitHub Actions](https://github.com/pixeldj/batchcraft/actions/workflows/checks.yml) for revision-specific evidence.

Known non-fatal warnings are an upstream Starlette/httpx deprecation and Vite's approximately
577 kB minified chunk warning. No test assertion, retry policy or build threshold was weakened.
No fresh dependency vulnerability audit or new live-ComfyUI, clean-machine, Safari, native-mobile or
Windows-hosted application acceptance is claimed. Fake ComfyUI does not prove model/custom-node
compatibility. The original [v1 portability acceptance](V1_CROSS_INSTANCE_ACCEPTANCE.md) remains
historical evidence, not a newly repeated owner gate.

## Limits

- Single-user local/trusted-LAN operation has no authentication. Do not expose the app to the internet.
- No automatic executor restart recovery, global durable scheduler, Exact Rerun or Recreate Result.
  Load Run as Batch restores editable intent and requires fresh Preview; Random requests fresh seeds.
- Stop-after-current does not interrupt ComfyUI; Stop waiting detaches local observation.
- No automatic synchronization of global and Project copies or export of unused global resources in
  v1 Project folders. `/object_info`, LoRA discovery and workflow images remain outside this scope.
- Historical CSV remains raw data; import spreadsheet columns as text with formula evaluation disabled.

## License And Security

batchcraft remains **GPL-3.0-only**; dependencies retain their own licenses. This release bundles no
dependency environment, browser, models or custom nodes. Distribution checks verify artifact identity,
license bytes and reviewed contents, not complete downstream distribution compliance. Report security
issues privately through [security advisories](https://github.com/pixeldj/batchcraft/security/advisories);
see [SECURITY.md](../SECURITY.md).
