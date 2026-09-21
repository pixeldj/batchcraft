export function WorkflowPrompt({ text }: { text: string | null }) {
  return <details className="workflow-prompt">
    <summary>Workflow prompt{text === null ? " (unavailable)" : text === "" ? " (empty string)" : ""}</summary>
    {text === null
      ? <p className="section-note">The mapped input has no literal string prompt.</p>
      : text === ""
        ? <p className="section-note">Empty string. Create a non-empty Prompt Template through Add Prompt.</p>
        : <pre className="prompt-editor">{text}</pre>}
  </details>;
}
