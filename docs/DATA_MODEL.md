# batchcraft Data Model

## Goal

The data model must support reusable prompts, reusable variable values, reference libraries, reusable ComfyUI workflow mappings, editable experiment definitions, frozen Run plans, advancing execution state, reproducible Jobs, result review, and filesystem-based Run recovery.

This document describes domain semantics rather than a final SQL schema.

## Entity Relationships

```text
Project
 |
 +-- WorkflowProfile
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

Important distinction:

**VariableList stores values. It does not define execution mode.**

Whether a Batch uses all values, one fixed value, or a future sampling policy belongs to the Batch's VariableBinding.

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

## WorkflowProfile

A ComfyUI API workflow plus friendly exposed input mappings.

Suggested fields:

```text
id
name
description
workflow_version
workflow_json
workflow_hash
mapping_definition
created_at
updated_at
```

Exposed inputs may conceptually resemble:

```json
{
  "prompt": {
    "node_id": "104",
    "input_name": "text",
    "value_type": "string"
  },
  "reference_image": {
    "node_id": "221",
    "input_name": "image",
    "value_type": "image"
  },
  "seed": {
    "node_id": "114",
    "input_name": "seed",
    "value_type": "integer"
  }
}
```

Workflow Profiles should be versioned or snapshotted when used by a Run. Each Run retains the imported base workflow snapshot and a separate mapping snapshot.

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
- zero or more ordered reference bindings;
- seed policy;
- exposed workflow parameter values or dimensions;
- output naming configuration.

Changing a Batch does not alter previous Runs.

## VariableBinding

Connects a placeholder name used by one or more selected PromptVersions to values for this Batch.

Conceptual fields:

```text
placeholder
source_variable_list_id
mode
selected_values
fixed_value
```

Initial modes:

```text
all
fixed
```

## Run

An execution with immutable plan and provenance after successful Run creation.

Suggested fields:

```text
id
batch_id
run_number
status
created_at
started_at
completed_at
run_path
manifest_version
```

The Run snapshot must include effective copies of:

- Workflow Profile/workflow;
- PromptVersions;
- variable bindings and values;
- selected references, which may be empty;
- seed policy and resolved seeds;
- exposed workflow parameters;
- output naming configuration;
- compiled Job list.

Once Run creation succeeds, these effective values and the compiled Job plan are immutable. This freeze occurs before scheduling begins.

Run execution state is separate from immutable provenance. Status, timestamps, ComfyUI prompt IDs, errors, and Results may advance while execution proceeds.

The v1 filesystem representation stores this mutable data in `execution.json`. Run states are `created`, `running`, `succeeded`, `failed`, and `blocked`. `blocked` means automatic progression stopped on an unresolved accepted or ambiguous submission and is not permission to retry. It remains available for a future explicit reconciliation operation; only `succeeded` and `failed` are immutable terminal Run states.

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
- an optional bound Reference Asset;
- resolved workflow parameters;
- expected output prefix;
- workflow hash.

The compiler orders Job dimensions as PromptVersion, prompt variables, reference bindings, seeds,
then parameter sweeps. PromptVersion order is the Batch's selected order. Each PromptVersion expands
only the bindings it references, in placeholder first-occurrence order. The rightmost dimension varies
fastest, and each dimension preserves user selection order.

The empty reference dimension has one identity value. It therefore does not reduce the Job count;
the compiled Job records no Reference Asset, and execution preserves the mapped reference-image value
from the base workflow.

A Job must never contain unresolved prompt variables.

The v1 execution states are `pending`, `preparing`, `submitting`, `submitted`, `submission_unknown`, `succeeded`, and `failed`. `submitting` records that a submission attempt began. `submitted` always carries a known ComfyUI prompt ID. `submission_unknown` carries the client correlation ID and available submission diagnostics but never advances automatically; a future explicit reconciliation may move it to `submitted` with a proved prompt ID or to `failed`.

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
