# batchcraft backlog

This file is the source of truth for unfinished product work, UX improvements, technical debt, and known defects. Accepted ADRs remain authoritative for architecture. A backlog entry may summarize an accepted decision, but it must not override or contradict one.

Actual repository behavior and accepted ADRs outrank stale backlog wording. Update an affected entry when implementation or an ADR changes its scope.

_Last consolidated: 2026-09-01._

## Current focus

Public v1 preparation is tracked by [BC-025](#bc-025-public-v1-release-hardening-and-acceptance).
Its portability gate is Passed; public publication remains open, separate from the private v1.0.0 tag.
Earlier entry-level gate notes record their milestone-time status; BC-025 holds current acceptance.

1. [BC-003A: Stop after current Job](#bc-003a-stop-after-current-job) (P1, Done)
2. [BC-003B: Force stop local waiting](#bc-003b-force-stop-local-waiting) (P1, In Progress)
3. [BC-003C: Interrupt owned ComfyUI Job](#bc-003c-interrupt-owned-comfyui-job) (P2, Planned)
4. [BC-002: Durable queued Runs](#bc-002-durable-queued-runs) (P2, Planned)

Cancellation and recovery of control from running, hung, or remotely uncertain Runs is the highest priority. A genuinely `failed` Run is already terminal. If a terminal failed Run still prevents Batch editing or creation of another Run, that is a separate correctness defect, not a cancellation operation.

Likely follow-on work after cancellation:

1. [BC-014: Prompt placeholder binding assistance](#bc-014-prompt-placeholder-binding-assistance)
2. [BC-001: Linked Parameter Sets / Presets](#bc-001-linked-parameter-sets--presets)
3. [BC-007: Project-wide Run and Result browser](#bc-007-project-wide-run-and-result-browser)

## Implemented foundations relevant to this backlog

The following capabilities are assumed to exist and should not be reimplemented inside backlog items unless repository inspection proves otherwise:

- durable Project, Prompt, Workflow, Workflow Profile, and Saved Batch libraries;
- immutable PromptVersion, WorkflowVersion, and WorkflowProfileVersion history;
- deterministic Preview-to-Run snapshot consistency;
- named Image Input slots with ordered alternatives and `Base workflow` support;
- typed generic Workflow Parameters with explicit alternatives and deterministic numeric ranges;
- concrete scalar-only Jobs at the execution boundary;
- persistent Run Plan and Result Details inspection from frozen Run provenance;
- browser closed-tab recovery that restores editable workspace intent and reloads Run truth from the backend;
- image-first Result galleries and lightbox behavior;
- simplified Variable Bindings based on one ordered values list, including intentional empty-string values.

Future work should extend these foundations rather than creating parallel models.

## Cross-cutting acceptance rules

These rules apply to every backlog item where relevant:

- A Batch is mutable; a Run is an immutable published snapshot.
- Every Job is fully resolved before execution. Lists, ranges, linked rows, randomness, and other intent must be materialized before reaching the executor.
- Run creation and execution may be separate operations, but Preview and Run creation must use the same exact inspected snapshot.
- SQLite may own mutable application or scheduler intent; filesystem Run artifacts remain authoritative for historical provenance and detailed execution state.
- The browser never communicates directly with ComfyUI.
- An ambiguous remote submission or interruption must never trigger blind resubmission.
- Historical Runs must remain understandable without current mutable library records.
- User-facing labels should hide internal IDs by default while retaining them in provenance and diagnostics.
- Backlog work must preserve deterministic order and explicit provenance.

## Dependency overview

```text
BC-003A Stop after current Job
    └── BC-003B Force stop local waiting
            └── BC-003C Interrupt owned ComfyUI Job

BC-002 Durable queued Runs
    └── coordinates with BC-003 cancellation state

BC-001 Linked Parameter Sets / Presets
    └── builds on current typed parameter alternatives/ranges

BC-007 Project-wide Run/Result browser
    ├── enables rich filtering
    ├── supports BC-015 Starred Results
    └── improves discovery for BC-006 Historical reuse

BC-009 /object_info integration
    ├── improves BC-008 video/file input mapping
    └── improves BC-010 Base-workflow preflight

BC-018 V1 filesystem recovery audit and contract
    └── BC-019 V1 format consolidation
            └── BC-020 Project import and historical reindex
                    └── BC-021 Load Run as Batch and cross-instance acceptance

BC-020 coordinates with BC-007 Project-wide Run/Result browser
BC-021 implements the portability-specific Load Run as Batch slice of BC-006
```

## Fields

Every entry has these fields:

| Field | Meaning |
| --- | --- |
| ID | Stable identifier. IDs are never reused. |
| Priority | Operational or product importance. |
| Status | Current backlog state. |
| Area | Primary product or technical area. |
| Summary | Concise description of the unfinished work. |
| Dependencies / Notes | Constraints, dependencies, accepted decisions, or completion evidence. |

## Priorities

| Priority | Meaning |
| --- | --- |
| P1 | Blocks or seriously disrupts normal operation. |
| P2 | High-value functionality or substantial workflow friction. |
| P3 | Meaningful improvement. |
| P4 | Minor polish or convenience. |

## Statuses

| Status | Meaning |
| --- | --- |
| Next | Highest-priority work ready to begin. |
| Planned | Accepted backlog work that is not active. |
| In Progress | Implementation has begun. |
| Blocked | Work cannot proceed until the stated dependency or decision is resolved. |
| Done | Implementation and required verification have succeeded. |
| Superseded | Another backlog item or ADR replaced the work. |

## Open items

### BC-003A: Stop after current Job

| Field | Value |
| --- | --- |
| ID | BC-003A |
| Priority | P1 |
| Status | Done |
| Area | Execution / Cancellation |
| Summary | Let a user request that a running Run stop after its currently submitted Job reaches a proven terminal state. |
| Dependencies / Notes | Follow ADR 0003: SQLite owns durable cancellation intent and `execution.json` owns the execution outcome. This operation must not clear unrelated ComfyUI queue work. It may introduce the minimum cancellation-intent storage needed without implementing the complete durable scheduler. |

Implementation progress: cancellation intent persistence, execution format v3, the cancellation endpoint
and read model, and stop-before-next-submission semantics are implemented. The frontend provides the
confirmed Stop action, visible request/stopping state, ambiguous-response reconciliation, terminal unlock,
closed-tab recovery, and preserved Result review. Automated coverage and owner acceptance are complete.
If the current Job is the final Job and succeeds, the honest Run outcome is `succeeded` because no
unsubmitted Job remains to cancel.

Correctness follow-up: owner testing found that closing and reopening the tab could restore the editable
draft without restoring the active Run monitor. Process-local active-Run discovery and independent
draft/monitor reconciliation are implemented with automated coverage, and the closed-tab owner retest
confirmed active progress reappears without resubmission.

Why this matters:

- Long Runs are common, and wrong settings may be discovered after several Jobs have completed.
- The user needs a safe stop action that preserves completed work and does not mislabel intentional cancellation as failure.
- Closed-tab recovery must show the same cancellation state after reopening the application.

Expected behavior:

- expose a clear `Stop after current Job` action while a Run is active;
- persist the request durably and make it idempotent;
- if no Job is currently submitted, stop before another submission;
- if a Job is already accepted, allow it to reach a proven terminal state;
- preserve and ingest that Job's Results;
- submit no subsequent Jobs;
- mark remaining unsubmitted Jobs `cancelled`;
- add a terminal Run status `cancelled`, distinct from `failed` and `blocked`;
- release the active-Run UI lock after the cancellation outcome is durable;
- survive browser refresh and closed-tab recovery;
- never clear unrelated ComfyUI queue work.

Non-goals:

- interrupting the currently running remote ComfyUI Job;
- automatic retry or reconciliation of ambiguous submissions;
- general scheduler implementation.

### BC-003B: Force stop local waiting

| Field | Value |
| --- | --- |
| ID | BC-003B |
| Priority | P1 |
| Status | In Progress |
| Area | Execution / Cancellation |
| Summary | Let the user regain control when ComfyUI observation or history reconciliation appears hung. |
| Dependencies / Notes | Coordinate with BC-003A's durable cancellation state. Preserve ADR 0001 and ADR 0003 rules for ambiguous remote outcomes and unsafe resubmission. This is a local-control escape hatch, not proof of remote cancellation. |

Implementation progress: durable `detach` intent, executor-owned local task wake-up and blocked
finalization, API/read-model support, and the confirmed frontend `Stop waiting` action are implemented.
Known submission evidence and already durable Results are preserved, later Jobs remain pending, refresh
restores the blocked outcome, and no ComfyUI interrupt or queue-clear operation is used. Automated
coverage and owner acceptance for the original implementation are complete. The follow-up for restored
`running` state after API process loss now exposes ephemeral local task ownership, stops stale polling,
preserves the unresolved Run honestly, and releases replacement-Run and Batch-save controls without
claiming remote cancellation. Automated coverage passes; retain In Progress until follow-up owner
acceptance is recorded rather than inferring it from the earlier implementation's acceptance.

Expected behavior:

- expose a deliberate `Stop waiting` action only while a current Job has unresolved local or remote work;
- stop batchcraft's local wait loop and automatic Run progression promptly;
- submit no further Jobs;
- preserve known prompt IDs, client IDs, submission dispositions, and diagnostics;
- do not claim the remote Job was cancelled unless that is confirmed;
- transition to an honest terminal local `blocked` state with an explicit remote-uncertainty diagnostic;
- release the frontend from an indefinitely active state while still preventing unsafe resubmission;
- allow later explicit reconciliation to resolve the remote outcome;
- remain idempotent if invoked repeatedly.

Important distinction:

```text
Local waiting stopped != remote ComfyUI execution stopped
```

If the prompt may have been accepted, the Job must never be reset to `pending`.

### BC-003C: Interrupt owned ComfyUI Job

| Field | Value |
| --- | --- |
| ID | BC-003C |
| Priority | P2 |
| Status | Planned |
| Area | ComfyUI / Cancellation |
| Summary | Safely interrupt the currently owned ComfyUI Job after verifying the real protocol. |
| Dependencies / Notes | Depends on BC-003A/BC-003B state semantics and a live protocol spike. Never blindly clear ComfyUI's global queue. Confirmed interruption may become `cancelled`; an ambiguous interruption remains blocked or cancellation-unconfirmed. |

Required investigation:

- determine whether the installed ComfyUI version can interrupt by prompt ID, queue item, client ID, or only globally;
- distinguish queued-but-not-running work from actively running work;
- verify the response and subsequent `/history` behavior after interruption;
- verify that unrelated ComfyUI work cannot be affected;
- define what evidence is sufficient to mark the Job `cancelled`.

Expected behavior:

- target only the batchcraft-owned prompt when the protocol supports ownership-safe interruption;
- retain prompt ID and diagnostics;
- reconcile through authoritative ComfyUI history after interruption;
- use `cancelled` only when interruption is confirmed;
- remain `blocked` or unconfirmed if the request or remote result is ambiguous.

### BC-001: Linked Parameter Sets / Presets

| Field | Value |
| --- | --- |
| ID | BC-001 |
| Priority | P2 |
| Status | Done |
| Area | Compiler / Parameters |
| Summary | Let related parameter values form one row-based compiler dimension instead of an unwanted Cartesian product with each other. |
| Dependencies / Notes | ADR 0011 defines the Batch-owned row model and supersedes ADR 0008's independent-only rule. Automated verification and the live ComfyUI Resolution smoke test passed. Compiled Jobs contain only resolved scalar values. |

Primary acceptance case:

```text
Resolution

Landscape  Width=1344  Height=768
Portrait   Width=768   Height=1344
Square     Width=1024  Height=1024
```

This must produce three resolution alternatives, not nine width/height combinations.

Additional examples:

- LoRA name + model strength + CLIP strength;
- Width + Height + FPS video presets;
- sampler + scheduler combinations;
- any user-named row-based preset made from two or more compatible parameters.

Recommended model:

- a linked set has a stable key and user-facing label;
- it contains an ordered list of member parameter keys;
- each ordered row supplies exactly one typed value or `Base workflow` value for every member;
- each row is one value of one compiler dimension;
- row order controls deterministic expansion order;
- a parameter may belong to at most one linked set;
- a linked parameter cannot simultaneously keep an independent alternatives/range dimension;
- duplicate rows are rejected;
- compiled Jobs contain only the resulting scalar parameter values.

Prefer explicit rows over merely zipping independent lists by position. Rows are easier to review, label, validate, and preserve in provenance.

Follow-up UX: creating a Preset now copies each selected parameter's saved Values alternatives into
explicit rows by position. The longest selected list determines row count, and missing cells become
`Base workflow`; a parameter currently showing Range contributes its retained Values draft without
frontend Range materialization. Preset override cells keep the frozen Base value visible. The expanded
Parameters section also links directly to the selected compatible Profile editor, opens New Profile when
the Workflow has none, or focuses the Profile chooser when a choice is required. Follow-up verification
passed with 622 backend tests, Ruff check/format, mypy, and package build, plus 373 frontend tests,
typecheck, lint, and production build.

### BC-002: Durable queued Runs

| Field | Value |
| --- | --- |
| ID | BC-002 |
| Priority | P2 |
| Status | Planned |
| Area | Scheduler |
| Summary | Let another Run be configured and queued while one Run is active. |
| Dependencies / Notes | Follow ADR 0003's scheduler authority model. Coordinate with BC-003 cancellation. The initial scheduler remains one active Run globally: Runs execute sequentially, not concurrently. Queue state must be durable and recoverable rather than browser-only or process-only. |

Expected behavior:

- allow Preview and Run creation while another Run is active;
- let the user enqueue the new immutable Run rather than replacing the active Run workspace;
- persist FIFO queue order in SQLite;
- keep queue intent separate from filesystem `execution.json` truth;
- claim one Run at a time;
- display queued/running/blocked/completed state clearly;
- after BC-003A cancellation, advance safely to the next queued Run;
- on backend restart, reconcile the previously active Run before claiming another;
- never treat lease expiry as proof that an ambiguous ComfyUI Job is safe to resubmit.

Initial non-goals:

- concurrent Runs;
- priorities beyond FIFO;
- distributed workers;
- multiple ComfyUI servers.

### BC-004: Prompt chooser and duplication

| Field | Value |
| --- | --- |
| ID | BC-004 |
| Priority | P3 |
| Status | Done |
| Area | Prompt Library / UX |
| Summary | Improve Prompt selection, creation, and duplication while keeping immutable version history available when needed. |
| Dependencies / Notes | The modal Prompt Library workspace, exact-revision duplication, collision-safe copy naming, lazy history selection, direct Prompt creation, and ordered Batch-selection controls are implemented. Automatic placeholder binding assistance remains tracked separately in BC-014. |

The first-Prompt transition now keeps the Prompt section explicitly expanded while its modal workspace
is open, so conditional section collapse cannot orphan the body scroll lock. Focus restoration and the
subsequent missing-binding flow have regression coverage.

Improve the normal flow to:

- open directly to the existing Prompt library rather than an initial `Choose Existing` / `Add New` decision screen;
- show a useful template-text preview on each Prompt card;
- provide a visible `New Prompt` action in the library view;
- provide `Add`, `Edit Prompt`, `Duplicate`, and `History` actions without exposing opaque IDs;
- duplicate the currently selected PromptVersion into a new logical Prompt starting at v1;
- suggest a unique editable name such as `Portrait copy`, `Portrait copy 2`, and so on;
- preserve the source Prompt and all of its versions unchanged;
- de-emphasize version terminology in normal use while retaining a subtle version badge and access to history;
- use language such as `Edit Prompt` while explaining secondarily that saving creates a new immutable revision.

The chooser must never silently substitute the latest version for a specifically selected historical version.

### BC-005: Workflow library convenience

| Field | Value |
| --- | --- |
| ID | BC-005 |
| Priority | P3 |
| Status | Done |
| Area | Workflow Library / UX |
| Summary | Make compatible Workflow and Workflow Profile creation, duplication, and reuse faster. |
| Dependencies / Notes | Existing selection, immutable versioning, visual mapping, mapping-copy assistance, and rename behavior provide the groundwork. Logical and immutable version identities must remain distinct. No new Workflow/Profile-combination entity is required: a ProfileVersion already targets one exact WorkflowVersion. |

Add or improve:

- `Duplicate Workflow`, copying the selected WorkflowVersion into v1 of a new logical Workflow;
- an option to copy compatible Profile mappings into new logical Profiles for the duplicated Workflow;
- a default new Profile name such as `<workflow-name>-profile`, with collision-safe suffixes;
- de-emphasized `WorkflowVersion` and `ProfileVersion` terminology in normal UI;
- primary labels such as `Edit Workflow` and `Edit Profile`, with immutable revision creation explained secondarily;
- a compact presentation of the compatible Workflow/Profile pair as one setup;
- smoother creation of a new ProfileVersion for a new WorkflowVersion by copying and validating prior mappings.

Duplication starts a new logical history at v1. It must not copy old version numbers or mutate the source Workflow/Profile.

Implementation result: the Batch editor now presents the compatible Workflow/Profile pair as one compact
`Workflow Setup`, keeps exact revision controls under `History`, and shows newer revisions without silently
changing a Saved Batch selection. Editing appends immutable Workflow or Profile revisions, with copied
Profile mappings opened for review after a Workflow edit. Duplication copies the exact selected
WorkflowVersion into a new v1 history and can copy the exact selected ProfileVersion mappings into a new
Profile v1. Suggested names are editable and collision-safe, and a failed optional Profile copy preserves
the new Workflow while opening the visual mapper for repair. No backend API, SQLite schema, or v1 filesystem
format changed. Verification passed with 619 backend tests, Ruff check/format, mypy, and package build, plus
356 frontend tests, typecheck, lint, and production build.

### BC-006: Historical reuse

| Field | Value |
| --- | --- |
| ID | BC-006 |
| Priority | P3 |
| Status | Planned |
| Area | Runs / Provenance |
| Summary | Add distinct workflows for loading, narrowing, or replaying frozen historical Run provenance. |
| Dependencies / Notes | Run Plan and Result Details already expose frozen provenance. Saved Batches and editable Batch snapshots provide the basis for restoration. Project-wide indexing in BC-007 improves discovery but is not strictly required for the core reuse operations. Historical Runs are never modified. |

Keep these operations distinct:

#### Load Run as Batch

- restore the Run's frozen editable Batch intent into a new or current editable draft;
- preserve Random/Range/alternative intent when present in the Run snapshot;
- reconnect exact library identities only when IDs and immutable content/hashes match;
- retain detached snapshots when current library records are missing;
- require Preview again before a new Run is created.

#### Recreate Result

- create a narrowed editable Batch from the concrete Job that produced one Result;
- use one PromptVersion, the exact resolved variable values, exact Image Inputs, exact parameter values, exact seed, and the same Workflow/Profile snapshot;
- allow the user to edit before Previewing;
- do not execute automatically.

#### Exact Rerun

- create a new Run using the exact historical concrete specification and ordering;
- allocate new Run/Job identities, timestamps, output namespace, and ComfyUI prompt IDs;
- never mutate or append to the historical Run.

Implementation progress: BC-021 completed the Run-level `Load Run as Batch` workflow, including frozen
editable intent, detached resources, exact relinking, explicit historical import, Preview invalidation,
and cross-instance automated coverage. Result-level `Recreate Result` and `Exact Rerun` remain unimplemented,
so BC-006 remains `Planned` for those distinct workflows.

### BC-007: Project-wide Run and Result browser

| Field | Value |
| --- | --- |
| ID | BC-007 |
| Priority | P2 |
| Status | Planned |
| Area | Results / Indexing |
| Summary | Add rebuildable Run, Job, parameter, Image Input, and Result indexes plus a Project-wide historical browser with useful provenance filters. |
| Dependencies / Notes | Follow ADR 0003's derived-index rules. BC-020 delivered the rebuildable projections and initial Project-wide history browser. Result bytes remain filesystem-owned. BC-015 adds durable stars/favorites on top of this browser. |

Primary product behavior:

- browse every indexed Run/Result in a Project, not only the current browser session;
- paginate or incrementally load large histories;
- preserve image-first cards, lightbox, Run Plan, and Result Details;
- sort by newest/oldest, Run, Job, or other deterministic criteria;
- isolate corrupt or missing Runs without preventing healthy history from loading.

Required filters should include:

- generic parameter key/value, such as `CFG = 0.8`, `Steps = 20`, or `LoRA Strength = 1.0`;
- `Base workflow` versus concrete override;
- seed;
- Prompt and PromptVersion;
- Workflow and Profile version;
- Saved Batch or historical Batch identity;
- Run status and date range;
- Image Input slot key + Asset ID, such as `Start Frame uses asset-a`;
- Asset used in any Image Input slot;
- starred state after BC-015.

Indexing implications:

- use rebuildable typed Job-parameter rows rather than relying only on opaque JSON;
- retain `parameter_key`, value type, typed value, and Base-workflow state;
- index Image Inputs by both `slot_key` and `asset_id`;
- retain Run/Job/Result identity and order;
- do not store Result bytes in SQLite;
- do not make absolute paths portable identity;
- full reindex must be possible from filesystem Run and execution artifacts;
- a stale SQLite projection must never override filesystem truth.

Implementation progress: BC-020 delivered rebuildable Run, Job, resolved-parameter, Image Input, Asset-use,
Result, and diagnostic projections plus explicit Project reindexing. Project History browses every indexed
Run grouped by Batch, loads its Results without browser-held Run IDs, preserves the image gallery,
lightbox, Run Plan, and Result Details, orders Runs newest-first, and isolates invalid or degraded history.
The API and UI still return the complete history without pagination, expose no alternate sort controls,
and provide none of BC-007's parameter, seed, Prompt, Workflow/Profile, Batch, status/date, Image Input,
Asset, or future starred-result filters.

Results UI cleanup is complete: thumbnail Job/Verified labels moved to detail inspection, and the
Batch Results gallery, accumulated state, and restoration requests were removed. Current Results,
Project History, integrity checks, cancellation, and current-Run recovery remain. Existing valid v4
drafts are preserved while obsolete gallery membership is ignored. Verification passed with 384
frontend tests, eight desktop/mobile browser tests across Vite and built same-origin modes, lint,
typecheck, and production build. Pagination, sorting, and advanced filters remain deferred beyond v1.

V1 slice: automatic history freshness for the current registered Project (P2, Done).

- Existing Results should appear without pressing Reindex Project. Restarting or updating with the same
  database and data root should retain history; reconcile missing or stale projections automatically.
- Show indexed history immediately, then reconcile against filesystem Runs when opening Project History.
  Indicate that history is being checked, and refresh after Run publication and execution completion.
- Serialize scan-and-replace operations per Project so an older scan cannot overwrite newer history.
- Preserve the prior index on inaccessible storage or failed scans, with an actionable stale/unavailable
  warning. Distinguish a confirmed empty Project from storage that could not be read.
- Keep manual reindex as a repair/retry tool. Do not rewrite historical artifacts or auto-import other
  Projects; new Project discovery and full-database-loss recovery retain the explicit import boundary.
- Verify same-data restart/update, missing index recovery, completed Run visibility, failed/concurrent
  scans, Project switching, and unchanged historical files. Measure larger-history scan cost before
  adding incremental indexing; startup-wide scans and filesystem watchers are outside this slice.

Implementation: opening history reads the existing index first and reconciles in the background.
Observed creation and terminal Run transitions refresh the frozen Run's Project, not an unrelated draft
Project. Registered scans cannot import foreign ownership; full scan-and-replace cycles are serialized,
and changed owners/directories or failed enumeration preserve the prior index. Worker cancellation
joins publication and indexing operations rather than abandoning writes. Missing execution metadata
keeps last-known Result metadata without images until fresh current-generation verification succeeds.
Verification passed with 923 backend tests, 421 frontend tests, eight desktop/mobile browser checks
across Vite and built same-origin modes, and the artifact-security/six-image browser check. Ruff,
mypy, frontend lint/typecheck, builds, distribution checks, current-source Gitleaks, actionlint, and
`git diff --check` pass. Browser coverage confirms completion in the open Project and reopening history
without manual reindex. Advanced filters, sorting, and pagination remain Planned; the broader BC-007
entry is not Done. The public v1 release gate remains separate.

### BC-008: Video and generic file input slots

| Field | Value |
| --- | --- |
| ID | BC-008 |
| Priority | P3 |
| Status | Planned |
| Area | Workflow Inputs |
| Summary | Generalize current Image Input slots to typed asset inputs for images, video, and generic files. |
| Dependencies / Notes | Verify actual ComfyUI upload routes, returned workflow values, MIME handling, and target-node expectations before assuming all media types work like images. BC-009 may improve type discovery and enum/model assistance. |

Expected direction:

```text
asset_type = image | video | file
```

For every slot, preserve:

- stable slot key and label;
- exact Workflow node/input target;
- ordered alternatives;
- `Base workflow` as an explicit no-mutation alternative;
- concrete one-value resolution per Job;
- frozen Asset provenance.

Required live protocol work:

- identify whether videos/files use `/upload/image`, another endpoint, or workflow-specific handling;
- verify path/subfolder normalization;
- verify retrieval and MIME behavior;
- test multiple media slots in one Job;
- avoid claiming support based only on filename extensions.

Initially support one file as one slot alternative. Nodes that accept a list of several files as one value remain a separate future capability.

### BC-009: ComfyUI `/object_info` integration

| Field | Value |
| --- | --- |
| ID | BC-009 |
| Priority | P3 |
| Status | Planned |
| Area | Workflow Profile Builder |
| Summary | Use ComfyUI node schemas to improve mapping assistance, typed controls, model choices, and validation. |
| Dependencies / Notes | The backend, not the browser, queries ComfyUI. Suggestions assist the user but never replace review. Preserve the boundary that ComfyUI remains the workflow editor. |

Use node schemas to improve:

- mapping suggestions by actual input type;
- enum and boolean controls;
- model, checkpoint, sampler, scheduler, and LoRA selectors;
- min/max/step hints for numeric inputs where provided;
- input-type validation beyond inference from current literal values;
- identifying file/image/video-like inputs;
- detecting mappings that became stale after a custom-node update.

Design considerations:

- cache schema data with clear refresh/invalidation behavior;
- surface the ComfyUI version/source of the schema;
- tolerate unavailable custom nodes and disconnected ComfyUI;
- never silently remap a ProfileVersion;
- new mappings still create immutable ProfileVersions after user review.

### BC-010: Base-workflow value visibility and failure context

| Field | Value |
| --- | --- |
| ID | BC-010 |
| Priority | P3 |
| Status | Done |
| Area | Validation / Batch UX |
| Summary | Show the actual frozen Workflow value behind `Base workflow` selections and add mapped-slot/parameter context when ComfyUI rejects a Base workflow input. |
| Dependencies / Notes | Value display uses the exact selected WorkflowVersion or frozen Run provenance without contacting ComfyUI. Rejection context requires an exact structured node/input match plus concrete Job Base state. Proactive remote availability checking is intentionally deferred unless real-world usage justifies it. |

Instead of only:

```text
CFG
Base workflow
```

show something like:

```text
CFG
Base workflow · 7
```

Additional examples:

```text
Steps
Base workflow · 20

Enable feature
Base workflow · false

LoRA
Base workflow · my-lora.safetensors

Start Frame
Base workflow · frame001.png
```

Requirements:

- derive the value from the exact selected WorkflowVersion;
- use frozen Run Workflow/Profile provenance for historical Run Plan and Result Details;
- preserve native types, including empty string, zero, and false;
- keep `Base workflow` semantics as “do not mutate this target”;
- display large strings compactly without hiding the fact that a value exists;
- preserve the original diagnostic when ComfyUI rejects a prepared workflow;
- add mapped slot/parameter label and Base value context only when structured rejection node/input data
  exactly matches a Profile target that the concrete Job left as Base workflow;
- never attribute a Project Asset or concrete scalar override failure to Base workflow;
- do not add Preview connectivity, proactive ComfyUI probing, retries, or changed submission-unknown behavior.

Implementation result: Batch Values, numeric Range inclusion, Preset rows, Preview, frozen Run Plan, and
Result Details now show the mapped value from the exact current or frozen Workflow/Profile provenance.
Missing, null, connected, and type-incompatible targets show `Base workflow · Unavailable`; long strings
remain compact with the full original value available as a title. Definite structured ComfyUI rejections
append context only for exact mapped targets that the concrete Job left at Base, while preserving the
original diagnostic and all overridden, unstructured, and ambiguous behavior. No API, SQLite, or v1
filesystem format changed. Verification passed with 622 backend tests, Ruff check/format, mypy, and
package build, plus 365 frontend tests, typecheck, lint, and production build.

BC-025 supersedes verbatim public diagnostic display: historical evidence remains intact, while API
responses derive fixed Base Image Input/parameter guidance and one-based positions from the same
structured target match. Labels, Base values, and upstream prose remain out of public diagnostics;
frozen provenance remains inspectable. Submission classification and override behavior are unchanged.

### BC-011: Create and Start

| Field | Value |
| --- | --- |
| ID | BC-011 |
| Priority | P4 |
| Status | Planned |
| Area | Run UX |
| Summary | Offer `Create & Start` as the primary post-Preview action and `Create only` as the secondary action. |
| Dependencies / Notes | Run creation and execution remain separate durable operations. A failed or ambiguous Start must not automatically create another Run or retry submission blindly. |

Expected behavior:

- primary action performs durable Run creation, then invokes Start for that exact new Run;
- secondary `Create only` preserves the current manual workflow;
- if creation fails, no Start request occurs;
- if creation succeeds but Start is definitely rejected, preserve the created Run and display the error;
- if Start is ambiguous, query durable execution state using the existing conservative behavior;
- never create a second Run automatically in response to Start uncertainty;
- keep the frozen Preview and Run association clear.

### BC-012: Increment seed mode

| Field | Value |
| --- | --- |
| ID | BC-012 |
| Priority | P4 |
| Status | Planned |
| Area | Seeds |
| Summary | Add deterministic incrementing seed intent with a start seed, count, and optional increment step. |
| Dependencies / Notes | Materialize concrete seeds before compilation. Preserve current seed bounds, Preview-to-Run consistency, and frozen concrete Run provenance. |

Suggested editable intent:

```text
Start seed: 1000
Count: 5
Step: 1
```

Materialized values:

```text
1000, 1001, 1002, 1003, 1004
```

Requirements:

- support positive or negative nonzero step if current seed bounds permit the resulting values;
- reject overflow/out-of-range results;
- show concrete seeds in Preview;
- Run creation uses the exact materialized Preview list;
- Saved Batch and editable Run snapshot preserve increment intent;
- concrete Jobs contain only explicit seeds;
- no randomness occurs in the compiler.

### BC-013: Persistent local configuration

| Field | Value |
| --- | --- |
| ID | BC-013 |
| Priority | P4 |
| Status | Planned |
| Area | Configuration |
| Summary | Add a persistent local configuration path for settings that are easy to lose between shells. |
| Dependencies / Notes | Cover the ComfyUI base URL, Projects root, database/data root, frontend origin, and relevant timeouts. Keep machine-specific configuration and secrets out of the repository. Existing environment-variable configuration is partial groundwork. |

Expected direction:

- one documented local configuration file in a configurable user/data location;
- environment variables override file values for temporary/session-specific changes;
- explicit validation and startup diagnostics;
- no secrets committed to Git;
- generated example/template file may be committed;
- current CLI/start commands continue working;
- later settings UI may edit the same configuration source, but is not required initially.

The format may be TOML, JSON, or another simple local format; choose based on the current settings implementation rather than adding a large framework.

### BC-014: Prompt placeholder binding assistance

| Field | Value |
| --- | --- |
| ID | BC-014 |
| Priority | P2 |
| Status | Done |
| Area | Prompts / Variable Bindings |
| Summary | Detect placeholders across selected PromptVersions and create missing Variable Bindings with one action. |
| Dependencies / Notes | Use the authoritative backend/domain placeholder parser rather than a second frontend-only regex. Builds on the simplified binding model where a binding owns one ordered values list and `""` is a valid intentional value. |

Example:

```text
Selected PromptVersions contain:
{{subject}}
{{style}}
{{post}}

Current bindings:
subject
```

The UI should show:

```text
Missing bindings: style, post
[ Create missing bindings ]
```

Expected behavior:

- inspect all selected PromptVersions in their Batch order;
- order discovered placeholders by PromptVersion order, then first occurrence within each template;
- deduplicate exact case-sensitive placeholder names;
- create only missing bindings;
- initialize a new binding with `values = []`, representing incomplete configuration;
- do not initialize with `values = [""]`, which would mean an intentional empty-string generation variant;
- preserve all existing binding values and order;
- never delete unused bindings automatically;
- continue surfacing existing unused-binding warnings;
- invalidate Preview after creating bindings;
- handle PromptVersion changes without silently overwriting user edits.

A future enhancement may offer a setting to create missing bindings automatically on Prompt selection, but the initial behavior should remain explicit and reviewable.

### BC-015: Starred Results and curated exports

| Field | Value |
| --- | --- |
| ID | BC-015 |
| Priority | P3 |
| Status | Planned |
| Area | Results / Curation |
| Summary | Let users star Results, browse a Project-scoped Starred collection, and optionally export curated files without moving canonical Run artifacts. |
| Dependencies / Notes | Durable stars are SQLite-authoritative user metadata keyed to stable Result identity. BC-007 provides the Project-wide browser/index needed for efficient discovery and filtering. Canonical Result files remain inside immutable Run output directories. |

Star semantics:

- star/unstar a Result from the gallery, lightbox, or Result Details;
- identify the Result using stable Run + Job + artifact identity, not filename alone;
- persist star state in SQLite;
- expose `All` and `Starred` Project gallery views;
- preserve star state across browser/backend restarts;
- a missing/corrupt Result may retain metadata but should display a degraded state;
- unstar does not delete or move the canonical Result.

Special-folder requirement:

Do not automatically move canonical files into a special Project folder.

Prefer an explicit action such as:

```text
Export Starred Results
```

which materializes copies, hardlinks where safe, or another non-authoritative convenience view under a Project export path such as:

```text
<project>/exports/starred/
```

Exported files are derived convenience artifacts. Define overwrite, naming, and cleanup behavior explicitly before implementation. They must never become the only copy or historical source of truth.

### BC-016: Batch editor default-state polish

| Field | Value |
| --- | --- |
| ID | BC-016 |
| Priority | P4 |
| Status | Planned |
| Area | Batch Editor UX |
| Summary | Make valid configured Image Inputs start collapsed while automatically exposing states that require attention. |
| Dependencies / Notes | Parent-level Image Inputs collapse already exists. This item concerns default and automatic presentation behavior only. Verify current behavior before implementation so completed work is not duplicated. |

Desired behavior:

- a valid configured Image Inputs section starts collapsed;
- collapsed summary shows slot count and total alternatives without listing every filename;
- zero-slot Profiles do not render a useless section;
- a new, empty, incomplete, missing-Asset, or validation-error state starts expanded;
- newly added Profile slots may expand the section so they are discoverable;
- the user's manual collapse/expand choice remains stable while the page is mounted;
- collapsing is presentation-only and never changes Batch values, dirty state, Preview validity, or Saved Batch persistence;
- individual Image Input slots do not need their own collapse controls.

This should be bundled with comparable small presentation fixes rather than treated as a large architecture milestone.

### BC-017: Named Runs and human-readable Run folders

| Field | Value |
| --- | --- |
| ID | BC-017 |
| Priority | P2 |
| Status | Done |
| Area | Runs / Provenance / Filesystem |
| Summary | Allow Runs to have a human-readable name and optional description, and use an immutable run-number-prefixed filesystem slug for the Run directory. |
| Dependencies / Notes | Fits the existing immutable Run provenance model and will improve BC-007 Project-wide Run browsing. Because batchcraft is pre-release, prefer a clean Run-directory convention change rather than preserving obsolete development layouts. |

Expected behavior:

- allow an optional Run name when creating a Run;
- allow an optional Run description / notes field;
- keep the immutable internal `run_id` as the true identity;
- keep the monotonic `run_number` for chronological ordering;
- generate an immutable filesystem key using `<zero-padded-run-number>-<slugified-run-name>`;

Examples:

- `001-baseline`
- `002-new-prompt`
- `003-cfg-sweep`
- `017-portrait-resolution-test`

If no Run name is supplied, generate a simple deterministic fallback such as `017-run`.

Additional requirements:

- freeze the Run name, description, and filesystem key into immutable Run provenance;
- do not rename a historical Run directory later if mutable annotations or display labels are added;
- do not derive the Run name automatically from every generation setting;
- keep detailed generation settings in existing provenance rather than encoding them into filenames;
- use the human-readable Run name throughout normal UI where useful, while keeping the Run number visible but secondary;
- display the Run name in Run Plan, Result Details, and Project History; the separate
  Batch Results session gallery is retired by the scoped Results cleanup;
- preserve exact Run/Job/Result provenance regardless of the display name.

Recommended filesystem layout:

    <projects-root>/
    └── <project-key>/
        └── batches/
            └── <batch-key>/
                ├── 001-baseline/
                ├── 002-new-prompt/
                └── 003-cfg-sweep/

User-facing hierarchy should read naturally as:

    Project
    └── Saved Batch
        └── Named Run

Example:

- Project: Character Experiments
- Batch: Outfit Transfer
- Run: CFG 4-7 comparison

The Run name is descriptive provenance for why this Run exists.

It must not affect:

- Batch compilation;
- Job ordering;
- seed materialization;
- workflow preparation;
- ComfyUI submission;
- Result identity.

Future BC-007 indexing should support:

- searching Runs by name;
- searching Run notes/description;
- displaying names in historical galleries;
- filtering Results by Run;
- showing the Run name alongside Run number/status.

Do not use mutable display names as filesystem identity.

### BC-018: V1 filesystem recovery audit and contract

| Field | Value |
| --- | --- |
| ID | BC-018 |
| Priority | P1 |
| Status | Done |
| Area | Persistence / Recovery |
| Summary | Audit current Project filesystem records and define the v1 portability contract and release test before schemas freeze. |
| Dependencies / Notes | V1-001. ADR 0012 remains Proposed. The audit is in `docs/V1_RECOVERY_AUDIT.md`; the release test is in `docs/V1_CROSS_INSTANCE_ACCEPTANCE.md`. This item changes contracts and planning only, not persisted formats or import behavior. |

Completion evidence: the audit and acceptance contract agree with current code and documentation.
Filesystem persistence tests, Project adoption tests, and browser working-session recovery tests pass.
The remaining release gaps are assigned to BC-019, BC-020, and BC-021.

Acceptance requires:

- an inventory of current Project artifacts, authorities, versions, and validators;
- a finding on whether modern Runs preserve editable intent and concrete provenance;
- explicit record-level and workflow-level recovery gaps;
- allocation of remaining work to BC-019, BC-020, and BC-021;
- one cross-instance acceptance contract that does not depend on SQLite or browser recovery state.

### BC-019: V1 format consolidation

| Field | Value |
| --- | --- |
| ID | BC-019 |
| Priority | P1 |
| Status | Done |
| Area | Persistence / File formats |
| Summary | Replace prerelease Project record schemas with explicit, independently versioned v1 formats that satisfy the recovery audit. |
| Dependencies / Notes | V1-002. Depends on BC-018 and ADR 0012. Follow the prerelease reset policy in ADR 0004. Do not add compatibility readers for unsupported development data unless separately required. |

Acceptance requires:

- explicit format identity and `format_version: 1` for every canonical durable Project JSON record;
- producer batchcraft version metadata where the audit requires it;
- a deliberate contract for frozen workflow files and the secondary CSV;
- resolution of missing fields identified by BC-018, including output intent documentation;
- strict round-trip, unsupported-version, hash, path, owner-chain, and fixture tests;
- updated `FILE_FORMAT.md`, developer policy, and format examples that match emitted bytes.

Implementation result: canonical Project JSON records now use strict named v1 contracts with producer
metadata; raw workflow/Profile payloads and the secondary CSV have independent v1 descriptors; CSV is
emitted during publication but optional during normal loading; each Job freezes an identity-bound output
prefix; and `backend/tests/fixtures/v1_project/` locks emitted bytes and round-trip behavior. Import,
historical reindexing, detached resources, and cross-instance acceptance remain in BC-020/BC-021.
Verification passed with 569 backend tests, Ruff check/format, mypy, Python package build, 304 frontend
tests, frontend typecheck/lint/build, and `git diff --check`. No live ComfyUI host was required.

### BC-020: Project import and historical reindex

| Field | Value |
| --- | --- |
| ID | BC-020 |
| Priority | P1 |
| Status | Done |
| Area | Persistence / Import / Indexing |
| Summary | Import a copied v1 Project into an empty database, discover its historical Runs, and rebuild disposable historical indexes from filesystem truth. |
| Dependencies / Notes | V1-003. Depends on BC-019. This is the portability prerequisite for BC-007, not the complete Project-wide browser. Import must be identity-aware, non-destructive, idempotent, and honest about degraded content. |

Acceptance requires:

- complete Project, Batch, Run, execution, Asset, and Result discovery without supplied Run IDs;
- Project-level validation with conflicting ownership rejected and bad Runs isolated where safe;
- rebuildable Run, Job, Result, parameter, Image Input, and Asset-use projections;
- repeated import/reindex with no duplicate trusted records or historical file rewrites;
- APIs that let the frontend browse imported history without browser `localStorage` IDs;
- degraded-state reporting for unsupported formats, missing Assets, corrupt Results, and duplicate IDs.

Implementation result: owned v1 Projects import by safe immediate-child filesystem key, while ownerless
adoption remains a distinct explicit identity mutation. Read-only scanning preserves filesystem
authority and atomically replaces rebuildable Project historical projections. Invalid records are
isolated with diagnostics; valid Runs are verified or degraded; missing/invalid execution is explicitly
unavailable; and Results report verified, missing, or corrupt integrity. The API and frontend expose
Project history, reindex, frozen Run detail, and Result review without browser-held Run IDs. Strict
mutation and download paths still require complete validated storage.

Verification passed with 585 backend tests, Ruff check/format, mypy, and the Python package build, plus
309 frontend tests, typecheck, lint, and the production build. `git diff --check` also passed. This is
not a claim that BC-021's manual cross-instance acceptance has passed.

### BC-021: Load Run as Batch and cross-instance acceptance

| Field | Value |
| --- | --- |
| ID | BC-021 |
| Priority | P1 |
| Status | Done |
| Area | Runs / Recovery / Historical reuse |
| Summary | Reconstruct editable Batch intent from a modern historical Run with detached resources. |
| Dependencies / Notes | V1-004. Depends on BC-020. Implements the portability-specific `Load Run as Batch` part of BC-006; `Recreate Result` and `Exact Rerun` remain in BC-006 and are deferred beyond v1. The separate clean-instance/live release gate is unfinished under BC-025 and `docs/V1_CROSS_INSTANCE_ACCEPTANCE.md`. |

Acceptance requires:

- reconstruction of Prompt, Variable Binding, Image Input, Parameter Values/Range, Linked Parameter Set,
  seed, Workflow, and Workflow Profile intent from the frozen Batch snapshot;
- detached historical resources that support inspection and Preview without manufacturing library rows;
- exact-content relinking, explicit detached import, and hard conflicts for identity/content mismatch;
- a new Preview before creating a new immutable Run;
- automated cross-instance import, inspection, reconstruction, relinking, and degraded-content tests;
- a separately tracked live ComfyUI release smoke test under BC-025, not satisfied by these automated tests;
- unchanged hashes for every original historical Run file.

Implementation progress: historical Runs now load as unsaved editable drafts through a read-only,
conflict-aware reconstruction endpoint. Exact identities relink, absent identities remain detached, and
same-ID content mismatches remain conflicts. Explicit Run-scoped imports create new Prompt, Workflow, and
Profile history from server-loaded frozen content. Deterministic import request identities make retries
idempotent, while recovery v4 preserves explicit per-draft historical import resolutions and resumes a
Workflow import whose dependent Profile import failed. Imported resources preserve frozen display names;
genuine uniqueness collisions use deterministic `(imported)` suffixes. Focused clean-instance coverage
proves exact pre-edit Preview, new Run creation, and unchanged original Run hashes. Final review coverage
also protects stale frontend reconstruction/import requests, cold Random-seed recovery, Project filesystem
ownership, archived resources, and dependent Workflow/Profile conflicts. Verification passes with 611
backend tests, Ruff check/format, mypy, and package build, plus 352 frontend tests, typecheck, lint, and
production build. The complete realistic fixture, repeat-fresh-instance proof, and live ComfyUI gate remain
as release blockers under BC-025 and `docs/V1_CROSS_INSTANCE_ACCEPTANCE.md`, not completed BC-021
implementation evidence.

### BC-022: Random seed per-Job semantics

| Field | Value |
| --- | --- |
| ID | BC-022 |
| Priority | P1 |
| Status | Done |
| Area | Seeds / Compilation / Reproducibility |
| Summary | Materialize a distinct Random seed for every concrete Job while preserving Fixed and Explicit seed behavior. |
| Dependencies / Notes | Correctness fix and v1 blocker. Random count is repetition intent per non-seed configuration. Preview must expose the exact concrete seeds reused by Run creation. Keep Saved Batch and Batch snapshot Random intent separate from frozen per-Job Run seeds. No durable format change is expected. Do not mark Done until automated verification and manual browser/live generation acceptance pass. |

Implementation progress: backend Preview now owns unique per-Job materialization across the full safe
seed range, while the pure compiler preserves deterministic fastest-varying Random repetition order.
The frontend retains Preview's concrete assignments through Run publication retry and restores only
Random count intent from Saved Batches, historical Runs, and working-session recovery. Fixed and Explicit
reuse is unchanged; valid older Runs with repeated Random seeds remain readable. Automated verification
passes with 619 backend tests, Ruff check/format, and mypy, plus 352 frontend tests, typecheck, lint, and
production build. Owner browser/live generation acceptance is complete.

Acceptance requires:

- Random x N creates N fastest-varying repetitions for every ordered non-seed configuration;
- every Job in one new Random materialization receives a unique seed within the existing seed bounds;
- Preview and Run creation use the same materialized per-Job values, including publication retries;
- Fixed reuses one seed across configurations and Explicit reuses its ordered seed list across each
  configuration;
- Saved Batch, Batch snapshot, historical reconstruction, and working-session recovery preserve Random
  count as editable intent without persisting Preview seeds;
- immutable Run Jobs and Result provenance retain each exact concrete seed;
- automated backend/frontend verification and the documented manual browser/live generation check pass.

### BC-023: Isolated local instances and browser verification

| Field | Value |
| --- | --- |
| ID | BC-023 |
| Priority | P1 |
| Status | Done |
| Area | Development / Release verification |
| Summary | Separate everyday code and data from development, and add real-browser testing and agent inspection. |
| Dependencies / Notes | ADR 0014. Keep the real API, compiler, executor, and stores; inject fake ComfyUI only in isolated development/test tooling. No automatic production promotion or user-data reset. |

Acceptance requires a pinned everyday checkout and built frontend, explicit independent data roots,
fixed ports with loopback defaults, fake-backed desktop/mobile Playwright smoke tests, and verified MCP screenshot
capture. Runtime configuration must not inherit live data or ComfyUI settings into tests. Document safe
startup, shutdown, updates, and backup boundaries in `docs/LOCAL_INSTANCES.md`.

Implementation result: isolated launchers, a new-worktree installer, explicit sandbox seeding, simulated
ComfyUI, and project-scoped Playwright MCP are implemented. Verification passed with 630 backend tests,
373 frontend unit tests, four desktop/mobile real-API browser tests, Ruff check/format, mypy, frontend
lint/typecheck, and both builds. MCP navigation and screenshot capture were verified locally. A pinned
everyday installation was provisioned with fresh separate data; live connectivity was checked without
submitting a Job. CI configuration is added but has not yet run on GitHub. This is not the separate v1
cross-instance recovery release gate.

LAN follow-up: everyday-only `lan_access` opt-in and same-origin frontend builds are verified with 637
backend tests, 377 frontend tests, and eight desktop/mobile browser scenarios across Vite and built
same-origin serving. Ruff, mypy, lint/typecheck, and builds pass. The pinned everyday installation was
backed up and updated without changing application source or data formats. Read-only browser checks
from the Mac passed at its LAN IP, localhost, and loopback; a second physical device was not tested.
Development/test listeners remain loopback-only. No authentication or wildcard CORS is added.

### BC-024: Live current-node progress

| Field | Value |
| --- | --- |
| ID | BC-024 |
| Priority | P3 |
| Status | Planned |
| Area | Execution / ComfyUI / UI |
| Summary | Show reported progress for the current Job's executing node, separately from Run-level completed-Job progress. |
| Dependencies / Notes | Lower priority than BC-007 automatic history freshness. Reuse backend ComfyUI WebSocket observations and existing frontend execution polling. No direct browser-to-ComfyUI connection. |

Acceptance and scope:

- Display validated, prompt-correlated node progress counters and percentage when available. Label them
  as node progress, not overall Job completion; use sampling-step wording only where semantics are known.
- Preserve the separate Run-level completed-Job indicator. Multiple samplers, decoding, saving, and
  Result downloads mean a node reaching 100% does not complete the Job; execution history stays authoritative.
- Reset counters on node/Job changes and prevent late events from appearing on another Job. Show an
  indeterminate or explicitly stale/unavailable state when counters are absent, old, or disconnected.
- Keep observations ephemeral and nonfatal. Do not add them to SQLite, execution artifacts, frozen Run
  provenance, or browser recovery; backend restart must not restore falsely live progress.
- Test deterministic fake events for counter updates/resets, malformed or unrelated events, missing
  progress, disconnects, completion, and browser reload. Confirm installed ComfyUI/custom-node payloads
  only in a separately authorized live check.
- Whole-Job percentage estimates, ETA, durable telemetry history, and WebSocket reconnection are deferred.

### BC-025: Public v1 release hardening and acceptance

| Field | Value |
| --- | --- |
| ID | BC-025 |
| Priority | P1 |
| Status | In Progress |
| Area | Security / Licensing / Release / Documentation |
| Summary | Resolve the public-source audit findings and pass candidate-specific installation, privacy, security, and cross-instance release acceptance. |
| Dependencies / Notes | Builds on BC-021 and BC-023. ADR 0015 defines local browser defenses and runtime budgets. ADR 0012 is Accepted and `V1_CROSS_INSTANCE_ACCEPTANCE.md` is Passed. Remaining work concerns public publication, not the private v1.0.0 tag. No history rewrite, visibility change, or everyday/live promotion is authorized by this entry. |

Scope decisions:

- Public v1 is a macOS source installation, with basic README prerequisites, install, launch, and
  update/backup instructions. Standalone application packaging remains deferred.
- BC-007 automatic registered-Project history freshness is included in v1; advanced history filters,
  sorting, and pagination remain later work.
- License the project under GNU GPL version 3 only (`GPL-3.0-only`). Preserve dependency notices and
  review redistribution rights for fixtures and any packaged components.
- Remove private identifiers and personal package contact information from current source only;
  existing history is retained with owner approval. Never treat cleanup as credential revocation.
- Exact Rerun is deferred beyond v1. Editable `Load Run as Batch` preserves Random intent and asks for
  fresh seeds; historical inspection retains the frozen seeds.
- Preserve raw historical CSV. A separate spreadsheet-safe export is deferred beyond v1. Import every
  column explicitly as text with formula evaluation disabled, or use a text editor; CSV quoting does
  not neutralize formulas. Never rewrite historical manifests. See [SECURITY.md](../SECURITY.md).
- v1.0.0 is source-only on macOS. Automated browser coverage is Chromium desktop/mobile viewports,
  not Safari or a Windows-hosted batchcraft app. A private tag is distinct from public publication.

Implemented groundwork on the cleanup branch:

- Privacy cleanup, root GPL license, metadata, public security policy, broader secret-file ignores,
  checksum-pinned redacted Gitleaks checks, and commit-pinned CI Actions.
- Passive Result serving, Host/Origin mutation defenses, a 64 MiB total request budget, a configurable
  10,000-Job new-plan budget, and nonblocking regular-file validation with chunked integrity reads.
- Offline live-verification setup now publishes Project ownership and compiles a matching snapshot.
- Current Random/recovery/detach/reconstruction docs, supported Node versions, source installation
  requirements, and the Random/missing-execution acceptance distinctions are reconciled.
- Public domain, upstream, history, and execution diagnostics use bounded safe summaries. Structured
  Base Image Input/parameter guidance remains; HTTP/task failure logs retain safe failure context and
  hashed Run correlation without exposing raw exception chains. Historical evidence is not rewritten.
- Frontend builds include the complete GPL license and bundled runtime/tool notices. Backend wheel
  and sdist include GPL-3.0-only metadata and a verified license copy. Automated artifact checks reject
  missing/truncated/stale notices, unreviewed bundled dependencies, and unexpected package inputs.
- Request bodies now have per-process capacity and receive/spool deadlines, with joined cleanup under
  shutdown cancellation. Verified Asset/Result downloads use owned disk snapshots and bounded buffers
  rather than whole-file RAM allocation. Trusted storage anchors support macOS temporary-path aliases
  without permitting symlinks inside the store.
- Historical reads and serialization run off the event loop with bounded active/waiting capacity.
  Execution polling has separate capacity. Project History limits Result-list fan-out to two Runs,
  and only structured GET read-capacity failures receive bounded retries; mutations never retry.
- BC-007's automatic current-Project history freshness slice is complete. README now includes basic
  macOS source installation and launch instructions. This is not clean-machine installation acceptance
  or permission to update the everyday installation.
- New-plan request preflight passes Job and resolved-text budgets before Range allocation, with defaults
  of 1 MiB per prompt and 32 MiB aggregate raw UTF-8 text. ComfyUI responses have configurable 8 MiB
  JSON/error, 256 MiB artifact, and 4 MiB WebSocket caps with identity-only HTTP content encoding.
  Historical validation avoids a second complete plan and full prompt re-resolution; Saved Batch
  validation uses counts. Run creation, Asset import, and cancellation filesystem validation use joined
  workers. ADR 0015 and the focused compiler/integration docs record accounting and remaining limits.

The focused resource review is complete. Remaining operational limits are documented rather than
addressed by new historical format restrictions: full historical metadata parsing still uses memory,
four concurrent download snapshots have no combined disk cap or active-stream deadline, and ComfyUI
HTTP inactivity timeouts are not whole-transfer deadlines. Payload and admission limits are not a
whole-process memory bound or a complete denial-of-service defense.

Remaining public-publication work:

- Audit the final release for GPL corresponding-source delivery and any separately bundled dependencies,
  runtimes, browsers, models, or fixture rights. Artifact notice checks do not establish complete
  distribution compliance or make the source installation a standalone application package.
  In particular, record provenance/redistribution rights for the spike workflow JSON and the embedded
  one-pixel PNG in `backend/tests/live/test_execution_setup.py` before public publication.
- Enable and verify GitHub private vulnerability reporting and hosted secret/push protection before
  public publication. Read-only administrative API inspection shows the repository is PRIVATE,
  `security_and_analysis` is `null`, and private vulnerability reporting returns HTTP 404. These are
  not verified enabled settings. No repository visibility change is authorized.
- Repeat release-content scans if code or dependencies change before public publication.

V1 tag preparation: production/full npm audits and pinned pip-audit 2.9.0 scans of the locked Python
production/development dependencies found no known advisories. Gitleaks 8.30.1 found no secrets in the
reviewed current source or 55 locally reachable commits. Dependency versions are unchanged by the
1.0.0 metadata bump. These scans do not prove historical privacy or cover every platform. The source
inventory contains no model weights, photographic assets, databases, or bundled runtime/browser
binaries; fixture provenance limitations remain listed above. Both GPL license copies match.
The 1.0.0 metadata passes 1,147 backend tests, 427 frontend tests, lint/format/type checks, frontend
build, and wheel/sdist plus frontend distribution checks. Final pushed-commit CI must pass before the
annotated tag is created; CI also scans that exact checkout and its fetched history.

Audit evidence: pinned Gitleaks found no secrets in the audited current source or locally reachable
history. npm production/full and pinned pip-audit production/development scans reported no known
advisories for the audited platform on 2026-09-05. This does not cover ComfyUI, models, OS/browser
binaries, every platform-specific dependency, or all licensing obligations.

Cleanup verification: 923 backend tests, 421 frontend tests, eight desktop/mobile smoke tests across
Vite and built same-origin modes, and the real HTML/SVG/PNG artifact-security browser check pass.
The browser check now includes a six-image burst with four concurrent preparations and no image retry.
Resource regressions cover upload/read saturation, independent polling, worker shutdown, FIFO and
internal-symlink rejection, macOS runtime aliases, verified snapshots under source replacement, and
GET-only capacity retries with Project-switch cancellation.
The backend total includes 13 actual-package notice tests; three additional frontend distribution checks
and the combined offline artifact checker pass. Ruff lint/format, mypy, frontend lint/typecheck,
backend/frontend builds, actionlint, final redacted current-source secret scans, and `git diff --check`
pass. The test suite reports an upstream Starlette/httpx deprecation warning. One existing frontend
snapshot-divergence test failed once during parallel checks, then passed in isolation and in a full
rerun without changes; it also passed in this resource pass. Watch for recurrence in candidate CI rather
than treating its cause as resolved.
PR #3 hosted checks passed and the PR was merged. The owner reports installing from a fresh temporary
source checkout, copying and importing a Project, browsing its full history, loading a Run as a Batch,
and importing its Prompt/Workflow resources successfully. This is useful source-install and recovery
smoke evidence. The owner subsequently confirmed that the portability requirements work on their
instance. This earlier report did not identify the tested revision or supply individual artifacts;
the candidate-specific acceptance below supersedes its pending status.

Owner-feedback polish: production installer builds omit the internal instance badge while sandbox
labels remain. Session notices are dismissible; the restored-draft reminder clears after a successful
current Preview without changing recovery data or weakening Preview requirements.
Verification passes with 924 backend tests, 427 frontend tests, eight desktop/mobile browser checks,
lint/type checks, frontend build, and distribution checks. Desktop/mobile notice screenshots were
inspected. This follow-up does not modify existing installed builds or user data.

Resource-fix verification: 1,147 backend tests, 427 frontend tests, and eight fake-backed desktop/mobile
browser cases across Vite and built same-origin modes pass. Ruff lint/format, mypy, frontend lint and
typecheck, frontend build, wheel/sdist distribution checks, three frontend distribution checks, and
`git diff --check` pass. The successive-Run test now waits for the enabled Create Another Run button
before clicking; ten focused repetitions pass. This fixes its readiness race, not the separate
snapshot-divergence test noted above. No live ComfyUI or everyday-data verification was performed.

Final candidate acceptance: on 2026-09-05 the owner explicitly confirmed candidate
`79190ebadeb47c952e3bfeec23bfe15d3123d971`, all portability requirements, clean macOS source installation,
Project import, `Load Run as Batch`, resource import, and successful new Job execution. PR #5 merged as
`3eeb87a77e823c866bcf161313394d4af79059f1` with green checks. The portability gate is Passed and ADR 0012
is Accepted. This is owner-reported manual evidence, not an independently observed live test or retained
archive-hash report. No repeat is required merely because acceptance was owner-reported.
BC-025 remains In Progress only for the public-publication work above; it does not block the private
v1.0.0 tag. Final release-check evidence will be added when supplied, not inferred from prior checks.

## Maintenance rules

- Update only entries affected by the current task.
- New implementation prompts should reference a backlog ID when one exists.
- Change an item to `In Progress` when implementation begins.
- Change an item to `Done` only after required verification succeeds.
- Use `Blocked` with a concise reason and dependency.
- Use `Superseded` when another item or ADR replaces the work.
- Do not delete completed IDs or reuse them.
- Keep entries concise enough to scan. Detailed architecture belongs in ADRs and feature documentation; acceptance notes may remain here when they prevent ambiguity.
- Do not add every incidental coding task to the product backlog.
- When a bug is discovered inside an active item, record it under that item unless it has a separate lifecycle or priority.
- When an item is partially implemented, update `Dependencies / Notes` with the completed groundwork and leave the remaining acceptance behavior explicit.
- Periodically move older Done items into a clearly labeled completed section or changelog while retaining their IDs.
- Actual repository code and accepted ADRs outrank stale backlog wording.
- Revisit Current Focus after completing a P1/P2 item rather than allowing it to become a static roadmap.

## Revision notes for this consolidation

- Promoted BC-007 from P3 to P2 because parameter/seed/Asset filtering is becoming central to experiment review.
- Renamed and expanded BC-001 as `Linked Parameter Sets / Presets` and documented the row-based Resolution use case.
- Expanded BC-010 from file preflight alone to include displaying actual Base-workflow values.
- Added BC-014 for automatic missing-binding assistance.
- Added BC-015 for durable stars and optional curated exports.
- Added BC-016 for default-collapsed Image Inputs presentation.
- Added more explicit cancellation, scheduler, historical reuse, indexing, and library UX acceptance context from prior product discussions.
