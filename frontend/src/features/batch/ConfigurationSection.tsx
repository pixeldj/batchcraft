import type { ReactNode } from "react";

interface Props {
  title: string;
  summary: ReactNode;
  expanded: boolean;
  collapsible: boolean;
  controlsId: string;
  action?: ReactNode;
  summaryAction?: ReactNode;
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
  summaryAction,
  actionLabel = "Edit",
  className = "",
  onExpandedChange,
  children,
}: Props) {
  const showContent = expanded || !collapsible;
  const titleId = `${controlsId}-title`;
  const toggleButton = (
    <button
      className="button-secondary compact"
      type="button"
      aria-expanded={showContent}
      aria-controls={controlsId}
      disabled={showContent && !collapsible}
      onClick={() => onExpandedChange(!showContent)}
    >
      {showContent ? "Done" : actionLabel}
    </button>
  );

  return (
    <section
      className={`configuration-section ${className}`.trim()}
      role="group"
      aria-labelledby={titleId}
    >
      <div className="configuration-section-header">
        <div className="configuration-section-heading">
          <div className="configuration-section-title" id={titleId}>{title}</div>
          <div className="configuration-summary-text">{summary}</div>
        </div>
        {!showContent && collapsible ? (
          <div className="section-summary-actions">
            {summaryAction}
            {toggleButton}
          </div>
        ) : null}
      </div>
      {showContent ? (
        <div className="configuration-content" id={controlsId}>
          {children}
          <div className="configuration-content-actions">
            {action}
            {toggleButton}
          </div>
        </div>
      ) : null}
    </section>
  );
}
