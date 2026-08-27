# Batch Compiler

## Purpose

The Batch Compiler converts an editable Batch definition into an immutable Run containing explicit Jobs.

It is the core reproducibility boundary in batchcraft.

## Inputs

A Batch may provide:

- Workflow Profile;
- one or more PromptVersions;
- VariableBindings;
- reference bindings;
- seed policy;
- exposed workflow parameter values;
- output naming configuration.

## Compilation Pipeline

```text
Prompt Template(s)
       +
Variable Bindings
       |
       v
Prompt Resolver
       |
       v
Resolved Prompt Variants
       |
       +---- Reference dimensions
       +---- Seed dimensions
       +---- Workflow parameter dimensions
       |
       v
Expansion
       |
       v
Explicit Job list
       |
       v
Immutable Run snapshot
```

## Fundamental Rule

The output of compilation is explicit.

A Job must not rely on:

- "next image in folder";
- unresolved `{{variable}}` placeholders;
- random selection that occurs later;
- mutable UI state;
- current contents of a Prompt library item;
- a self-requeueing ComfyUI node.

Anything necessary to understand what should execute must be resolved or snapshotted at Run creation.

## Example

Prompt:

```text
A {{animal}} in a park.
```

Variable binding:

```text
animal = [cat, dog, bird]
```

References:

```text
ref01.png
ref02.png
```

Seed:

```text
123456
```

Compilation produces six Jobs:

```text
001 cat   ref01  123456
002 cat   ref02  123456
003 dog   ref01  123456
004 dog   ref02  123456
005 bird  ref01  123456
006 bird  ref02  123456
```

The ordering must be documented and tested.

## Job Count

The Batch Builder must calculate job count before a Run starts.

For independent dimensions:

```text
jobs =
prompt variants
× reference combinations
× seed values
× parameter sweep combinations
```

The UI should prominently display the resulting count.

Large job counts should produce a warning threshold rather than an arbitrary hard limit initially.

## Preview

Before execution, users should be able to preview at least:

- total Job count;
- resolved prompt;
- reference filename or thumbnail;
- seed;
- swept parameters.

The preview must use the same compiler logic as actual Run creation.

Do not maintain separate preview expansion logic that can disagree with execution.

## Seed Policy

Initial useful policies:

### Fixed Seed

Every applicable Job uses one chosen seed.

Useful for controlled comparisons.

### Explicit Seed List

A selected list of seeds becomes another Batch dimension.

Random seed generation may be added later, but random seeds must be generated during Run compilation and stored explicitly before Jobs execute.

## Reference Dimensions

The first version requires one exposed reference-image slot.

The data model should allow future Workflow Profiles with multiple reference slots, such as:

```text
identity_reference
outfit_reference
pose_reference
```

Each binding must define its selected assets and expansion behavior explicitly.

## Parameter Sweeps

Any exposed scalar workflow parameter may eventually become a Batch dimension.

Examples:

- CFG/guidance;
- steps;
- denoise;
- strength;
- model choice.

This should use the same compiler machinery as prompt variables and reference dimensions rather than separate ad hoc loops.

## Run Creation

Creating a Run should conceptually:

1. validate the Batch;
2. snapshot effective source data;
3. resolve prompt variants;
4. expand references, seeds, and parameter dimensions;
5. assign deterministic Job ordinals and IDs;
6. determine output naming;
7. write initial Run/manifest artifacts;
8. persist Run and Job index state;
9. mark the Run ready for scheduling.

A partially compiled Run should not be presented as a valid executable Run.

## Reproducibility

The compiler should be a pure or near-pure domain service wherever possible.

Given the same immutable input snapshot, it should produce the same ordered Job plan.

This logic should receive strong unit-test coverage because it is central to batchcraft's reliability.
