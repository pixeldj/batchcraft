import type { RunCreatedResponse } from "../../api/types";

type RunDisplayIdentity = Pick<RunCreatedResponse, "run_name" | "run_number">;

export function runDisplayName(run: RunDisplayIdentity): string {
  return run.run_name ?? `Run ${run.run_number}`;
}

export function runNumberLabel(run: RunDisplayIdentity): string {
  return `Run ${run.run_number}`;
}

export function runDisplayLabel(run: RunDisplayIdentity): string {
  return run.run_name ? `${run.run_name} · ${runNumberLabel(run)}` : runNumberLabel(run);
}
