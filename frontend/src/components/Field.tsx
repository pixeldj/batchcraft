import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: ReactNode;
}

export function Field({ label, hint, id, ...props }: FieldProps) {
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <input id={id} {...props} />
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

interface TextAreaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hint?: ReactNode;
}

export function TextAreaField({ label, hint, id, ...props }: TextAreaFieldProps) {
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <textarea id={id} {...props} />
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}
