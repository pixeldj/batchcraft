import type { JsonObject } from "../../api/types";

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

export function profileMappingCount(profile: JsonObject): string {
  if (!Array.isArray(profile.image_inputs) || !Array.isArray(profile.parameters)) return "Summary unavailable";
  return `${profile.image_inputs.length} named inputs / ${profile.parameters.length} parameters`;
}

export function ReadonlyProfileSummary({ profile, workflow }: { profile: JsonObject; workflow: JsonObject }) {
  function nodeLabel(mapping: JsonObject) {
    const node = object(workflow[String(mapping.node_id)]);
    const title = object(node._meta).title;
    return typeof title === "string" ? title : typeof node.class_type === "string" ? node.class_type : "Unavailable node";
  }
  const mappings = object(profile.mappings);
  return <div className="global-profile-summary">
    <dl className="global-profile-core">{[["prompt", "Prompt"], ["seed", "Seed"], ["output_prefix", "Output Prefix"]].map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{mappings[key] ? nodeLabel(object(mappings[key])) : "Not mapped"}</dd></div>)}</dl>
    <h5>Named Image Inputs</h5>
    {Array.isArray(profile.image_inputs) ? profile.image_inputs.length ? <ul>{profile.image_inputs.map((value, index) => { const item = object(value); return <li key={index}>{String(item.label ?? item.key ?? "Unnamed input")} <code>{String(item.key ?? "")}</code></li>; })}</ul> : <p>No named Image Inputs.</p> : <p>Summary unavailable</p>}
    <h5>Typed Parameters</h5>
    {Array.isArray(profile.parameters) ? profile.parameters.length ? <ul>{profile.parameters.map((value, index) => { const item = object(value); return <li key={index}>{String(item.label ?? item.key ?? "Unnamed parameter")} <span className="global-library-meta">{String(item.value_type ?? "Unknown type")}</span></li>; })}</ul> : <p>No typed parameters.</p> : <p>Summary unavailable</p>}
    <details><summary>Technical mapping targets</summary><pre>{JSON.stringify({ mappings: profile.mappings, image_inputs: profile.image_inputs, parameters: profile.parameters }, null, 2)}</pre></details>
  </div>;
}
