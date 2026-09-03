# batchcraft backlog

This file is the source of truth for unfinished product work, UX improvements, technical debt, and known defects. Accepted ADRs remain authoritative for architecture. A backlog entry may summarize an accepted decision, but it must not override or contradict one.

Actual repository behavior and accepted ADRs outrank stale backlog wording. Update an affected entry when implementation or an ADR changes its scope.

_Last consolidated: 2026-09-01._

## Current focus

1. [BC-003A: Stop after current Job](#bc-003a-stop-after-current-job) (P1, Done)
2. [BC-003B: Force stop local waiting](#bc-003b-force-stop-local-waiting) (P1, Done)
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
coverage and owner acceptance for the original implementation are complete. A follow-up correctness fix
is in progress for restored `running` state after API process loss: expose ephemeral local task ownership,
stop stale polling, preserve the unresolved Run honestly, and release replacement-Run and Batch-save
controls without claiming remote cancellation.

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
| Status | Planned |
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

### BC-007: Project-wide Run and Result browser

| Field | Value |
| --- | --- |
| ID | BC-007 |
| Priority | P2 |
| Status | Planned |
| Area | Results / Indexing |
| Summary | Add rebuildable Run, Job, parameter, Image Input, and Result indexes plus a Project-wide historical browser with useful provenance filters. |
| Dependencies / Notes | Follow ADR 0003's derived-index rules. The current gallery is limited to Run IDs retained by the working session. Result bytes remain filesystem-owned. BC-015 adds durable stars/favorites on top of this browser. |

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

### BC-010: Base-workflow value visibility and preflight

| Field | Value |
| --- | --- |
| ID | BC-010 |
| Priority | P3 |
| Status | Planned |
| Area | Validation / Batch UX |
| Summary | Show the actual frozen WorkflowVersion value behind `Base workflow`, then detect stale embedded image/video/file inputs before execution. |
| Dependencies / Notes | Basic value display can use the immutable WorkflowVersion without contacting ComfyUI. Remote file availability preflight requires verified ComfyUI behavior and may benefit from BC-009. Do not infer remote existence from a filename alone. |

Phase A — value visibility:

Instead of only:

```text
CFG
Base workflow
```

show something like:

```text
CFG
Use workflow value · 7.0
```

Additional examples:

```text
Steps
Use workflow value · 20

Enable feature
Use workflow value · false

LoRA
Use workflow value · my-lora.safetensors

Start Frame
Use workflow image · frame001.png
```

Requirements:

- derive the value from the exact selected WorkflowVersion;
- preserve native types, including empty string, zero, and false;
- keep `Base workflow` semantics as “do not mutate this target”;
- display large strings compactly without hiding the fact that a value exists.

Phase B — remote preflight:

- detect stale embedded image/video/file values before Run execution where ComfyUI provides a reliable verification mechanism;
- show an actionable warning naming the slot and missing value;
- distinguish warning from definite failure when remote verification is incomplete;
- do not alter the frozen WorkflowVersion automatically;
- offer a path to choose a Project Asset or edit/create a new WorkflowVersion.

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
- update Run Plan, Result Details, Batch Results, and future Project-wide Run history to display the Run name;
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
