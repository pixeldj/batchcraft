import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { readWorkflowPrompt } from "./baseWorkflowValue";
import { ReadonlyProfileSummary } from "./ReadonlyProfileSummary";

const profile = { mappings: { prompt: { node_id: "7", input_name: "text", value_type: "string" } }, image_inputs: [], parameters: [] };

describe("mapped Workflow prompt", () => {
  it.each([undefined, null, 42, false, ["8", 0], { text: "wrong" }])("rejects unavailable/nonliteral input %j", (value) => {
    expect(readWorkflowPrompt({ "7": { inputs: { text: value } } }, profile)).toBeNull();
  });
  it("uses the exact target, preserves whitespace and distinguishes empty strings", () => {
    expect(readWorkflowPrompt({ "7": { inputs: { text: "  {{subject}}\n\n end  " } } }, profile)).toBe("  {{subject}}\n\n end  ");
    expect(readWorkflowPrompt({ "7": { inputs: { text: "" } } }, profile)).toBe("");
    expect(readWorkflowPrompt({ "8": { inputs: { text: "other" } } }, profile)).toBeNull();
    expect(readWorkflowPrompt({}, {})).toBeNull();
  });
  it("shows an expandable read-only exact prompt in Profile summaries", () => {
    const text = "  original\n\n" + "long prompt ".repeat(100);
    const { container } = render(<ReadonlyProfileSummary profile={profile} workflow={{ "7": { inputs: { text } } }} />);
    expect(screen.getByText("Workflow prompt").closest("details")).not.toHaveAttribute("open");
    expect(container.querySelector(".workflow-prompt pre")?.textContent).toBe(text);
    expect(screen.queryByRole("button", { name: "Use this prompt" })).not.toBeInTheDocument();
  });
});
