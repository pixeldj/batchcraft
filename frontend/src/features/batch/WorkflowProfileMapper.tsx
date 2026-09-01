import type { JsonObject } from "../../api/types";
import {
  formatWorkflowNodeLabel,
  parseWorkflowNodeCatalog,
  rankWorkflowInputCandidates,
  scoreWorkflowInputCandidate,
  summarizeLiteralValue,
  type WorkflowCatalogInput,
  type WorkflowCatalogNode,
  type WorkflowMappingKind,
} from "./workflowCatalog";

interface Props {
  workflow: JsonObject;
  profileJson: string;
  onChange(profileJson: string): void;
}

interface MappingSpec {
  key: WorkflowMappingKind;
  label: string;
  valueType: "string" | "integer" | "image";
  required: boolean;
}

interface MappingTarget {
  nodeId: string;
  inputName: string;
  valueType: unknown;
}

const MAPPINGS: readonly MappingSpec[] = [
  { key: "prompt", label: "Prompt", valueType: "string", required: true },
  { key: "seed", label: "Seed", valueType: "integer", required: true },
  { key: "output_prefix", label: "Output Prefix", valueType: "string", required: true },
  { key: "reference_image", label: "Input Image", valueType: "image", required: false },
];

const SUPPORTED_MAPPING_KEYS = new Set(MAPPINGS.map((mapping) => mapping.key));

export function WorkflowProfileMapper({ workflow, profileJson, onChange }: Props) {
  const catalog = parseWorkflowNodeCatalog(workflow);
  const profile = parseObject(profileJson);
  const mappings = profile && isObject(profile.mappings) ? profile.mappings : {};
  const unsupported = Object.keys(mappings).filter((key) => !SUPPORTED_MAPPING_KEYS.has(key as WorkflowMappingKind));
  const targets = Object.fromEntries(MAPPINGS.map((spec) => [spec.key, readTarget(mappings[spec.key])]));
  const duplicateTargets = duplicateMappingTargets(targets);

  function changeMapping(spec: MappingSpec, nodeId: string, inputName: string) {
    const nextProfile = profile ?? {};
    const currentMappings = isObject(nextProfile.mappings) ? nextProfile.mappings : {};
    const supportedMappings = Object.fromEntries(
      Object.entries(currentMappings).filter(([key]) => SUPPORTED_MAPPING_KEYS.has(key as WorkflowMappingKind)),
    );
    if (!nodeId && !spec.required) {
      delete supportedMappings[spec.key];
    } else {
      supportedMappings[spec.key] = {
        node_id: nodeId,
        input_name: inputName,
        value_type: spec.valueType,
      };
    }
    onChange(JSON.stringify({ ...nextProfile, mappings: supportedMappings }, null, 2));
  }

  return (
    <div className="workflow-profile-mapper">
      <p className="mapping-intro">
        Map batchcraft values to literal inputs in this immutable WorkflowVersion. Suggested targets
        appear first; connected inputs are shown for context but cannot be selected.
      </p>
      {!profile ? (
        <p className="operation-error" role="alert">Workflow Profile JSON must contain an object.</p>
      ) : null}
      {unsupported.length ? (
        <p className="operation-error" role="alert">
          Unsupported mappings must be replaced: {unsupported.join(", ")}.
        </p>
      ) : null}
      <div className="workflow-mapping-list">
        {MAPPINGS.map((spec) => {
          const target = targets[spec.key];
          const selectedNode = catalog.find((node) => node.id === target?.nodeId) ?? null;
          const selectedInput = selectedNode?.inputs.find((input) => input.name === target?.inputName) ?? null;
          const issue = mappingIssue(spec, target, selectedNode, selectedInput, duplicateTargets);
          const nodes = rankedNodes(catalog, spec.key);
          const inputs = selectedNode ? rankedInputs(selectedNode, spec.key) : [];
          return (
            <fieldset className={`workflow-mapping-card ${issue ? "invalid" : ""}`} key={spec.key}>
              <legend>{spec.label}{spec.required ? "" : " (optional)"}</legend>
              <div className="workflow-mapping-fields">
                <label className="field">
                  <span className="field-label">Node</span>
                  <select
                    aria-label={`${spec.label} node`}
                    aria-invalid={Boolean(issue)}
                    required={spec.required}
                    value={target?.nodeId ?? ""}
                    onChange={(event) => changeMapping(spec, event.target.value, "")}
                  >
                    <option value="" disabled={spec.required}>
                      {spec.required ? "Select a node" : "Not mapped"}
                    </option>
                    {target?.nodeId && !selectedNode ? (
                      <option value={target.nodeId}>Missing node {target.nodeId}</option>
                    ) : null}
                    {nodes.map((node) => (
                      <option key={node.id} value={node.id}>{formatWorkflowNodeLabel(node)}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Input</span>
                  <select
                    aria-label={`${spec.label} input`}
                    aria-invalid={Boolean(issue)}
                    value={target?.inputName ?? ""}
                    disabled={!selectedNode}
                    required={spec.required || Boolean(selectedNode)}
                    onChange={(event) => changeMapping(spec, selectedNode?.id ?? "", event.target.value)}
                  >
                    <option value="" disabled>Select an input</option>
                    {target?.inputName && selectedNode && !selectedInput ? (
                      <option value={target.inputName}>Missing input {target.inputName}</option>
                    ) : null}
                    {inputs.map((input) => (
                      <option key={input.name} value={input.name} disabled={input.kind === "connection"}>
                        {input.name}{input.kind === "connection" ? " (connected)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {selectedInput?.kind === "literal" ? (
                <p className="mapping-current-value">
                  Current value: <code>{summarizeLiteralValue(selectedInput.currentValue)}</code>
                </p>
              ) : null}
              {issue ? <p className="mapping-error" role="alert">{issue}</p> : null}
            </fieldset>
          );
        })}
      </div>
      <details className="raw-profile-json">
        <summary>Raw profile JSON</summary>
        <textarea
          aria-label="Raw profile JSON"
          className="json-editor"
          readOnly
          spellCheck={false}
          value={profileJson}
        />
      </details>
    </div>
  );
}

function readTarget(value: unknown): MappingTarget | null {
  if (!isObject(value)) return null;
  return {
    nodeId: typeof value.node_id === "string" ? value.node_id : "",
    inputName: typeof value.input_name === "string" ? value.input_name : "",
    valueType: value.value_type,
  };
}

function mappingIssue(
  spec: MappingSpec,
  target: MappingTarget | null,
  node: WorkflowCatalogNode | null,
  input: WorkflowCatalogInput | null,
  duplicates: Set<string>,
): string | null {
  if (!target) return spec.required ? `${spec.label} must be mapped.` : null;
  if (!target.nodeId) return spec.required ? `Select a node for ${spec.label}.` : null;
  if (target.valueType !== spec.valueType) {
    return `${spec.label} must use value type ${spec.valueType}.`;
  }
  if (!node) return `Node ${target.nodeId} is missing from this WorkflowVersion.`;
  if (!target.inputName) return `Select an input for ${spec.label}.`;
  if (!input) return `Input ${target.inputName} is missing from node ${target.nodeId}.`;
  if (input.kind === "connection") {
    return `Input ${target.inputName} on node ${target.nodeId} is connected and cannot be overwritten.`;
  }
  if (duplicates.has(`${target.nodeId}\0${target.inputName}`)) {
    return `Node ${target.nodeId} input ${target.inputName} is used by more than one mapping.`;
  }
  return null;
}

function duplicateMappingTargets(targets: Record<string, MappingTarget | null>): Set<string> {
  const counts = new Map<string, number>();
  for (const target of Object.values(targets)) {
    if (!target?.nodeId || !target.inputName) continue;
    const key = `${target.nodeId}\0${target.inputName}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
}

function rankedNodes(catalog: WorkflowCatalogNode[], mappingKind: WorkflowMappingKind) {
  const rank = new Map<string, number>();
  for (const [index, candidate] of rankWorkflowInputCandidates(catalog, mappingKind).entries()) {
    if (!rank.has(candidate.node.id)) rank.set(candidate.node.id, index);
  }
  return [...catalog].sort((left, right) => (
    (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER)
  ));
}

function rankedInputs(node: WorkflowCatalogNode, mappingKind: WorkflowMappingKind) {
  return [...node.inputs].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "literal" ? -1 : 1;
    const score = scoreWorkflowInputCandidate(mappingKind, node, right)
      - scoreWorkflowInputCandidate(mappingKind, node, left);
    return score || left.name.localeCompare(right.name);
  });
}

function parseObject(value: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
