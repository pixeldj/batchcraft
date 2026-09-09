# batchcraft v1.1.0

This source-only macOS release adds appearance settings,
Project-wide historical browsing, safe installation maintenance, and Explicit seed range shorthand.
ComfyUI remains the workflow editor and generation engine.

Scope: changes from `v1.0.0` through main commit `f6e9f74261f6ef5633cfbdcc6e606115dc0e7009`,
plus the 1.1.0 application metadata and release documentation. See the
[full comparison](https://github.com/pixeldj/batchcraft/compare/v1.0.0...v1.1.0) and
[v1.1.0 Release](https://github.com/pixeldj/batchcraft/releases/tag/v1.1.0).

## Included

### Appearance

[PR #6](https://github.com/pixeldj/batchcraft/pull/6) adds Settings with System, Light, and Dark modes
and nine palettes: **Jipiti**, **GitHub**, **Synthwave**, **Solarized**, **Dracula**, **Nord**,
**Monokai**, **Gruvbox**, and **Catppuccin**. Jipiti preserves the original look. These are curated
light/dark adaptations, not exact upstream theme implementations. Mode and palette apply immediately
and persist independently per browser origin; they do not change Batch intent, Preview, or Run state.
Narrow layouts also account for non-overlay scrollbars.

### Project Gallery And Runs

[PR #7](https://github.com/pixeldj/batchcraft/pull/7) completes the accepted scope of
[BC-007](https://github.com/pixeldj/batchcraft/blob/v1.1.0/docs/BACKLOG.md#bc-007-project-wide-run-and-result-browser):

- Batch, Gallery, and Runs navigation preserves the editable draft, valid in-memory Preview, and
  current-Run monitoring. A compact monitor identifies the frozen Run's actual Project and Batch.
  Cold loads still require a fresh Preview; review URLs never silently switch Project.
- Gallery holds one page of up to **48 Results** and Runs one page of up to **25 Runs**, with
  Previous/Next navigation, bounded cursor bookmarks, and a bounded frozen-Run cache. Browsing no longer
  loads every Run's Results; detailed provenance is fetched only for the selected owning Run.
- Search Run names/notes, sort newest/oldest deterministically, and filter by Run, historical Batch,
  status, execution availability, dates, source Saved Batch, Prompt identity/revision, exact frozen
  Workflow/Profile revisions, seed, typed parameter equality/Base/override, Image Input slot Asset/Base,
  or Asset use in any slot. Job-level predicates combine with **same-Job AND**; Result filters match
  that Result's producing Job. Base, `false`, zero, and empty strings remain distinct.
- Historical choice search and editable filter chips use frozen indexed provenance, not current
  mutable libraries. Invalid URL filter intent is rejected rather than silently altered.
- Bounded Diagnostics is available independently of Gallery filter matches, with safe messages and
  25-row pages. Its Refresh reads the index; Reindex Project is the explicit storage-repair action.
- **Filter Gallery** is available from both historical and current-Run Result Details, including
  Details opened inside image inspection. It retains unrelated filters, rejects cap violations without
  truncation, and requires a matching verified Project instead of replacing the draft or switching it.
- The Project Gallery image viewer uses a compact navigation/Details/Close toolbar without a visible
  title. The uncropped image links to its original in a new tab. Narrow and short viewport layouts,
  nested dialogs, keyboard navigation, and focus restoration have regression coverage.
- History reads the last index immediately and reconciles on review activation and local Run
  publication/completion. Identical pages remain stable; changed nonempty pages show **History updated**
  pending Refresh. Failed scans retain known metadata with warnings. Stale images/original links are
  disabled until validated, and missing browsing APIs explain when the backend needs restarting.

### Explicit Seed Ranges

[PR #9](https://github.com/pixeldj/batchcraft/pull/9) adds inclusive shorthand to the existing
**Explicit** seed list: `5-10` expands to `5,6,7,8,9,10`, while `10-5` descends by one. Mix ranges and
literals separated by commas or newlines; blank items are ignored, and order and duplicates are kept.
Values and endpoints must be integers in `0..9007199254740991` (`2^53-1`).

New frontend authoring permits at most **10,000 Explicit seeds in total**, counted across all items
before allocating expanded seed values. The overall backend Job budget is separate. Invalid input
leaves Seeds incomplete and produces an actionable error without sending a Preview request.

Fixed, Explicit, and Random remain the only modes: there is no fourth mode or configurable Step.
[BC-012](https://github.com/pixeldj/batchcraft/blob/v1.1.0/docs/BACKLOG.md#bc-012-increment-seed-mode) is **Superseded**, not an implemented Increment mode.
Saved Batches and Run snapshots still store numeric Explicit arrays; reload and Load Run as Batch
display newline-separated values. Historical arrays above the authoring cap remain readable in full.
This shorthand introduces no backend compiler, API, SQLite, or durable schema change.

### Execution And Test Reliability

PR #7 fixes a production read race between persisted execution state and process-local task ownership.
Run/execution reads conservatively retain active ownership across completion reads so polling cannot
stop on an older nonterminal snapshot. This does not add executor restart recovery or change frozen
Run provenance.

[PR #8](https://github.com/pixeldj/batchcraft/pull/8) separately makes the API tests' functional
completion wait tolerate slower durable file persistence on CI: a configurable 10-second budget,
early failure for unexpected terminal states, and elapsed-time/last-response diagnostics. This is a
**test-only wait change**, not a production timeout increase, API performance guarantee, or relaxed
expected-status assertion. Earlier intermittent browser-timeout evidence remains historical; these
fixes are not a claim that every intermittent timeout has been explained.

### Safe Installation Maintenance

PR #7 adds explicit macOS maintenance commands, run from the source checkout with daily and candidate
backends stopped:

- `uv run --directory backend python -m tools.refresh_test` defaults to the source checkout's
  **committed HEAD**, excludes uncommitted application edits, replaces only a validated installer-owned
  test candidate, and copies the entire offline daily data root without modifying daily data. It retains
  the live ComfyUI host but uses loopback access; this is not the fake-backed automated-test instance.
- `uv run --directory backend python -m tools.update_daily` selects stable version tags, takes a full
  backup before changing code, installs locked dependencies, and rebuilds the frontend. Fetching tags
   requires explicit `--fetch`; `--tag v1.1.0` selects this release.
  Downgrades are refused.

Both commands validate installation ownership and paths, require confirmation, and leave servers
stopped. An incomplete daily update blocks launch for manual repair. There is no automatic installation,
update, rollback, data restore, or backup pruning. A candidate may retain a live host, but maintenance
itself submits no GPU work. See [commands and failure recovery](https://github.com/pixeldj/batchcraft/blob/v1.1.0/docs/LOCAL_INSTANCES.md#refresh-a-live-test-candidate).

## Installation And Data Safety

Follow [Install From Source (macOS)](https://github.com/pixeldj/batchcraft#install-from-source-macos)
with `--revision v1.1.0`. Git, uv with Python 3.13 or newer, and Node.js/npm satisfying
`^22.22.2 || ^24.15.0 || >=26.0.0` are required; Node 24.15+ in the 24.x line is recommended.
Keep the source clone and its Git metadata: the installed application is a pinned linked worktree,
not a standalone application bundle. ComfyUI, models, and custom nodes must be installed separately.

**Back up the entire data root before updating an existing installation.** Finish active Runs and stop
all backends/data users first. Preserve SQLite and any `-wal`/`-shm` sidecars together with Projects,
Assets, and Run outputs. Project folders alone do not preserve mutable libraries or Saved Batches;
SQLite alone does not preserve historical artifacts. Never delete sidecars manually.

Application version **1.1.0** does not change the **v1 durable filesystem contract**. Format versions,
historical Run bytes, and the byte-locked v1 fixture remain unchanged. Since v1.0.0, additive forward
SQLite migrations `0003_history_browsing` and `0004_history_provenance` add rebuildable history indexes
and typed provenance. Existing migration bytes are preserved; this release preparation adds no migration.
Migrations apply at the next normal backend launch, not during the maintenance update command.
Older indexes remain basically browsable; advanced filters need successful reconciliation/enrichment,
with Reindex Project available for explicit repair. GET browsing does not rewrite Project files.

**Reverting code alone is not a database downgrade.** After migration, returning to older code requires
a deliberate restore of its matching whole-data backup and consistent code/dependencies/build, not an
automatic rollback. Test migration and restore on a separate copy, never the only copy of user data.
See [backup policy](https://github.com/pixeldj/batchcraft/blob/v1.1.0/docs/LOCAL_INSTANCES.md#updating-and-backing-up) and
[ADR 0012](https://github.com/pixeldj/batchcraft/blob/v1.1.0/docs/adr/0012-v1-filesystem-portability-recovery-draft.md).

## Validation

Local release-preparation checks passed on macOS on 2026-09-09, with the 1.1.0 metadata changes on
`f6e9f74`. `uv sync --frozen` refreshed only the editable application package; installed metadata,
the runtime version lookup, and the API health test agree on **1.1.0**. Dependency versions are unchanged.

- Backend: **1,403 pytest tests passed**. One upstream Starlette/httpx deprecation warning remains.
- Python quality: Ruff check passed; Ruff format checked **120 files**; mypy passed for **120 source files**.
- Backend build: `uv build --offline` produced the **1.1.0 wheel and sdist**; `uv lock --check --offline` passed.
- Frontend: **756 tests across 19 files passed**, plus typecheck, ESLint, and production build.
- Distribution: the offline combined checker passed wheel/sdist identity, license, and contents checks,
  plus **3 frontend distribution tests**, including a disposable source-map build and negative notice cases.
- Diff review confirms version-only lockfile changes and unchanged migration/fixture bytes and historical
  acceptance records. `git diff --check` passed.

- Browser: **18 desktop/mobile Chromium tests passed in each of Vite and built same-origin modes**,
  with zero retries. Both suites used temporary fake-backed data.
- Artifact browser security: HTML/SVG remained downloads rather than executable content; PNG and
  six-image bursts decoded without retries; admission limits and unchanged execution metadata passed.
- Fresh dependency audits on 2026-09-09 reported no known vulnerabilities: npm production/full and
  pip-audit 2.9.0 over frozen Python production/development pins. Python auditing covered applicable
  macOS/Python 3.13 dependencies, not all platforms. Dependency versions did not change for this release.

No everyday installation, user data, or live ComfyUI host was used. The annotated release tag is
published only after the final preparation commit passes hosted CI, including secret scans; the tag
also receives its own CI run. Local preparation evidence is distinct from these exact-revision checks.

Existing feature records include fake-backed Chromium desktop/mobile coverage in Vite and built
same-origin modes. The original v1.0.0 portability and live-execution acceptance remain recorded in
[V1_CROSS_INSTANCE_ACCEPTANCE.md](https://github.com/pixeldj/batchcraft/blob/v1.1.0/docs/V1_CROSS_INSTANCE_ACCEPTANCE.md) and
[V1_RELEASE_NOTES.md](https://github.com/pixeldj/batchcraft/blob/v1.1.0/docs/V1_RELEASE_NOTES.md), not reasserted as new v1.1.0 acceptance. BC-007 records overall
owner acceptance of its closed scope, not an observed live GPU Job or proof of every manual scenario.
This release preparation claims no new clean-machine installation, live GPU, Safari, native mobile,
or Windows-hosted batchcraft acceptance. Fake ComfyUI does not establish custom-node/model compatibility.

## Known Limits

- Single-user local/trusted-LAN operation without authentication. Do not expose batchcraft to the internet.
- No automatic executor restart recovery, global durable scheduler, Exact Rerun, or Result-level
  Recreate Result. Load Run as Batch creates editable intent and requires a new Preview.
- Stop-after-current does not interrupt the active ComfyUI Job; Stop waiting detaches local observation.
- Generated thumbnails, filmstrip, multi-value OR, complete conditioned facets, logical Workflow/Profile
  matching across revisions, and additional dedicated Run/Job sort modes remain deferred.
- Bounded browser pages do not imply page-proportional SQL work or an end-to-end performance guarantee.
  Images use lazy-loaded originals. Resource budgets are not total process-memory or disk quotas;
  ComfyUI HTTP timeouts are inactivity-based.
- Historical CSV remains raw data. Import spreadsheet columns as text with formula evaluation disabled.

## License And Security

batchcraft remains **GPL-3.0-only**; third-party dependencies retain their own licenses. This release is
source-only, with no bundled dependency environments, browsers, models, or custom nodes. Report
vulnerabilities privately through [security advisories](https://github.com/pixeldj/batchcraft/security/advisories).
See [SECURITY.md](https://github.com/pixeldj/batchcraft/blob/main/SECURITY.md) for deployment and reporting guidance.
Historical v1.0.0 audits are not a fresh v1.1.0 security certification.
