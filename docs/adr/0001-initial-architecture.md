# ADR 0001: Initial Application Architecture

- **Status:** Accepted
- **Date:** 2026-08-27

## Context

batchcraft is intended to make repeated ComfyUI experimentation easier when prompts, reference images, seeds, and exposed workflow parameters change frequently.

The initial deployment scenario has two machines:

- batchcraft runs locally on a Mac;
- ComfyUI runs on a Windows workstation with the generation GPU;
- the systems communicate over a trusted local network.

The application needs strong reproducibility, a useful prompt/reference library, application-controlled batching, historical result review, and the ability to rerun old experiments without relying on the original mutable UI state.

ComfyUI already provides the workflow editor and GPU execution environment, so duplicating its node editor inside batchcraft would create unnecessary complexity and a fragile second workflow system.

## Decision

### Application roles

batchcraft will be a separate local-first web application.

ComfyUI remains responsible for:

- workflow construction;
- node validation;
- model/custom-node behavior;
- GPU execution;
- native workflow execution.

batchcraft is responsible for:

- Prompt Templates and versions;
- Variable Lists and bindings;
- reference management;
- Workflow Profiles that map friendly fields to ComfyUI workflow inputs;
- Batch construction;
- deterministic prompt resolution;
- Batch-to-Run compilation;
- application-level scheduling;
- Run/Job provenance;
- local result ingestion;
- result review and rerun workflows.

### Technology direction

The planned application stack is:

- React + TypeScript frontend;
- Python + FastAPI backend;
- SQLite for mutable/searchable application state;
- filesystem artifacts for durable completed Run history;
- HTTP/WebSocket communication from the backend to remote ComfyUI.

Specific supporting libraries may be selected during scaffolding without changing this ADR unless they materially alter the architecture.

### ComfyUI communication boundary

The browser will not communicate directly with ComfyUI.

All ComfyUI communication will pass through the batchcraft backend so uploads, workflow mutation, scheduling, retries, result retrieval, and connection configuration remain centralized.

### Experiment model

A **Batch** is mutable experiment configuration.

Creating a Batch execution produces a **Run**. The Run plan and provenance freeze when successful Run creation completes, before scheduling begins.

Execution status, timestamps, ComfyUI prompt IDs, errors, and Results may advance while the Run executes. These execution-state changes do not alter the frozen plan.

A Run contains explicit **Jobs**. Every Job is fully resolved before scheduling and contains no implicit folder iteration, unresolved prompt placeholders, or random decisions deferred to ComfyUI.

Rerunning creates a new Run.

### Prompt-variable model

Prompt Templates may contain simple named placeholders such as:

```text
A photo of {{animal}} in {{location}}.
```

Values are stored as structured Variable Lists and bound by the Batch.

The placeholder syntax identifies a slot only. It does not encode lists, randomness, weights, or expansion behavior.

Prompt variants are resolved before Batch execution. v1 supports one PromptVersion mapped to one workflow prompt input.

The compiler expands dimensions in this order: PromptVersion, prompt variables, reference bindings, seeds, then parameter sweeps. The rightmost dimension varies fastest, and each dimension preserves user selection order.

### Queue ownership

batchcraft owns the logical application queue.

It will submit a controlled number of Jobs to ComfyUI rather than relying on self-requeueing workflow nodes or flooding the native ComfyUI queue by default.

An ambiguous submission failure, such as a timeout after ComfyUI may have accepted a Job, will be reconciled rather than blindly retried.

### Historical storage

SQLite will provide the searchable application index and mutable state.

Completed Run directories will also contain enough durable data to understand and re-index the Run without SQLite, including an authoritative JSON manifest, the imported base API workflow, and a separate Workflow Profile mapping snapshot.

The filesystem Run is published before SQLite indexes it. Complete filesystem Runs can be re-indexed when SQLite state is lost or incomplete.

Reference Assets are immutable, content-addressed Project data. Runs record stable asset identities and hashes without duplicating every input by default. Asset bytes referenced by historical Runs cannot be physically removed. A future self-contained export may copy those inputs.

A Job may produce multiple Results. Result provenance includes the producing ComfyUI node ID and remote output metadata. Local result names use Job ordinal plus artifact ordinal.

`manifest.json` is authoritative for exact replay. CSV is a human-friendly representation and possible future convenience import, but CSV alone does not guarantee exact replay.

Exact rerun preserves generation inputs, workflow, mappings, references, variables, parameters, seeds, and ordering. It creates new Run and Job IDs, timestamps, ComfyUI prompt IDs, and output namespace.

Reproducibility means preserving a replayable execution specification and provenance. It does not guarantee byte-identical generated pixels.

Stable internal IDs and path-safe filesystem identities remain separate from editable display names. Renaming an entity does not change historical paths or references.

The filesystem artifacts are therefore part of the product contract, not disposable implementation detail.

### First technical milestone

Before production scaffolding is treated as authoritative, a disposable integration spike will validate the real Mac-to-Windows ComfyUI boundary.

The spike must demonstrate connectivity, upload, workflow mutation/submission, execution monitoring, result inspection, and output download.

## Consequences

### Positive

- ComfyUI remains the specialized workflow editor rather than being reimplemented.
- Prompt/reference experiments can continue to evolve independently of workflow construction.
- Runs remain reproducible even while library content changes.
- Application scheduling is isolated from mutable browser/UI state.
- A Mac can provide the management interface while the Windows GPU host remains focused on generation.
- Backend ownership of ComfyUI communication avoids duplicated browser/backend protocol logic.
- Filesystem-backed Run artifacts reduce lock-in to a single SQLite database.

### Negative / tradeoffs

- The system has both database state and filesystem artifacts, so consistency rules must be explicit.
- Workflow Profiles require mapping friendly inputs to ComfyUI node/input identifiers.
- Remote input upload and result retrieval add network/file-handling complexity.
- Immutable Project assets consume storage until no historical Run references them.
- Supporting arbitrary ComfyUI workflows safely requires a constrained mapping layer rather than naive workflow mutation.
- The backend becomes a required component even for a single-user local deployment.

## Alternatives Considered

### Build the batching logic entirely with ComfyUI custom nodes

Rejected as the primary architecture because it couples experiment management to workflow execution, makes mutable/self-requeue behavior harder to reason about, and provides a poor foundation for prompt libraries, reusable Runs, result comparison, and reruns.

Custom nodes may still be used by ordinary user workflows; batchcraft itself should not require them for core orchestration.

### Browser talks directly to ComfyUI

Rejected because it would split protocol behavior between frontend and backend, complicate network configuration and CORS, and make centralized scheduling/result ingestion harder.

### Use only SQLite for historical Runs

Rejected because completed experiments should remain understandable and re-indexable if the application database is lost or rebuilt.

### Store only filesystem artifacts and avoid SQLite

Rejected because prompt libraries, metadata, search, ratings, mutable Batches, queue state, and UI indexing benefit strongly from a local relational store.

### Implement a dynamic-prompt mini-language

Rejected for the initial product. Structured Variable Lists plus simple `{{placeholder}}` references are easier to validate, reuse, inspect, and serialize.

## Follow-up Decisions

Future ADRs may be appropriate for:

- exact frontend scaffolding/build stack;
- exact Python/backend quality toolchain;
- application packaging/distribution;
- multi-ComfyUI scheduling;
- linked/tabular variable sets;
- durable manifest schema changes;
- authentication if batchcraft is ever exposed beyond a trusted local environment.
