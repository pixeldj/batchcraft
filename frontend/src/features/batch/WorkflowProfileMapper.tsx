import type {
  JsonObject,
  ParameterValueType,
  WorkflowProfileImageInput,
  WorkflowProfileParameter,
} from "../../api/types";
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
];

const SUPPORTED_MAPPING_KEYS = new Set(MAPPINGS.map((mapping) => mapping.key));

export function WorkflowProfileMapper({ workflow, profileJson, onChange }: Props) {
  const catalog = parseWorkflowNodeCatalog(workflow);
  const profile = parseObject(profileJson);
  const mappings = profile && isObject(profile.mappings) ? profile.mappings : {};
  const imageInputs = profile && Array.isArray(profile.image_inputs)
    ? profile.image_inputs.flatMap(readImageInput)
    : [];
  const parameters = profile && Array.isArray(profile.parameters)
    ? profile.parameters.flatMap(readParameter)
    : [];
  const unsupported = Object.keys(mappings).filter((key) => !SUPPORTED_MAPPING_KEYS.has(key as WorkflowMappingKind));
  const targets = Object.fromEntries([
    ...MAPPINGS.map((spec) => [`core:${spec.key}`, readTarget(mappings[spec.key])] as const),
    ...imageInputs.map((slot, index) => [`image:${index}`, readTarget({ ...slot, value_type: "image" })] as const),
    ...parameters.map((parameter, index) => [`parameter:${index}`, readTarget(parameter)] as const),
  ]);
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

  function changeImageInput(index: number, patch: Partial<WorkflowProfileImageInput>) {
    if (!profile) return;
    const next = imageInputs.map((slot, slotIndex) => {
      if (slotIndex !== index) return slot;
      const nextSlot = { ...slot, ...patch };
      if (!slot.key && patch.node_id !== undefined && nextSlot.label.trim()) {
        nextSlot.key = deriveImageInputKey(
          nextSlot.label,
          imageInputs.flatMap((input, inputIndex) => inputIndex === index ? [] : [input.key]),
        );
      }
      return nextSlot;
    });
    onChange(JSON.stringify({ ...profile, image_inputs: next }, null, 2));
  }

  function establishImageInputKey(index: number) {
    const slot = imageInputs[index];
    if (!slot || slot.key || !slot.label.trim()) return;
    changeImageInput(index, { node_id: slot.node_id });
  }

  function addImageInput() {
    if (!profile) return;
    const slot = { key: "", label: "", node_id: "", input_name: "" };
    onChange(JSON.stringify({ ...profile, image_inputs: [...imageInputs, slot] }, null, 2));
  }

  function removeImageInput(index: number) {
    if (!profile) return;
    onChange(JSON.stringify({ ...profile, image_inputs: imageInputs.filter((_, slotIndex) => slotIndex !== index) }, null, 2));
  }

  function moveImageInput(index: number, direction: -1 | 1) {
    if (!profile) return;
    const target = index + direction;
    if (target < 0 || target >= imageInputs.length) return;
    const next = [...imageInputs];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(JSON.stringify({ ...profile, image_inputs: next }, null, 2));
  }

  function changeParameter(index: number, patch: Partial<WorkflowProfileParameter>) {
    if (!profile) return;
    const next = parameters.map((parameter, parameterIndex) => {
      if (parameterIndex !== index) return parameter;
      const changed = { ...parameter, ...patch };
      if (!parameter.key && patch.node_id !== undefined && changed.label.trim()) {
        changed.key = deriveParameterKey(
          changed.label,
          parameters.flatMap((item, itemIndex) => itemIndex === index ? [] : [item.key]),
        );
      }
      if (patch.node_id !== undefined || patch.input_name !== undefined) {
        const node = catalog.find((item) => item.id === changed.node_id);
        const input = node?.inputs.find((item) => item.name === changed.input_name);
        const inferred = input?.kind === "literal" ? inferParameterValueType(input.currentValue) : null;
        if (inferred) changed.value_type = inferred;
      }
      return changed;
    });
    onChange(JSON.stringify({ ...profile, parameters: next }, null, 2));
  }

  function establishParameterKey(index: number) {
    const parameter = parameters[index];
    if (!parameter || parameter.key || !parameter.label.trim()) return;
    changeParameter(index, { node_id: parameter.node_id });
  }

  function addParameter() {
    if (!profile) return;
    const parameter: WorkflowProfileParameter = {
      key: "",
      label: "",
      node_id: "",
      input_name: "",
      value_type: "string",
    };
    onChange(JSON.stringify({ ...profile, parameters: [...parameters, parameter] }, null, 2));
  }

  function removeParameter(index: number) {
    if (!profile) return;
    onChange(JSON.stringify({ ...profile, parameters: parameters.filter((_, parameterIndex) => parameterIndex !== index) }, null, 2));
  }

  function moveParameter(index: number, direction: -1 | 1) {
    if (!profile) return;
    const target = index + direction;
    if (target < 0 || target >= parameters.length) return;
    const next = [...parameters];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(JSON.stringify({ ...profile, parameters: next }, null, 2));
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
          const target = targets[`core:${spec.key}`];
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
      <section className="workflow-image-inputs" aria-labelledby="workflow-image-inputs-title">
        <div className="repeater-title">
          <div>
            <h3 id="workflow-image-inputs-title">Image Inputs</h3>
            <p className="mapping-current-value">Named image slots preserve Profile order.</p>
          </div>
          <button className="button-secondary compact" type="button" onClick={addImageInput}>Add Image Input</button>
        </div>
        {imageInputs.length === 0 ? <p className="empty-note">No Image Inputs.</p> : null}
        <div className="workflow-mapping-list">
          {imageInputs.map((slot, index) => {
            const spec: MappingSpec = { key: "image_input", label: slot.label || `Image Input ${index + 1}`, valueType: "image", required: true };
            const target = targets[`image:${index}`];
            const selectedNode = catalog.find((node) => node.id === target?.nodeId) ?? null;
            const selectedInput = selectedNode?.inputs.find((input) => input.name === target?.inputName) ?? null;
            const issue = mappingIssue(spec, target, selectedNode, selectedInput, duplicateTargets);
            return (
              <fieldset className={`workflow-mapping-card ${issue ? "invalid" : ""}`} key={index}>
                <legend>{slot.label || `Image Input ${index + 1}`}</legend>
                <div className="workflow-mapping-fields">
                  <label className="field"><span className="field-label">Label</span><input aria-label={`Image Input ${index + 1} label`} required value={slot.label} onBlur={() => establishImageInputKey(index)} onChange={(event) => changeImageInput(index, { label: event.target.value })} /></label>
                  <label className="field"><span className="field-label">Node</span><select aria-label={`${spec.label} node`} aria-invalid={Boolean(issue)} value={slot.node_id} onChange={(event) => changeImageInput(index, { node_id: event.target.value, input_name: "" })}><option value="">Select a node</option>{slot.node_id && !selectedNode ? <option value={slot.node_id}>Missing node {slot.node_id}</option> : null}{rankedNodes(catalog, "image_input").map((node) => <option key={node.id} value={node.id}>{formatWorkflowNodeLabel(node)}</option>)}</select></label>
                  <label className="field"><span className="field-label">Input</span><select aria-label={`${spec.label} input`} aria-invalid={Boolean(issue)} disabled={!selectedNode} required value={slot.input_name} onChange={(event) => changeImageInput(index, { input_name: event.target.value })}><option value="">Select an input</option>{slot.input_name && selectedNode && !selectedInput ? <option value={slot.input_name}>Missing input {slot.input_name}</option> : null}{selectedNode ? rankedInputs(selectedNode, "image_input").map((input) => <option key={input.name} value={input.name} disabled={input.kind === "connection"}>{input.name}{input.kind === "connection" ? " (connected)" : ""}</option>) : null}</select></label>
                </div>
                <div className="repeater-actions">
                  <button aria-label={`Move ${spec.label} up`} className="button-link" type="button" disabled={index === 0} onClick={() => moveImageInput(index, -1)}>Up</button>
                  <button aria-label={`Move ${spec.label} down`} className="button-link" type="button" disabled={index === imageInputs.length - 1} onClick={() => moveImageInput(index, 1)}>Down</button>
                  <button aria-label={`Remove ${spec.label}`} className="button-link danger" type="button" onClick={() => removeImageInput(index)}>Remove</button>
                </div>
                {selectedInput?.kind === "literal" ? <p className="mapping-current-value">Current value: <code>{summarizeLiteralValue(selectedInput.currentValue)}</code></p> : null}
                {issue ? <p className="mapping-error" role="alert">{issue}</p> : null}
              </fieldset>
            );
          })}
        </div>
      </section>
      <section className="workflow-image-inputs" aria-labelledby="workflow-parameters-title">
        <div className="repeater-title">
          <div>
            <h3 id="workflow-parameters-title">Parameters</h3>
            <p className="mapping-current-value">Fixed literal overrides preserve Profile order.</p>
          </div>
          <button className="button-secondary compact" type="button" onClick={addParameter}>Add Parameter</button>
        </div>
        {parameters.length === 0 ? <p className="empty-note">No Parameters.</p> : null}
        <div className="workflow-mapping-list">
          {parameters.map((parameter, index) => {
            const target = targets[`parameter:${index}`];
            const selectedNode = catalog.find((node) => node.id === target?.nodeId) ?? null;
            const selectedInput = selectedNode?.inputs.find((input) => input.name === target?.inputName) ?? null;
            const issue = parameterIssue(parameter, target, selectedNode, selectedInput, duplicateTargets);
            const compatibleTypes = selectedInput?.kind === "literal"
              ? compatibleParameterValueTypes(selectedInput.currentValue)
              : PARAMETER_VALUE_TYPES;
            const label = parameter.label || `Parameter ${index + 1}`;
            return (
              <fieldset className={`workflow-mapping-card ${issue ? "invalid" : ""}`} key={index}>
                <legend>{label}</legend>
                <div className="workflow-mapping-fields">
                  <label className="field"><span className="field-label">Label</span><input aria-label={`Parameter ${index + 1} label`} required value={parameter.label} onBlur={() => establishParameterKey(index)} onChange={(event) => changeParameter(index, { label: event.target.value })} /></label>
                  <label className="field"><span className="field-label">Node</span><select aria-label={`${label} node`} aria-invalid={Boolean(issue)} value={parameter.node_id} onChange={(event) => changeParameter(index, { node_id: event.target.value, input_name: "" })}><option value="">Select a node</option>{parameter.node_id && !selectedNode ? <option value={parameter.node_id}>Missing node {parameter.node_id}</option> : null}{catalog.map((node) => <option key={node.id} value={node.id}>{formatWorkflowNodeLabel(node)}</option>)}</select></label>
                  <label className="field"><span className="field-label">Input</span><select aria-label={`${label} input`} aria-invalid={Boolean(issue)} disabled={!selectedNode} required value={parameter.input_name} onChange={(event) => changeParameter(index, { input_name: event.target.value })}><option value="">Select an input</option>{parameter.input_name && selectedNode && !selectedInput ? <option value={parameter.input_name}>Missing input {parameter.input_name}</option> : null}{selectedNode ? genericInputs(selectedNode).map((input) => <option key={input.name} value={input.name} disabled={input.kind === "connection" || compatibleParameterValueTypes(input.currentValue).length === 0}>{input.name}{input.kind === "connection" ? " (connected)" : compatibleParameterValueTypes(input.currentValue).length === 0 ? " (not scalar)" : ""}</option>) : null}</select></label>
                  <label className="field"><span className="field-label">Type</span><select aria-label={`${label} type`} required value={compatibleTypes.includes(parameter.value_type) ? parameter.value_type : ""} onChange={(event) => changeParameter(index, { value_type: event.target.value as ParameterValueType })}>{!compatibleTypes.includes(parameter.value_type) ? <option value="">Incompatible current literal</option> : null}{PARAMETER_VALUE_TYPES.map((valueType) => <option key={valueType} value={valueType} disabled={!compatibleTypes.includes(valueType)}>{valueType}</option>)}</select></label>
                </div>
                <div className="repeater-actions">
                  <button aria-label={`Move ${label} up`} className="button-link" type="button" disabled={index === 0} onClick={() => moveParameter(index, -1)}>Up</button>
                  <button aria-label={`Move ${label} down`} className="button-link" type="button" disabled={index === parameters.length - 1} onClick={() => moveParameter(index, 1)}>Down</button>
                  <button aria-label={`Remove ${label}`} className="button-link danger" type="button" onClick={() => removeParameter(index)}>Remove</button>
                </div>
                {selectedInput?.kind === "literal" ? <p className="mapping-current-value">Current value: <code>{summarizeLiteralValue(selectedInput.currentValue)}</code></p> : null}
                {issue ? <p className="mapping-error" role="alert">{issue}</p> : null}
              </fieldset>
            );
          })}
        </div>
      </section>
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

export function deriveImageInputKey(label: string, existingKeys: string[]): string {
  return deriveStableKey(label, existingKeys, "image");
}

export function deriveParameterKey(label: string, existingKeys: string[]): string {
  return deriveStableKey(label, existingKeys, "parameter");
}

function deriveStableKey(label: string, existingKeys: string[], prefix: "image" | "parameter"): string {
  const normalized = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const base = /^[a-z]/.test(normalized)
    ? normalized
    : normalized
      ? `${prefix}_${normalized}`
      : prefix === "image" ? "image_input" : "parameter";
  const existing = new Set(existingKeys);
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

const PARAMETER_VALUE_TYPES: ParameterValueType[] = ["string", "integer", "float", "boolean"];

export function inferParameterValueType(value: unknown): ParameterValueType | null {
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value)) return Number.isSafeInteger(value) ? "integer" : null;
    return "float";
  }
  return null;
}

function compatibleParameterValueTypes(value: unknown): ParameterValueType[] {
  const inferred = inferParameterValueType(value);
  if (inferred === "integer") return ["integer", "float"];
  return inferred ? [inferred] : [];
}

function readImageInput(value: unknown): WorkflowProfileImageInput[] {
  if (!isObject(value)) return [];
  if (typeof value.key !== "string" || typeof value.label !== "string" || typeof value.node_id !== "string" || typeof value.input_name !== "string") return [];
  return [{ key: value.key, label: value.label, node_id: value.node_id, input_name: value.input_name }];
}

function readParameter(value: unknown): WorkflowProfileParameter[] {
  if (!isObject(value)) return [];
  if (
    typeof value.key !== "string"
    || typeof value.label !== "string"
    || typeof value.node_id !== "string"
    || typeof value.input_name !== "string"
    || !PARAMETER_VALUE_TYPES.includes(value.value_type as ParameterValueType)
  ) return [];
  return [{
    key: value.key,
    label: value.label,
    node_id: value.node_id,
    input_name: value.input_name,
    value_type: value.value_type as ParameterValueType,
  }];
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

function parameterIssue(
  parameter: WorkflowProfileParameter,
  target: MappingTarget | null,
  node: WorkflowCatalogNode | null,
  input: WorkflowCatalogInput | null,
  duplicates: Set<string>,
): string | null {
  const label = parameter.label || "Parameter";
  if (!parameter.label.trim()) return "Parameter label is required.";
  if (!parameter.key) return `${label} needs a stable key.`;
  if (!target?.nodeId) return `Select a node for ${label}.`;
  if (!node) return `Node ${target.nodeId} is missing from this WorkflowVersion.`;
  if (!target.inputName) return `Select an input for ${label}.`;
  if (!input) return `Input ${target.inputName} is missing from node ${target.nodeId}.`;
  if (input.kind === "connection") return `Input ${target.inputName} on node ${target.nodeId} is connected and cannot be overwritten.`;
  if (!compatibleParameterValueTypes(input.currentValue).includes(parameter.value_type)) {
    return `${label} type ${parameter.value_type} is incompatible with the current literal.`;
  }
  if (duplicates.has(`${target.nodeId}\0${target.inputName}`)) {
    return `Node ${target.nodeId} input ${target.inputName} is used by more than one mapping.`;
  }
  return null;
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

function genericInputs(node: WorkflowCatalogNode) {
  return [...node.inputs].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "literal" ? -1 : 1;
    return left.name.localeCompare(right.name);
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
