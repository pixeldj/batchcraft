# batchcraft v1.0.0

The first source-only macOS release of batchcraft, a local-first experiment and batch
orchestration application for ComfyUI. ComfyUI remains the workflow editor and generation engine.

## Included

- Project-scoped Prompt Templates, Variable Lists, Workflow Profiles, and Reference Assets.
- Saved Batches with named Image Inputs, typed Workflow Parameters, numeric Ranges, and Linked Parameter Sets.
- Deterministic Preview and frozen Run plans, including stored Random seed assignments.
- Sequential Job execution, Stop-after-current, current Results, and automatically refreshed Project History.
- Copied-Project import, filesystem-backed history recovery, and Load Run as Batch with explicit resource relinking/import.
- Request and expansion budgets, bounded ComfyUI responses, and verified Result downloads.

## Installation

Follow [Install From Source (macOS)](https://github.com/pixeldj/batchcraft/tree/v1.0.0#install-from-source-macos)
and select `--revision v1.0.0`. Git, uv with Python 3.13 or newer, and a supported Node.js/npm version
are required. ComfyUI, custom nodes, and models must be installed separately.

This release distributes source, not a standalone application bundle or prebuilt runtime.
Retain the source clone: the installed app is a pinned Git worktree that depends on its Git metadata.
Do not overwrite an existing installation or data root. Stop active work and make a consistent backup
before deliberately updating an everyday installation.

## Validation

Release commit: `ed601f626f2d6d81f24f7d40584e35588c0f3303`.

The owner accepted clean macOS installation, copied-Project portability, Batch generation, and live Job
execution on candidate `79190eb`; the release commit adds documentation and 1.0.0 package metadata.
Local checks passed 1,147 backend tests and 427 frontend tests. Hosted main and tag CI passed tests,
builds, fake-backed Chromium desktop/mobile browser coverage, artifact-security checks, and secret scans.
Dependency audits reported no known advisories for the audited dependency sets; these checks are not a
guarantee against all vulnerabilities or proof of every platform's compatibility.

## Known Limits

- Single-user local/trusted-LAN operation without authentication. Do not expose the application to the internet.
- No automatic backend executor restart recovery or Exact Rerun. Load Run as Batch creates a new editable experiment.
- Stop-after-current does not interrupt the active ComfyUI Job. Stop waiting detaches local observation only.
- Automated browser coverage uses Chromium desktop/mobile viewports, not Safari or native mobile/Windows app acceptance.
- Resource budgets do not impose a total process-memory or temporary-download disk quota. HTTP timeouts are inactivity-based.
- Historical CSV is raw data: import spreadsheet columns as text with formula evaluation disabled.

## License And Security

batchcraft is licensed under GPL-3.0-only; third-party dependencies retain their own licenses.
The source includes the license and build/install inputs. This release does not bundle models,
custom nodes, browsers, or dependency environments.

Report vulnerabilities privately through the repository's
[security advisories](https://github.com/pixeldj/batchcraft/security/advisories), not public issues.
See [SECURITY.md](https://github.com/pixeldj/batchcraft/blob/main/SECURITY.md) for deployment and reporting guidance.
