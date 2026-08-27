# batchcraft Data Model

## Goal

The data model must support reusable prompts, reusable variable values, reference libraries, reusable ComfyUI workflow mappings, editable experiment definitions, immutable executions, reproducible Jobs, result review, and filesystem-based Run recovery.

This document describes domain semantics rather than a final SQL schema.

## Entity Relationships

```text
Project
 |
 +-- WorkflowProfile
 |
 +-- PromptTemplate
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
slug
description
created_at
updated_at
project_path
```

## PromptTemplate

A stable library identity for a reusable prompt.

Suggested fields:

```text
id
name
description
tags
created_at
updated_at
current_version_id
```

The editable text itself belongs to PromptVersion.

## PromptVersion

An immutable revision of a PromptTemplate.

Suggested fields:

```text
id
prompt_template_id
version_number
text
notes
created_at
```

Example text:

```text
A cinematic photograph of {{subject}} in {{environment}}.
```

Editing a saved prompt creates a new version rather than mutating historical versions.

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
project_id or library_scope
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

A content hash is strongly recommended for identity, deduplication, and manifest provenance.

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

Workflow Profiles should be versioned or snapshotted when used by a Run.

## Batch

A mutable experiment definition.

Suggested fields:

```text
id
project_id
name
description
workflow_profile_id
created_at
updated_at
```

A Batch also owns configuration such as:

- selected PromptVersions;
- VariableBindings;
- reference bindings;
- seed policy;
- exposed workflow parameter values or dimensions;
- output naming configuration.

Changing a Batch does not alter previous Runs.

## VariableBinding

Connects a placeholder name in a PromptVersion to values for this Batch.

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

An immutable execution snapshot.

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
- selected references;
- seed policy and resolved seeds;
- exposed workflow parameters;
- output naming configuration;
- compiled Job list.

Once Run creation succeeds, these effective values are immutable.

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

- resolved variable name/value pairs;
- bound reference assets;
- resolved workflow parameters;
- expected output prefix;
- workflow hash.

A Job must never contain unresolved prompt variables.

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
created_at
```

A Job may produce multiple Results.

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

Where practical, store content hashes for:

- reference assets;
- workflow snapshots;
- output artifacts.

Hashes provide stronger provenance than filenames.

## Snapshot vs Reference Rule

Mutable library entities may be referenced while editing a Batch.

When creating a Run, batchcraft must snapshot the effective content needed for reproducibility.

Historical interpretation must not depend on the current state of a mutable library item.
