import type { ReactNode } from "react";

interface Props {
  title: string;
  summary: ReactNode;
  expanded: boolean;
  collapsible: boolean;
  controlsId: string;
  action?: ReactNode;
  actionLabel?: string;
  className?: string;
  onExpandedChange(expanded: boolean): void;
  children: ReactNode;
}

export function ConfigurationSection({
  title,
  summary,
  expanded,
  collapsible,
  controlsId,
  action,
  actionLabel = "Edit",
  className = "",
  onExpandedChange,
  children,
}: Props) {
  const showContent = expanded || !collapsible;

  return (
    <fieldset className={`configuration-section ${className}`.trim()}>
      <legend>{title}</legend>
      <div className="configuration-summary section-summary-row">
        <div className="configuration-summary-text">{summary}</div>
        {action && showContent || collapsible ? (
          <div className="section-summary-actions">
            {action && showContent ? action : null}
            {collapsible ? (
              <button
                className="button-secondary compact"
                type="button"
                aria-expanded={showContent}
                aria-controls={controlsId}
                onClick={() => onExpandedChange(!showContent)}
              >
                {showContent ? "Done" : actionLabel}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {showContent ? <div className="configuration-content" id={controlsId}>{children}</div> : null}
    </fieldset>
  );
}
