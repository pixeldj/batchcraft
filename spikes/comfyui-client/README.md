# ComfyUI client spike

This disposable command-line client proves the Mac-to-Windows ComfyUI boundary. It is not production batchcraft code and should not grow into the backend integration layer.

The checked-in API workflow uses these fixed mutation points:

| Value | Node | Input |
| --- | --- | --- |
| Prompt | `34` | `prompt` |
| Reference image | `25` | `image` |
| Seed | `7` | `seed` |
| Output filename prefix | `41` | `filename_prefix` |

The workflow also depends on the models, LoRAs, and custom nodes named in `test-workflow.json`. They must already exist on the target ComfyUI host.

## Run

From the repository root:

```bash
export COMFYUI_BASE_URL="http://<windows-host>:8188"
uv run --project spikes/comfyui-client comfyui-client --image example.png
```

The base URL may instead be passed with `--base-url`. Run `uv run --project spikes/comfyui-client comfyui-client --help` for all options.

The root `example.png` is an ignored local test fixture. Another image can be supplied with `--image`.

The client:

1. reads `/system_stats`;
2. uploads the reference image into a unique ComfyUI input subfolder;
3. deep-copies and mutates the workflow fixture;
4. opens the WebSocket connection before submitting to `/prompt`;
5. records events associated with the returned prompt ID;
6. confirms success through `/history/{prompt_id}`;
7. discovers and downloads every file descriptor in that prompt's history.

An HTTP transport failure or invalid response during prompt submission is treated as ambiguous. The spike records the failure and exits without retrying.

## Output

Generated files are ignored by Git and written under:

```text
outputs/comfyui-spike/<run-id>/
├── diagnostics.json
├── submitted-workflow.json
├── history.json
├── events.jsonl
└── images/
    ├── 000001-01.png
    └── ...
```

## Verified boundary

The happy path was verified from macOS against a real Windows ComfyUI `0.31.0` host with an NVIDIA RTX 3090 on 2026-08-27. The checked-in workflow, its custom nodes, and its model selections executed successfully.

The live run proved:

- `/system_stats` connectivity over the LAN;
- image upload into a unique input subfolder;
- all four workflow mutations without changing the fixture;
- prompt ID capture and correlated WebSocket events through `execution_success`;
- terminal success through prompt history;
- output discovery from producing node `41`;
- output download through `/view` to the Mac.

The upload response used forward slashes in its subfolder. Output history used Windows backslashes. Passing the history metadata unchanged to `/view` retrieved the output correctly.

This spike did not test reconnection, cancellation, ambiguous-submission reconciliation, multiple simultaneous Jobs, or production scheduling.
