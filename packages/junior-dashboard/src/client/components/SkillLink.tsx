import { useId, useState, type ReactNode } from "react";

import { useSkillDetail } from "../api";
import { HighlightedCode } from "../code";
import { DisplayText } from "../display-text/DisplayText";
import { DashboardApiError } from "../http";
import { cn } from "../styles";
import { Drawer } from "./Drawer";
import { InlineError } from "./InlineError";
import { MarkdownViewToggle, type MarkdownView } from "./MarkdownViewToggle";
import { Skeleton } from "./ui/skeleton";

const SKELETON_LINE_WIDTHS = ["w-3/4", "w-full", "w-5/6", "w-2/3", "w-full"];

/** Write a skill name the way people invoke it, such as `$self-update`. */
export function skillLabel(name: string): string {
  return `$${name}`;
}

/**
 * Name a skill as `$skill-name` and open its SKILL.md in a drawer on click.
 * Pass children to replace the label, such as "View skill". Set `chip` in
 * skill lists.
 */
export function SkillLink(props: {
  children?: ReactNode;
  chip?: boolean;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className={cn(
          "cursor-pointer text-dashboard-accent-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus",
          props.chip
            ? "rounded-md border border-dashboard-border bg-dashboard-overlay-soft px-2.5 py-1.5 text-xs hover:border-dashboard-border-heavy"
            : "border-0 bg-transparent p-0 hover:underline",
          props.children ? "font-sans" : "font-mono",
        )}
        onClick={() => setOpen(true)}
        type="button"
      >
        {props.children ?? skillLabel(props.name)}
      </button>
      {open ? (
        <SkillDrawer name={props.name} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function SkillDrawer(props: { name: string; onClose(): void }) {
  const titleId = useId();
  const [view, setView] = useState<MarkdownView>("formatted");
  const skill = useSkillDetail(props.name);
  const missing =
    skill.error instanceof DashboardApiError && skill.error.status === 404;

  return (
    <Drawer
      actions={
        skill.data ? (
          <MarkdownViewToggle onChange={setView} value={view} />
        ) : null
      }
      closeLabel={`Close ${skillLabel(props.name)}`}
      header={
        <div className="min-w-0 [overflow-wrap:anywhere]">
          <h2
            className="m-0 font-mono text-sm font-semibold text-dashboard-text"
            id={titleId}
          >
            {skillLabel(props.name)}
          </h2>
          {skill.data ? (
            <div className="font-sans text-xs text-dashboard-text-muted">
              {skill.data.pluginProvider
                ? `From the ${skill.data.pluginProvider} plugin`
                : "App or local skill"}
              {skill.data.disableModelInvocation ? " · Manual only" : ""}
            </div>
          ) : null}
        </div>
      }
      onClose={props.onClose}
      openKey={titleId}
      titleId={titleId}
      width="wide"
    >
      {skill.isPending ? (
        <div aria-label="Loading skill" className="grid gap-2" role="status">
          {SKELETON_LINE_WIDTHS.map((width, index) => (
            <Skeleton className={`h-4 ${width}`} key={index} />
          ))}
        </div>
      ) : skill.isError ? (
        <InlineError>
          {missing
            ? "This skill is no longer installed."
            : "Could not load this skill."}
        </InlineError>
      ) : (
        <div className="grid min-w-0 gap-4">
          <p className="m-0 text-sm text-dashboard-text-muted">
            {skill.data.description}
          </p>
          <div className="border-t border-dashboard-border-subtle pt-4">
            {view === "formatted" ? (
              <DisplayText document text={skill.data.body} />
            ) : (
              <HighlightedCode code={skill.data.body} language="markdown" />
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}
