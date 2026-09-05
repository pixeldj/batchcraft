# ADR 0011: Linked Parameter Sets / Presets

- **Status:** Accepted
- **Date:** 2026-09-02
- **Supersedes in part:** ADR 0008's rule that every Profile parameter is an independent Batch dimension, ADR 0009's exact one-binding-per-parameter persistence shape, Batch snapshot v5, browser working-session recovery v1, and the prior consolidated SQLite baseline.

## Context

Current persistence versions and forward-only user-database policy supersede the historical baseline
replacement below; see `../FILE_FORMAT.md` and `../DEVELOPMENT.md#persistence-policy`.

Independent parameter alternatives are correct for ordinary sweeps but wrong for values that form named
tuples. Width and Height presets illustrate the problem: three intended resolution rows currently become
nine combinations. Zipping separate `values` arrays by position would hide the relationship, make row
labels awkward, and leave two competing editable sources of truth.

Workflow Profiles already define individual typed writable parameters and exact ComfyUI targets. The
choice to couple those parameters belongs to one mutable Batch experiment, not to the reusable Profile.

## Decision

A Batch may contain ordered Linked Parameter Sets, presented to users as Presets. Each set stores:

- a stable machine key and editable label;
- at least two ordered Profile parameter keys;
- one or more ordered rows;
- an optional row label;
- exactly one typed scalar or JSON `null` value for every member in every row.

`null` retains its existing per-parameter meaning: use the Base workflow value and do not send an
override to ComfyUI. Empty string, zero, and false remain concrete overrides.

Independent parameter bindings and linked membership partition the selected Profile parameters exactly
once. A parameter may belong to at most one set and may not retain an active Values or Range binding
while linked. Linked row cells contain concrete values only; they do not contain Range intent.

One linked row is one value of one compiler dimension. The compiler scans parameters in Profile order.
A linked set occupies the position of its earliest member, and the compiler skips its remaining members
as independent dimensions. Request ordering of sets or bindings does not affect compilation. Row order
is authoritative, and the rightmost dimension continues to vary fastest.

Every compiled Job still contains the complete ordered scalar/Base `resolved_parameters` list in Profile
order. A small `resolved_parameter_sets` provenance list records each selected set key, frozen label, row
ordinal, and optional row label. This provenance does not drive workflow preparation. The executor and
ComfyUI adapter continue to receive scalar overrides only.

Batch snapshot v6 freezes both independent editable intent and complete linked-set rows. Manifest v9 and
its CSV add resolved-set row provenance while retaining scalar resolved parameters. `run.json` v2 and
execution v3 do not change. Browser working-session recovery v2 stores linked draft state. The
consolidated pre-release SQLite baseline adds normalized set, member, row, and value tables.

## Consequences

- Three Resolution rows produce three parameter variants rather than a Width by Height product.
- Independent Values and Range behavior remains unchanged for unlinked parameters.
- Historical Runs retain both editable linked rows and the row selected for each Job.
- Duplicate complete row tuples are rejected even when their labels differ.
- Existing development databases, snapshot-v5/manifest-v8 Runs, and browser recovery v1 drafts are
  unsupported. batchcraft fails closed and never migrates, rewrites, renames, or deletes them
  automatically.

## Deferred

Ranges inside linked rows, row generators, random row selection, dependent expressions, linked Image
Inputs, LoRA-specific behavior, video-specific behavior, enum/model discovery, and `/object_info` remain
deferred.
