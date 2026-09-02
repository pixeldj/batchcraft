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

Structured Batch data decides which ordered values are active and how they are expanded.

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

A Batch binds a placeholder to an ordered list of concrete string values. The bindings apply across the Batch's
ordered PromptVersion selection, while each PromptVersion expands only the placeholders it uses.
Every resulting Job still supplies one resolved prompt string to the Workflow Profile's single
friendly prompt input. Multiple workflow prompt or text inputs are deferred.

Example Prompt Template:

```text
A {{animal}} standing in a {{location}}.
```

Canonical bindings:

```json
[
  {"placeholder": "animal", "values": ["cat", "dog", "bird"]},
  {"placeholder": "location", "values": ["park", "forest"]}
]
```

If:

```text
Animals = [cat, dog, bird]
Outdoor Locations = [park, forest]
```

then the Prompt Resolver produces six variants.

There is no active binding mode or source-list identity in the executable domain. Zero values represent
an incomplete Saved Batch draft, one value has fixed semantics, and multiple values form a Cartesian
dimension. Variable Lists remain an authoring convenience; copying values from one does not retain a
runtime dependency on that list. The empty string is a value, so `[""]` produces one variant with no
inserted text and `["", "foo"]` produces two variants in that order. Exact duplicate values, including
two empty strings, are invalid. Defining the same placeholder binding more than once is also invalid.

## Multiple Variables

Multiple bindings with more than one value form a Cartesian product.

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

Prompt-variable expansion is one part of the complete compiler order. The full dimensional order is
PromptVersion, prompt variables, Profile Image Input slots, generic parameters, then seeds. The
rightmost dimension varies fastest, and all dimensions preserve user selection order. Image Input slots
and generic parameter axes appear in Profile order. Each unlinked parameter is independent; a Linked
Parameter Set contributes one ordered row axis at its earliest member's Profile position.

PromptVersion is the first Batch dimension. PromptVersions preserve user selection order. Within each
PromptVersion, placeholders are resolved independently in that template's first-occurrence order. A
binding used by another selected PromptVersion does not multiply a template that does not reference
it.

## Validation

Before compilation, validate:

### Undefined placeholder

If a Prompt Template references `{{location}}` but no binding exists, compilation fails with a clear error.

### Empty values

Saved Batch drafts may retain a binding with zero values. Preview and Run compilation fail when a
selected PromptVersion uses that binding. An unused zero-value binding remains a warning rather than
preventing otherwise valid Jobs.

The empty string is not the same as zero values. It resolves the placeholder to no text and still
contributes one variant.

### Duplicate values

Every binding must contain unique exact string values. Preview, Run creation, and current Saved Batch
reads and writes reject duplicates, including duplicate empty strings.

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
- copy values from a Variable List into a binding.

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
