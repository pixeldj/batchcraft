# ADR 0002: Ordered Multi-Prompt Batch Dimension

- **Status:** Accepted
- **Date:** 2026-08-28

## Context

The initial compiler accepted one PromptVersion while reserving PromptVersion as the first dimension
in deterministic Job ordering. Useful experiments need to compare several prompt templates against
the same variables, references, seeds, workflow, and Workflow Profile without manually creating
separate Batches.

A Run must remain understandable without SQLite or mutable Prompt library state. The prior manifest
stored one Run-level PromptVersion and did not associate Jobs with a source PromptVersion, so it could
not represent this dimension unambiguously.

## Decision

A Batch contains an ordered, non-empty collection of PromptVersions. Each PromptVersion has a stable
ID, a human-readable name, and template text. IDs must be unique within the Batch. User order is
preserved and forms the outermost compiler dimension:

```text
PromptVersion -> prompt variables -> reference bindings -> seeds -> parameter sweeps
```

Each PromptVersion is parsed and resolved independently. It expands only the variable bindings it
references, in placeholder first-occurrence order. A binding is globally unused only when no selected
PromptVersion references it, producing one warning rather than one warning per template.

Prompt resolution remains single-pass. Variable values are data and never become nested templates.
If substitution introduces an unresolved placeholder, compilation fails rather than recursively
expanding it. Recursive expansion, cycles, and implicit PromptVersion creation are rejected as
unnecessary language complexity.

Each CompiledJob records its source PromptVersion ID. The immutable Run plan stores the ordered full
PromptVersion snapshots once. Manifest v2 persists those snapshots and each Job association; the
secondary CSV repeats the associated ID, name, and template per row for inspection. The loader
continues reading manifest v1 explicitly as one PromptVersion and does not rewrite historical Runs.

The API accepts only plural `prompt_versions`. Preview returns PromptVersion ID and name per Job.
Workflow Profile semantics do not change: every Job still injects one resolved prompt string into the
single friendly prompt mapping.

## Consequences

### Positive

- Prompt comparisons share one deterministic Batch and one frozen Run plan.
- Job ordering remains stable because the previously reserved first dimension is now populated.
- Historical Jobs identify exact PromptVersion snapshots without mutable library lookups.
- Prompt-specific placeholder sets avoid duplicate Jobs caused by irrelevant bindings.
- Existing manifest v1 Runs remain readable.

### Negative / tradeoffs

- Job counts can grow substantially with each selected PromptVersion.
- PromptVersion names become generation provenance and must be snapshotted.
- The Run manifest requires a new version and a maintained legacy parser.
- A binding used by only some prompts produces no per-prompt warning; this favors concise global
  warnings over exhaustive diagnostics.

## Alternatives Considered

### Store prompts as values of a `{{prompt}}` variable

Rejected because it erases PromptVersion identity, encourages recursive template expansion, and makes
historical provenance ambiguous.

### Expand every binding across every PromptVersion

Rejected because bindings unused by a template would create duplicate resolved prompts and surprising
Job counts.

### Add multiple Workflow Profile prompt mappings

Rejected as a separate feature. Multi-prompt batching changes the source template dimension, not the
number of independent prompt inputs in a workflow.
