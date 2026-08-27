# ComfyUI Integration

## Purpose

batchcraft treats ComfyUI as a remote execution engine.

The initial target is a ComfyUI instance running on a Windows workstation while batchcraft runs on a Mac on the same trusted LAN.

## Boundary

All ComfyUI communication occurs through the batchcraft backend.

The browser frontend must not communicate directly with ComfyUI.

This centralizes:

- connection configuration;
- input uploads;
- workflow mutation;
- queue submission;
- WebSocket monitoring;
- history inspection;
- output retrieval;
- retries and error handling.

## Expected ComfyUI Operations

The integration layer should support the equivalent of:

1. verify connectivity;
2. upload an input image when needed;
3. mutate a known API-format workflow using a Workflow Profile mapping;
4. submit the workflow to ComfyUI;
5. capture the returned prompt ID;
6. monitor execution status;
7. inspect execution history/results;
8. retrieve generated output files;
9. save outputs into the batchcraft Run directory.

The exact HTTP and WebSocket implementation should be isolated inside the ComfyUI client package.

## Workflow Profiles

batchcraft does not attempt to infer arbitrary workflow intent on every execution.

Instead, users import an API-format workflow and configure friendly exposed inputs once.

Example:

```text
Friendly input: prompt
Node ID:        104
Node input:     text
Type:           string
```

The Workflow Profile becomes the stable mapping used by Jobs. v1 exposes one mapped prompt input; support for multiple workflow prompt or text slots is deferred.

## Workflow Snapshotting

A Run preserves `workflow.json` as the imported base API workflow snapshot, along with a content hash. It also preserves a separate Workflow Profile mapping snapshot. Per-Job resolved friendly values remain in `manifest.json`.

If a user later edits or replaces the Workflow Profile, historical Runs remain interpretable and reproducible.

## Input Images

Reference images are owned by batchcraft on the Mac. Their bytes are immutable in the Project's content-addressed asset store.

Before execution, the ComfyUI integration uploads any required input asset to the remote ComfyUI instance and then rewrites the workflow input to the uploaded ComfyUI-visible filename/path expected by the node.

The Job manifest retains the batchcraft asset identity and hash rather than treating the temporary ComfyUI filename as authoritative provenance. A Run does not duplicate each input asset by default, and the application cannot physically remove Project asset content referenced by a historical Run.

## Output Images

ComfyUI may create its normal native output files on the Windows workstation.

After a Job succeeds, batchcraft retrieves every relevant output and stores application-owned copies under the Run directory on the Mac. One Job may produce multiple Results.

Each Result records its producing ComfyUI node ID and the remote filename, subfolder, and type reported by ComfyUI. Local filenames use the Job ordinal plus artifact ordinal, such as `000001-01.png`.

The Mac-side Run directory is the durable batchcraft archive.

## Job Submission

For each Job, the integration layer receives:

- workflow snapshot/profile;
- resolved prompt values;
- uploaded reference mappings;
- seed;
- resolved workflow parameters;
- output prefix.

It produces a concrete ComfyUI API workflow and submits it.

The returned ComfyUI prompt ID must be stored on the Job.

### Ambiguous submission outcomes

A timeout, disconnect, or malformed response during submission does not prove that ComfyUI rejected the workflow. The integration layer must report an ambiguous outcome to the scheduler and preserve all available request and correlation data.

The scheduler must reconcile an ambiguous outcome through available prompt IDs, queue state, history, and output metadata. It must not blindly retry the submission. A new submission is allowed only after reconciliation shows that ComfyUI did not accept the prior attempt or after explicit user action creates a new attempt under defined semantics.

## Execution Monitoring

Use ComfyUI's real-time execution events where practical, with history/status queries available for reconciliation.

batchcraft should not assume that a WebSocket connection is perfectly reliable forever.

The domain model should permit a later reconciliation mechanism after transient disconnects or backend restarts.

## Error Handling

Failures should preserve useful information.

At minimum record:

- Job ID;
- ComfyUI prompt ID when available;
- failure stage;
- user-readable error summary;
- raw diagnostic detail where appropriate;
- timestamps.

A failed Job remains part of the immutable Run plan and may later be selected for rerun into a new Run.

Runtime status, timestamps, ComfyUI IDs, errors, and Results are mutable execution state. Their updates do not change the Job's frozen generation inputs or Run provenance.

## Reproducibility Scope

The integration records a replayable execution specification and provenance. ComfyUI versions, model files, custom nodes, drivers, and GPU behavior may change generated bytes, so batchcraft does not guarantee byte-identical pixels.

## Connectivity Configuration

Initial configuration can be simple:

```text
Name: Main PC
Base URL: http://<windows-host>:8188
```

A connection test should report useful status such as:

- reachable/unreachable;
- ComfyUI responding;
- queue status if available;
- version/system information if useful.

## LAN Security Assumption

The first version assumes a trusted LAN.

ComfyUI should be exposed only as broadly as needed, and the Windows Firewall rule should ideally limit access to the trusted LAN or Mac host.

Do not expose an unauthenticated ComfyUI API directly to the public Internet as part of the default architecture.

## Initial Integration Spike

Before building the full application, create a disposable integration spike that proves:

```text
Mac
 |
 +-- connect to ComfyUI
 +-- upload image
 +-- load known API workflow fixture
 +-- modify prompt/reference/seed/output prefix
 +-- submit
 +-- observe completion
 +-- inspect results/history
 +-- download output to Mac
```

Suggested acceptance criteria:

1. It runs from the Mac using Python.
2. It talks to the real Windows ComfyUI instance over the LAN.
3. It uploads a known image successfully.
4. It submits one known workflow fixture.
5. It captures the ComfyUI prompt ID.
6. It detects success or failure.
7. It downloads at least one generated image.
8. The downloaded image is saved locally on the Mac.
9. No manual action in the ComfyUI UI is required after starting the spike.

This spike should validate the API assumptions before the full frontend/backend application is scaffolded.
