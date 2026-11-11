import { ChevronRight } from "lucide-react";
import type { WalkthroughDocument } from "@sentry/junior/api/schema";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import { DisplayText } from "../display-text/DisplayText";
import { alsoChanged } from "./walkthroughModel";

/** One kind of mechanical change, such as "2 lockfiles". */
function skippedText(entry: WalkthroughDocument["skipped"][number]): string {
  const n = entry.files;
  const files = n === 1 ? "file" : "files";
  switch (entry.reason) {
    case "generated":
      return `${n} generated ${files}`;
    case "lockfile":
      return `${n} ${n === 1 ? "lockfile" : "lockfiles"}`;
    case "no_diff":
      return `${n} ${files} with no diff`;
    case "rename":
      return `${n} renamed ${files}`;
    case "whitespace":
      return `${n} ${files} with only whitespace changes`;
  }
}

/**
 * Changed files the story leaves out, grouped by why, after the last
 * chapter. Closed at first: the story does not need them, but the reviewer
 * can see that nothing is hidden.
 */
export function WalkthroughAlsoChanged(props: {
  document: WalkthroughDocument;
}) {
  const groups = alsoChanged(props.document);
  const skipped = props.document.skipped;
  const files =
    groups.reduce((sum, group) => sum + group.files.length, 0) +
    skipped.reduce((sum, entry) => sum + entry.files, 0);
  if (!files) return null;
  const stacked = props.document.layers.length > 1;
  return (
    <Collapsible className="grid max-w-3xl gap-3 border-t border-dashboard-border-subtle pt-4">
      <CollapsibleTrigger className="group flex w-fit cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-sm font-medium text-dashboard-text-subtle hover:text-dashboard-text">
        <ChevronRight
          aria-hidden="true"
          className="size-4 transition-transform group-data-[panel-open]:rotate-90"
        />
        Also changed
        <span className="font-normal text-dashboard-text-muted tabular-nums">
          {files} {files === 1 ? "file" : "files"}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-4 pl-5.5">
        {groups.map((group) => (
          <section className="grid gap-1" key={group.reason}>
            <h3 className="m-0 text-sm font-medium text-dashboard-text">
              <DisplayText inline text={group.reason} />
            </h3>
            <ul className="m-0 grid list-none gap-0.5 p-0">
              {group.files.map((file) => (
                <li
                  className="font-mono text-xs break-all text-dashboard-text-muted"
                  key={`${file.pr}:${file.path}`}
                >
                  {file.path}
                  {stacked ? (
                    <span className="font-sans"> · #{file.pr}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
        {skipped.length ? (
          <p className="m-0 text-sm text-dashboard-text-muted">
            Not read for the story: {skipped.map(skippedText).join(", ")}.
          </p>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}
