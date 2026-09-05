# batchcraft Product Definition

## Purpose

**batchcraft** is a local-first experiment and batch orchestration application for ComfyUI.

ComfyUI remains the workflow editor and generation engine. batchcraft sits above it and makes repeated experimentation easier by managing:

- reusable prompt templates;
- reusable prompt variables and value lists;
- image Reference Asset libraries and collections;
- imported ComfyUI workflow profiles;
- batch construction and expansion;
- application-controlled job queueing;
- reproducible run manifests;
- result collection, comparison, rating, and reruns.

The primary use case is a user who frequently changes prompts, reference images, seeds, or other exposed workflow parameters and wants to run controlled experiments without manually rebuilding or repeatedly queueing workflows in ComfyUI.

## Product Principles

### ComfyUI remains ComfyUI

batchcraft is **not** a replacement for ComfyUI's node editor.

Users create and debug workflows in ComfyUI. batchcraft imports an API-format workflow and exposes only the inputs that matter for experimentation.

Typical exposed inputs include:

- one mapped prompt input receiving each Job's resolved prompt;
- zero or more named image inputs;
- seed;
- steps;
- guidance;
- output prefix.

### Experiments are compiled before execution

A Batch is resolved into explicit Jobs before any Job is submitted to ComfyUI.

No unresolved prompt variables, random choices, or implicit iteration should remain in a submitted Job.

### Run plans are immutable

A **Batch** is an editable experiment definition.

A **Run** is created from a compiled Batch. Its plan and provenance freeze when successful Run creation completes, before scheduling begins.

Execution state remains mutable while the Run executes. Status, timestamps, ComfyUI prompt IDs, errors, and Results may advance without changing the frozen plan.

Changing a prompt, Reference Collection, Variable List, Workflow Profile, image binding, or parameter after Run creation must not alter that Run plan.

Rerunning an experiment creates a new Run.

### Completed Runs are recoverable

A completed Run must remain understandable and re-indexable from its filesystem artifacts even if the batchcraft SQLite database is lost.

SQLite is an index and application state store, not the only source of historical truth.

Reference Assets live in the Project's immutable content-addressed asset store. A Run records the selected asset identities and hashes. Exact replay requires those assets to remain in the Project unless a later self-contained export copies them into the exported Run.

### batchcraft owns orchestration

batchcraft owns the logical queue and decides when work is submitted to ComfyUI.

Core batch behavior should not depend on self-requeueing ComfyUI nodes.

This lets users safely edit future work while a frozen Run plan continues executing in the background of the application.

## Core User Concepts

### Project

A workspace containing related experiments, references, batches, runs, and results.

Examples:

- `pomeranian-cartoon-tests`
- `krea-character-identity`
- `outfit-transfer-testing`

### Workflow Profile

An imported ComfyUI API workflow plus a mapping between friendly batchcraft inputs and specific workflow node inputs.

Example:

```text
prompt                  -> node 104 / text
seed                    -> node 114 / seed
output_prefix           -> node 309 / filename_prefix
Image Input "Identity"  -> node 221 / image
Image Input "Pose"      -> node 225 / image
```

The three core mappings are required. A ProfileVersion also has an ordered `image_inputs` array, which
may be empty. Each named slot has a stable key, editable label, and exact workflow target. Slot keys are
lowercase readable snake case, start with a letter, and do not change when labels are edited.

### Prompt Template

Reusable prompt text that may contain named placeholders.

Example:

```text
A cinematic photograph of {{subject}} walking through {{environment}},
shot with a {{lens}} lens.
```

Prompt Templates are versioned so historical Runs can identify the exact prompt revision used.

### Variable List

A named, reusable ordered list of authoring values.

Example:

```text
Animals
- cat
- dog
- bird
```

The Prompt Template references `{{animal}}`; a Batch may copy `cat`, `dog`, and `bird` from the
`Animals` Variable List into that placeholder's binding. The binding retains the ordered values, not
the Variable List identity.

### Reference Asset

An input file, initially an image, that can be supplied to an exposed workflow input.

Reference Assets may be grouped into reusable Reference Collections.

Once stored, asset bytes are immutable and identified by a content hash. Removing an asset from a collection or library view does not physically remove bytes still referenced by a historical Run.

### Batch

An editable experiment definition combining:

- a Workflow Profile;
- an ordered non-empty selection of PromptVersions;
- Variable bindings;
- ordered Image Input bindings chosen from Reference Assets or Base workflow;
- seed policy;
- exposed workflow parameters;
- output configuration.

A Batch can be previewed before execution.

### Run

An execution whose compiled plan and provenance freeze at successful Run creation.

A Run records exactly what was selected and contains an explicit list of Jobs. The Job plan is immutable after successful Run creation; execution state advances separately.

### Job

One completely resolved ComfyUI execution.

A Job contains no unresolved prompt placeholders or implicit iteration.

Example:

```text
Prompt:    A cinematic photograph of a dog walking through a forest.
Identity:  person-03.png
Pose:      Base workflow
Seed:      123456
Steps:     20
```

In Named Image Input Slots Pass 2B, each Profile slot contains one or more ordered Reference Asset or
Base workflow alternatives and forms an independent Cartesian compiler dimension. Every Job still
contains one concrete resolved value per slot. Zipped, row-linked, and collection-link semantics remain
deferred.

At the Batch level, users may group two or more scalar Workflow Profile parameters into a named Preset.
Each ordered row keeps those values together as one compiler choice. For example, Landscape, Portrait,
and Square Width/Height rows produce three variants, not a Width by Height product. Jobs remain fully
resolved to ordinary scalar or Base workflow values before execution.

### Result

A single output artifact associated with a Job. A Job may produce multiple Results.

Initially, Results are primarily generated images downloaded from ComfyUI to the batchcraft project directory.

## Prompt Variables

Prompt variables are deliberately simple.

A Prompt Template may contain:

```text
{{animal}}
{{location}}
{{lens}}
```

The placeholder syntax identifies a named slot only. It does not encode values or expansion behavior.

A Batch binds each placeholder to an ordered list of concrete string values. Variable Lists may supply
those values during authoring, but the binding itself has only `placeholder` and `values`.

One value contributes one variant. Multiple values contribute an ordered Cartesian dimension, and
multiple bindings create a Cartesian product.

Example:

```text
animal   = [cat, dog, bird]
location = [park, forest]
```

creates six resolved prompt variants.

Deterministic sampling, weighted values, and row-linked prompt variables remain deferred. Named Image
Input slots form separate independent dimensions after prompt-variable expansion.

## Result Review

A Run should be reviewable as a visual grid.

Result review uses current-Run Results and Project History, without a separate Batch Results session
gallery. Thumbnail cards omit visible `Verified` badges and `Job` captions; the info popup retains that
metadata. Accessible descriptions, lightbox labels, integrity checks, and unavailable-artifact
placeholders remain.

The Results Viewer should eventually support:

- thumbnail grid;
- result-to-reference comparison;
- full resolved prompt and variable values;
- workflow/profile/version metadata;
- seed and parameter display;
- ratings or favorites;
- filtering;
- selecting results;
- creating a new Batch from selected winners;
- rerunning selected or failed Jobs.

The Results Viewer is a first-class product feature.

## Reruns

A Run may be rerun from batchcraft or re-imported from its authoritative JSON manifest and related Run/Project artifacts.

A Run may have an optional creation name and notes. Both are frozen as provenance. Its directory uses
the immutable human-readable form `NNN-<slug>`, falling back to `NNN-run` when unnamed. The interface
uses the Run name where useful while retaining the Run number as secondary chronological context.

A rerun creates a new incremented Run directory and never overwrites the original.

Potential rerun scopes include:

- exact Run;
- failed Jobs only;
- selected Jobs;
- selected Jobs with new seeds;
- selected Jobs with modified parameters.

Exact replay preserves generation inputs, the base workflow, Workflow Profile core mappings and named
Image Input metadata, selected Reference Assets, variables, parameters, seeds, and Job ordering. It
allocates new Run and Job IDs, timestamps, ComfyUI prompt IDs, and output namespace.

Only exact Run replay is required initially.

## Reproducibility Scope

batchcraft preserves a replayable execution specification and the provenance needed to understand what ran. It does not guarantee byte-identical generated pixels after ComfyUI, models, custom nodes, drivers, or GPU behavior change.

## Initial Vertical Slice

The first useful version should prove this complete path:

1. Connect to a remote ComfyUI instance.
2. Import an API-format workflow.
3. Map prompt, seed, output prefix, and zero or more named image inputs.
4. Enter a Prompt Template.
5. Bind ordered values to one placeholder.
6. Choose ordered Reference Asset and Base workflow alternatives for each named Image Input slot.
7. Preview the compiled Job matrix.
8. Create a Run with a frozen plan.
9. Execute Jobs through the batchcraft-owned queue.
10. Download outputs to the Mac.
11. Save JSON and CSV manifests.
12. Display a basic Results grid.

## Explicit Non-Goals for the Initial Product

Do not initially build:

- a ComfyUI node/workflow editor;
- multi-user accounts or authentication;
- cloud synchronization;
- distributed execution across many ComfyUI servers;
- nested prompt expression languages;
- arbitrary scripting inside prompts;
- AI-generated prompt optimization;
- plugin marketplaces;
- complex scheduling;
- video-specific review tooling.

The architecture may leave room for some of these, but they should not complicate the first vertical slice.
