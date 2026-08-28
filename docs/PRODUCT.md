# batchcraft Product Definition

## Purpose

**batchcraft** is a local-first experiment and batch orchestration application for ComfyUI.

ComfyUI remains the workflow editor and generation engine. batchcraft sits above it and makes repeated experimentation easier by managing:

- reusable prompt templates;
- reusable prompt variables and value lists;
- reference image libraries and collections;
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
- reference image(s);
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

Changing a prompt, reference collection, Variable List, Workflow Profile, or parameter after Run creation must not alter that Run plan.

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
prompt          -> node 104 / text
reference_image -> node 221 / image
seed            -> node 114 / seed
save_prefix     -> node 309 / filename_prefix
```

### Prompt Template

Reusable prompt text that may contain named placeholders.

Example:

```text
A cinematic photograph of {{subject}} walking through {{environment}},
shot with a {{lens}} lens.
```

Prompt Templates are versioned so historical Runs can identify the exact prompt revision used.

### Variable List

A named, reusable ordered list of values that can be bound to a prompt placeholder.

Example:

```text
Animals
- cat
- dog
- bird
```

The Prompt Template references `{{animal}}`; a Batch may bind that placeholder to the `Animals` Variable List.

Variable Lists contain data. The Batch controls how that data is used.

### Reference Asset

An input file, initially an image, that can be supplied to an exposed workflow input.

Reference Assets may be grouped into reusable Reference Collections.

Once stored, asset bytes are immutable and identified by a content hash. Removing an asset from a collection or library view does not physically remove bytes still referenced by a historical Run.

### Batch

An editable experiment definition combining:

- a Workflow Profile;
- an ordered non-empty selection of PromptVersions;
- Variable bindings;
- Reference Assets or Collections;
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
Reference: ref-03.png
Seed:      123456
Steps:     20
```

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

Values live in structured Variable Lists, and the Batch decides how each placeholder is bound.

Initial binding modes:

- **All values** — expand once for each selected value.
- **Fixed value** — use one selected value.

Multiple All-value bindings create a Cartesian product.

Example:

```text
animal   = [cat, dog, bird]
location = [park, forest]
```

creates six resolved prompt variants.

Future modes may include deterministic sampling, weighted values, or row-linked variables.

## Result Review

A Run should be reviewable as a visual grid.

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

A rerun creates a new incremented Run directory and never overwrites the original.

Potential rerun scopes include:

- exact Run;
- failed Jobs only;
- selected Jobs;
- selected Jobs with new seeds;
- selected Jobs with modified parameters.

Exact replay preserves generation inputs, the base workflow and Workflow Profile mapping, references, variables, parameters, seeds, and Job ordering. It allocates new Run and Job IDs, timestamps, ComfyUI prompt IDs, and output namespace.

Only exact Run replay is required initially.

## Reproducibility Scope

batchcraft preserves a replayable execution specification and the provenance needed to understand what ran. It does not guarantee byte-identical generated pixels after ComfyUI, models, custom nodes, drivers, or GPU behavior change.

## Initial Vertical Slice

The first useful version should prove this complete path:

1. Connect to a remote ComfyUI instance.
2. Import an API-format workflow.
3. Map prompt, one reference image, seed, and save prefix.
4. Enter a Prompt Template.
5. Bind one Variable List.
6. Select multiple reference images.
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
