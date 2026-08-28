# Prompt Templates and Variables

## Purpose

batchcraft supports reusable Prompt Templates with structured variables.

The system intentionally avoids an embedded dynamic-prompt language such as:

```text
A photo of a {cat|dog|bird}.
```

Instead, prompt text contains named placeholders:

```text
A photo of {{animal}} in {{location}}.
```

Values and expansion behavior are stored as structured application data.

## Design Goals

The variable system should be:

- easy to understand in the UI;
- deterministic by default;
- reusable across prompts;
- easy to validate;
- fully inspectable before execution;
- reproducible in saved manifests;
- simple enough that prompts remain readable outside batchcraft.

## Placeholder Syntax

A placeholder is:

```text
{{variable_name}}
```

Recommended identifier form:

```text
[A-Za-z_][A-Za-z0-9_]*
```

Examples:

```text
{{animal}}
{{location}}
{{lens}}
{{camera_angle}}
```

Placeholder names are case-sensitive in the initial implementation.

## What the Syntax Does Not Do

The placeholder contains no list values or behavior.

Do not encode:

```text
{{cat|dog|bird}}
{{animal:random}}
{{animal*3}}
```

The prompt text identifies a slot only.

Structured Batch data decides what values are available and how they are expanded.

## Variable Lists

A Variable List is a reusable ordered collection.

Example:

```text
Name: Animals
Values:
- cat
- dog
- bird
```

Another:

```text
Name: Portrait Lenses
Values:
- 35mm
- 50mm
- 85mm
```

The same Variable List may be used by many Prompt Templates.

## Variable Binding

A Batch binds a placeholder to a list or explicit values. The bindings apply across the Batch's
ordered PromptVersion selection, while each PromptVersion expands only the placeholders it uses.
Every resulting Job still supplies one resolved prompt string to the Workflow Profile's single
friendly prompt input. Multiple workflow prompt or text inputs are deferred.

Example Prompt Template:

```text
A {{animal}} standing in a {{location}}.
```

Bindings:

```text
animal:
  source: Animals
  mode: all

location:
  source: Outdoor Locations
  mode: all
```

If:

```text
Animals = [cat, dog, bird]
Outdoor Locations = [park, forest]
```

then the Prompt Resolver produces six variants.

## Initial Binding Modes

### `all`

Use each selected value.

### `fixed`

Use one selected value.

These two modes are enough for the first implementation.

Selected or fixed values must exist in the bound Variable List. An `all` binding stores its selected values in user order. A `fixed` binding stores exactly one fixed value. Defining the same placeholder binding more than once is a validation error.

## Multiple Variables

Multiple `all` bindings form a Cartesian product.

Example:

```text
animal   = [cat, dog]
location = [park, forest]
lighting = [sunrise, sunset]
```

produces:

```text
2 × 2 × 2 = 8 prompt variants
```

The UI must show this expansion count before Run creation.

## Deterministic Ordering

Expansion ordering must be deterministic.

Rule:

1. placeholders are considered in first-occurrence order in the Prompt Template;
2. values are considered in their stored or selected order;
3. Cartesian expansion preserves those orders.

This keeps previews, manifests, comparisons, and tests stable.

Prompt-variable expansion is one part of the complete compiler order. The full order is PromptVersion, prompt variables, reference bindings, seeds, then parameter sweeps. The rightmost dimension varies fastest, and all dimensions preserve user selection order.

PromptVersion is the first Batch dimension. PromptVersions preserve user selection order. Within each
PromptVersion, placeholders are resolved independently in that template's first-occurrence order. A
binding used by another selected PromptVersion does not multiply a template that does not reference
it.

## Validation

Before compilation, validate:

### Undefined placeholder

If a Prompt Template references `{{location}}` but no binding exists, compilation fails with a clear error.

### Empty values

If an `all` binding has no selected values, compilation fails.

### Unused bindings

If a Batch defines a binding that none of its selected PromptVersions reference, report one warning
rather than a fatal error. A binding used by at least one selected PromptVersion is globally used and
does not produce warnings for the other templates.

### Malformed placeholder

Malformed placeholder syntax should produce a clear validation error rather than be silently modified.

## Repeated Placeholders

A placeholder used multiple times in one Prompt Template resolves to the same value within a prompt variant.

Example:

```text
A {{animal}} looking at another {{animal}}.
```

with `animal = dog` resolves to:

```text
A dog looking at another dog.
```

It does not independently expand each occurrence.

## No Recursive Expansion

Each PromptVersion receives exactly one substitution pass. Variable values are data, not nested Prompt
Templates. If a value inserts text such as `portrait of {{subject}}`, batchcraft does not perform a
second pass to resolve `{{subject}}`. The resulting unresolved placeholder is rejected before a Job
can reach ComfyUI; there is no recursive expansion, implicit PromptVersion creation, or cycle
detection.

## Manifest Provenance

Each Job should preserve three concepts:

```json
{
  "prompt_template": "A {{animal}} in {{location}}.",
  "resolved_variables": {
    "animal": "dog",
    "location": "forest"
  },
  "resolved_prompt": "A dog in forest."
}
```

The exact stored format may evolve, but the template, resolved variable values, and final prompt must all remain available.

## UI Ideas

The prompt editor should minimize manual placeholder syntax.

Useful interactions include:

- Insert Variable at cursor;
- select text and Convert to Variable;
- autocomplete known variable names after typing `{{`;
- visually distinguish placeholders;
- show unresolved-variable errors inline;
- show unused bindings;
- show expansion preview/count;
- open the bound Variable List directly from the prompt editor.

## Deferred Features

Do not implement these initially:

- nested expressions;
- conditional expressions;
- weighted values;
- inline JavaScript or Python;
- arbitrary functions;
- random evaluation at ComfyUI execution time;
- zipped or row-linked variables;
- dependencies between variables.

Possible future additions include deterministic sampling, weighted sampling, and Variable Sets with paired rows.
