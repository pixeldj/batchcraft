# ADR 0005: Named Image Input Slots Pass 2A

- **Status:** Accepted
- **Date:** 2026-08-31
- **Supersedes:** The active single `reference_image` mapping and Reference Asset compiler dimension described before this decision.
- **Superseded in part by:** ADR 0006 for ordered alternatives and independent Cartesian Image Input dimensions, and ADR 0007 for current durable format versions.

## Context

The first image-input model exposed at most one optional `reference_image` mapping and treated selected
Reference Assets as a Batch dimension. That model could not describe workflows with distinct image
roles such as identity, pose, and style. It also tied a workflow target to a hard-coded friendly name
instead of Profile metadata.

The data shape must leave room for later multi-value behavior without adding an image dimension before
its combination semantics are settled.

## Decision

A ProfileVersion contains required core mappings for `prompt`, `seed`, and `output_prefix`, plus an
ordered `image_inputs` array. The array may be empty. Each entry has exactly:

```json
{"key":"identity","label":"Identity","node_id":"221","input_name":"image"}
```

Keys use readable lowercase ASCII snake case, start with a letter, and are unique within the Profile.
The Profile Builder derives a key from the first nonblank label and keeps it stable when the label later
changes. Labels remain editable display text. Profile order controls display, persistence, upload, and
workflow-mutation order.

A Batch, API request, Saved Batch, Batch snapshot, and browser session store ordered image bindings:

```json
{"slot_key":"identity","values":["asset-id"]}
```

In Pass 2A, every Profile slot has exactly one effective binding value. The value is either one Reference
Asset ID or JSON `null`. `null` means "Base workflow": execution does not upload an asset and does not
mutate that slot's mapped workflow input. The `values` array is reserved for Pass 2B and is not an image
dimension in Pass 2A.

The compiler copies all slots into every Job as ordered `resolved_image_inputs`. Image inputs do not
change Job count or Job ordering. The executor walks those inputs in Profile order, skips `null`, uploads
selected assets with deterministic position and slot-key names, and passes the uploaded values to the
ComfyUI adapter. The adapter uses the snapshotted Profile metadata to mutate each target.

Published Runs use manifest v6 and Batch snapshot v3. Browser working sessions use v10. The current
SQLite schema starts from a replacement consolidated `0001_initial.sql` baseline with normalized image
binding and value tables. Existing development databases must be recreated manually. Old Runs and
browser drafts are unsupported. The application does not delete or rewrite them automatically.
`run.json` v1, `execution.json` v2, and `asset.json` v1 do not change.

## Consequences

- One Profile can name and order several independent image roles.
- Renaming a slot label does not break Batch bindings because the key remains stable.
- Every frozen Job records the slot key, frozen label, and selected asset provenance or explicit base-workflow choice.
- A Profile with no image inputs remains valid.
- Image selections do not multiply Jobs in Pass 2A.
- This pre-release format change requires a manual development database recreation and rejects older Runs and drafts.

## Deferred Pass 2B decisions

Pass 2B must define multi-value semantics before allowing more than one effective value per slot. The
current decision does not choose independent Cartesian expansion, row-linked or zipped values, shared
asset-set links, Reference Collection links, or any other relationship between slots. It also does not
define mutable links from a Batch to library collections. A later decision must specify ordering, Job
count, provenance, empty-value behavior, UI authoring, and replay semantics together.

## Alternatives considered

### Keep one optional reference mapping

Rejected because workflows commonly assign different meanings and targets to multiple image inputs.

### Add each slot as an independent Cartesian dimension now

Rejected because it would make Job counts and cross-slot pairing behavior part of the durable contract
without a settled Pass 2B design.

### Use labels as binding identities

Rejected because normal label edits would detach Saved Batch and Run intent.
