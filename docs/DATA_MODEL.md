# batchcraft Data Model

## Goal

The data model must support reusable prompts, reusable variable values, reference libraries, reusable ComfyUI workflow mappings, editable experiment definitions, frozen Run plans, advancing execution state, reproducible Jobs, result review, and filesystem-based Run recovery.

This document describes domain semantics rather than a final SQL schema.

## Entity Relationships

```text
Project
 |
 +-- Workflow
 |     |
 |     +-- WorkflowVersion
 |     |
 |     +-- WorkflowProfile
 |           |
 |           +-- WorkflowProfileVersion
 |
 +-- Prompt
 |     |
 |     +-- PromptVersion
 |
 +-- VariableList
 |
 +-- ReferenceAsset
 |     |
 |     +-- ReferenceCollection
 |
 +-- Batch
       |
       +-- Run
             |
             +-- Job
                   |
                   +-- Result
```

## Project

A top-level workspace.

Suggested fields:

```text
id
name
description
created_at
updated_at
project_path
filesystem_key
```

## Prompt

A stable, Project-scoped library identity for a reusable Prompt Template. ADR 0003 and the SQLite
schema use `Prompt` for this logical record; the pure compiler continues receiving immutable
`PromptVersion` snapshots and does not depend on persistence records.

Suggested fields:

```text
id
name
description
created_at
updated_at
archived_at
```

The editable text itself belongs to PromptVersion.

## PromptVersion

An immutable revision of a Prompt.

Suggested fields:

```text
id
prompt_id
version_number
name_snapshot
text
note
created_at
archived_at
```

The name is a human-readable label snapshotted with the immutable PromptVersion. It is not an
identity and does not replace the stable PromptVersion ID.

Example text:

```text
A cinematic photograph of {{subject}} in {{environment}}.
```

The latest version is derived from version history. Editing saved text or restoring an old version
creates the next monotonic version rather than mutating historical versions.

## VariableList

A reusable ordered list of candidate values.

Suggested fields:

```text
id
name
description
tags
created_at
updated_at
```

Example:

```text
name: Animals
values:
  - cat
  - dog
  - bird
```

Variable Lists are an authoring library. An active VariableBinding copies its selected ordered values;
it does not retain source-list identity or execution mode.

### Historical reproducibility

Runs must snapshot the effective values used, even if the source VariableList changes later.

The initial implementation can snapshot values into the Run rather than versioning every VariableList edit.

## ReferenceAsset

Metadata for an input asset available to workflow bindings.

Initial type:

```text
image
```

Suggested fields:

```text
id
project_id
type
original_filename
stored_path
sha256
mime_type
width
height
created_at
tags
notes
```

A content hash is required for content-addressed storage, identity, deduplication, and manifest provenance.

Reference Asset bytes are immutable once stored in the Project. The content hash identifies the stored content, while the asset ID provides stable domain identity. Importing identical bytes may reuse the existing content-addressed file.

Deleting an asset from a collection or hiding it from the active library does not remove stored bytes referenced by a historical Run. Physical deletion is allowed only when no historical Run references the content. Missing SQLite state is never evidence that deletion is safe; the filesystem Run history must remain part of the reference check.

## ReferenceCollection

A reusable named collection of ReferenceAssets.

Suggested fields:

```text
id
name
description
created_at
updated_at
```

Membership should preserve deterministic ordering.

## Workflow

A stable Project-scoped library identity for an imported ComfyUI API workflow. Editable name,
description, and archive state belong to the logical Workflow.

## WorkflowVersion

An immutable canonical API-format workflow snapshot. It stores its logical Workflow and Project IDs,
monotonic version number, name snapshot, canonical JSON, SHA-256, optional note, and timestamps.
Explicitly saving duplicate JSON creates another version.

## WorkflowProfile

A stable Project-scoped logical mapping identity belonging to one Workflow. Editable name,
description, and archive state belong to the logical Profile.

Suggested fields:

```text
id
workflow_id
project_id
name
description
created_at
updated_at
archived_at
```

## WorkflowProfileVersion

An immutable mapping snapshot targeting one exact WorkflowVersion of the Profile's Workflow. It stores
the parent Profile, Workflow, Project, and target WorkflowVersion IDs; a monotonic version number; the
Profile name snapshot; canonical profile JSON; its SHA-256; an optional note; and timestamps. The
canonical JSON has the Run-compatible shape
`{ "id": ..., "name": ..., "mappings": {...}, "image_inputs": [...], "parameters": [...] }`.

Compatibility is version-specific rather than a property of the logical Profile. Listing Profiles for
a target WorkflowVersion therefore retains the logical Profile even when no compatible version exists.
Creating compatibility for a newer WorkflowVersion appends a new validated ProfileVersion under the
same logical Profile; it never retargets an existing version or creates a replacement logical Profile.
The current mapping set requires `prompt`, `seed`, and `output_prefix`. The Profile JSON also requires
an ordered `image_inputs` array, which may be empty. Each image input has exactly `key`, `label`,
`node_id`, and `input_name`. Keys use readable lowercase ASCII snake case, start with a letter, and are
unique within the Profile. The Profile Builder derives a key from the first nonblank label. Later label
edits do not change that key.
The Profile JSON also requires an ordered `parameters` array, which may be empty. Parameter entries
have exactly `key`, `label`, `node_id`, `input_name`, and `value_type`. Parameter keys follow the same
stable-key rules. Supported types are `string`, `integer`, `float`, and `boolean`. Every parameter must
target a compatible literal input. One global uniqueness check covers core mappings, Image Input slots,
and parameters.

Exposed inputs may conceptually resemble:

```json
{
  "mappings": {
    "prompt": {"node_id": "104", "input_name": "text", "value_type": "string"},
    "seed": {"node_id": "114", "input_name": "seed", "value_type": "integer"},
    "output_prefix": {
      "node_id": "301",
      "input_name": "filename_prefix",
      "value_type": "string"
    }
  },
  "image_inputs": [
    {"key": "identity", "label": "Identity", "node_id": "221", "input_name": "image"},
    {"key": "pose", "label": "Pose", "node_id": "225", "input_name": "image"}
  ],
  "parameters": [
    {"key": "cfg", "label": "CFG", "node_id": "114", "input_name": "cfg", "value_type": "float"},
    {"key": "steps", "label": "Steps", "node_id": "114", "input_name": "steps", "value_type": "integer"}
  ]
}
```

Preview and Run creation receive the selected WorkflowVersion and ProfileVersion snapshots directly.
Each Run retains those exact workflow and profile snapshots, so later library edits or SQLite loss do
not alter or invalidate historical provenance.

## Batch

A mutable experiment definition.

Suggested fields:

```text
id
project_id
name
filesystem_key
description
workflow_profile_id
created_at
updated_at
```

A Batch also owns configuration such as:

- an ordered, non-empty collection of selected PromptVersions;
- VariableBindings;
- zero or more ordered named image bindings;
- seed policy;
- exposed workflow parameter values or dimensions;
- no editable output naming configuration; Run creation derives a fixed namespace for each Job.

Changing a Batch does not alter previous Runs.

### Saved Batch aggregate

The Saved Batch aggregate is the SQLite-persisted mutable Batch. Its root `batch` record stores the
stable identity (`id`, `project_id`, `filesystem_key`), editable `name` and `description`, a
monotonic `revision` counter for optimistic-concurrency saves, the seed intent, workflow/profile
selection IDs, creation/update timestamps, and archive state.

Ordered child tables complete the aggregate:

- `batch_prompt_selection` — ordered `prompt_version_id` foreign keys.
- `batch_variable_binding` — ordered embedded canonical bindings carrying `placeholder` and ordered
  executable `values`.
- `batch_image_binding` — ordered unique `slot_key` records.
- `batch_image_binding_value` — ordered Project Asset IDs or JSON-equivalent `null` values for each binding.
- `batch_parameter_binding` — ordered unique stable parameter keys plus `values`/`range` mode,
  independent Base inclusion, and decimal-text Range fields.
- `batch_parameter_binding_value` — ordered typed JSON scalar or `null` Base-workflow alternatives for
  `values` mode only.
- `batch_linked_parameter_set` — ordered stable set keys and editable labels.
- `batch_linked_parameter_set_member` — ordered unique Profile parameter keys for each set.
- `batch_linked_parameter_set_row` — ordered rows with optional labels.
- `batch_linked_parameter_set_value` — one typed JSON scalar or `null` cell per row member.

Saved Batches may be intentionally incomplete: they may have zero prompt selections, zero values for
a variable binding, no workflow/profile selection, and zero image bindings when no Profile is selected
or the selected Profile has no slots. Preview remains the executable specification validator and
rejects a zero-value variable binding required by a selected PromptVersion. An empty string is one
concrete value, not missing data. Saved Batch writes reject exact duplicate values, including duplicate
empty strings. Reads reject malformed arrays and duplicate values rather than normalizing them.

The current `batch_variable_binding` table stores only `batch_id`, `position`, `placeholder`, and
`values_json`. It does not retain Variable List identity, a source revision, or a binding mode.

Image bindings use `{ "slot_key": string, "values": [asset_id | null, ...] }`. Saved Batch writes
persist the exact selected Profile slot set in Profile order. Preview and Run creation require one
binding for every Profile slot but may receive binding records in any order; compilation resolves them
by stable slot key. Every slot has at least one ordered, unique alternative. `null` means Base workflow
and appears first when included. Each slot is an independent Cartesian dimension. Zipped, row-linked,
and collection-link semantics remain unsupported.

Parameter bindings are discriminated editable intent. `values` mode stores
`{ "parameter_key": string, "mode": "values", "values": [scalar | null, ...] }`. Numeric `range` mode
stores `{ "parameter_key": string, "mode": "range", "include_base": boolean,
"range": { "start": string, "end": string, "step": string } }`. Saved Batches preserve exact Range
decimal text rather than replacing it with generated values. Preview and Run creation resolve binding
records by stable key and materialize Range intent once at the backend domain boundary.

A Batch may instead store `linked_parameter_sets`. Each set has a stable key, editable label, at least
two ordered Profile parameter keys, and one or more ordered rows. A row has an optional label and exactly
one concrete typed scalar or `null` value for every member. Independent bindings and linked membership
partition the selected Profile parameters exactly once. A linked member has no persisted independent
binding or inactive Range source of truth. Duplicate complete typed row tuples are invalid.

Editing a Saved Batch increments its `revision`; concurrent conflicting saves fail rather than
silently overwrite. Detached Prompt or Workflow-Profile snapshots must be explicitly imported or
linked before the Saved Batch can be saved.

## VariableBinding

Connects a placeholder name used by one or more selected PromptVersions to values for this Batch.

Conceptual fields:

```text
placeholder
values
```

Zero values are valid draft state. One value, including the empty string, has fixed semantics;
multiple unique values form an ordered Cartesian dimension.

## Run

An execution with immutable plan and provenance after successful Run creation.

Suggested fields:

```text
id
batch_id
run_number
name
description
filesystem_key
status
created_at
started_at
completed_at
run_path
manifest_version
```

`name` and `description` are optional immutable creation-time provenance. `filesystem_key` is the
immutable `NNN-<slug>` directory name derived once from `run_number` and `name`, with `run` as the slug
fallback. The stable `id` remains the true identity. Loading resolves by ID and verifies the directory
name against the persisted filesystem key rather than regenerating it from the display name.

The Run snapshot must include effective copies of:

- Workflow Profile/workflow;
- PromptVersions;
- variable bindings and values;
- ordered named image bindings and selected asset provenance, which may use Base workflow;
- seed policy and resolved seeds;
- exposed workflow parameters;
- a concrete per-Job output prefix derived from Run and Job identity;
- compiled Job list;
- complete editable Linked Parameter Set definitions and rows;
- optional Run name and description plus the immutable filesystem key.

Once Run creation succeeds, these effective values and the compiled Job plan are immutable. This freeze occurs before scheduling begins.

Run execution state is separate from immutable provenance. Status, timestamps, ComfyUI prompt IDs, errors, and Results may advance while execution proceeds.

The `batchcraft.execution` v1 filesystem representation stores this mutable data in `execution.json`; all prerelease execution formats are unsupported. Run states are `created`, `running`, `succeeded`, `failed`, `blocked`, and `cancelled`. `blocked` means automatic progression stopped on unresolved work and is not permission to retry. It covers an unresolved accepted or ambiguous submission and the deliberate local-detach shape identified by `User detached from current Job while remote completion was unconfirmed.` A detached Run retains its current Job ordinal, has no completion timestamp, preserves the current Job's best-known preparation or submission evidence and Results, and leaves every later Job pristine pending. It remains available for a future explicit reconciliation operation. `cancelled` has two valid shapes: a pristine pre-execution discard with diagnostic `discarded_before_start`, or a started Run with diagnostic `stopped_after_current_job`, a succeeded Job prefix, and a non-empty cancelled Job suffix. Frozen provenance remains inspectable in both cases. `succeeded`, `failed`, and `cancelled` are immutable terminal Run states.

SQLite stores durable Run cancellation intent as `(run_id, mode, requested_at)`, with current modes `after_current_job` and `detach`. Both intents may coexist. `detach` takes precedence in the active read model because it ends local waiting immediately, while preserving the earlier soft-stop request as durable history. Intent is not copied into `execution.json`: SQLite is authoritative for the request, while execution v1 is authoritative for the resulting Run and Job outcomes. Losing SQLite request metadata does not prevent reconstructing the detached blocked shape or a completed cancellation outcome from the Run filesystem.

## Job

One completely resolved ComfyUI execution.

Suggested fields:

```text
id
run_id
ordinal
status
resolved_prompt
seed
created_at
submitted_at
started_at
completed_at
comfy_prompt_id
error
```

A Job additionally records:

- the PromptVersion ID that produced it;
- resolved variable name/value pairs;
- ordered `resolved_image_inputs`, one per Profile slot, each carrying a slot key and optional asset;
- resolved workflow parameters;
- concrete output prefix `batchcraft/<run-id>/<job-id>/result`, frozen in manifest v1 and passed unchanged to workflow preparation;
- workflow hash.

The compiler orders Job dimensions as PromptVersion, prompt variables, Profile Image Input slots,
generic parameters, then seeds.
PromptVersion order is the Batch's selected order. Each PromptVersion expands
only the bindings it references, in placeholder first-occurrence order. The rightmost dimension varies
fastest, and each dimension preserves user selection order.

Each named Image Input slot is an independent Batch dimension. The Batch snapshot preserves all
alternatives, while every Job's `resolved_image_inputs` contains one concrete choice per Profile slot.
Each entry records `slot_key` and `asset_id`, where `null` means Base workflow. Frozen Run persistence
adds the Profile's slot label and complete asset provenance.

Each unlinked generic parameter is an independent Batch dimension. A Linked Parameter Set replaces all
of its members with one ordered row dimension at the earliest member's Profile position. Before
compilation, independent Range intent is materialized through exact scaled-integer arithmetic. Every
Job's `resolved_parameters` remains complete and in Profile order. `resolved_parameter_sets` additionally
records the selected set key, frozen label, row ordinal, and optional row label as provenance only.

A Job must never contain unresolved prompt variables.

The execution states are `pending`, `preparing`, `submitting`, `submitted`, `submission_unknown`, `succeeded`, `failed`, and `cancelled`. `submitting` records that a submission attempt began. `submitted` always carries a known ComfyUI prompt ID. `submission_unknown` carries the client correlation ID and available submission diagnostics but never advances automatically; a future explicit reconciliation may move it to `submitted` with a proved prompt ID or to `failed`. `cancelled` applies only to a Job without submission evidence. It means batchcraft deliberately did not submit that Job, not that remote ComfyUI work was interrupted.

## Result

An output artifact associated with a Job.

Suggested fields:

```text
id
job_id
kind
filename
relative_path
sha256
mime_type
artifact_ordinal
producing_node_id
remote_filename
remote_subfolder
remote_type
created_at
```

A Job may produce multiple Results. Local filenames use the Job ordinal and artifact ordinal, for example `000001-01.png`. ComfyUI's remote filename, subfolder, and type remain metadata rather than local filesystem authority.

Each Result also records the ComfyUI output field name, content type when known, byte size, and SHA-256. Result identity is independent per producing node/output descriptor even when remote file metadata is otherwise identical.

## Ratings and Review Metadata

Result review data should not modify immutable Run provenance.

User-generated review metadata may be mutable and stored separately.

Examples:

```text
rating
favorite
rejected
notes
reviewed_at
```

## Identity and Hashing

Use stable UUID-style internal IDs.

Editable display names are not identities. Entities that own filesystem locations also use stable, path-safe filesystem keys. Renaming a display name does not change the filesystem key, move historical Runs, or alter stored references.

Where practical, store content hashes for:

- reference assets;
- workflow snapshots;
- output artifacts.

Hashes provide stronger provenance than filenames.

## Snapshot vs Reference Rule

Mutable library entities may be referenced while editing a Batch.

When creating a Run, batchcraft must snapshot the effective content needed for reproducibility. For Reference Assets, the Run snapshots stable asset identities and hashes while relying on the Project's immutable content-addressed asset store by default.

Historical interpretation must not depend on the current state of a mutable library item.

Reproducibility means preserving a replayable execution specification and provenance. It does not promise byte-identical generated pixels across changes to ComfyUI, models, custom nodes, drivers, or GPU execution.
