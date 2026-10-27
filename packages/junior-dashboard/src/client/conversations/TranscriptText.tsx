import { memo } from "react";
import type { ActorIdentity } from "@sentry/junior/api/schema";

import { HighlightedCode } from "../code";
import { parseMarkdownBlocks, transcriptRoleKind } from "../format";
import { TranscriptMarkdown } from "./TranscriptMarkdown";
import { MentionPeopleProvider } from "./transcriptMentions";

/**
 * Render transcript prose as Markdown with explicit fenced code blocks.
 * `mentions` are the people that the API resolved for this text.
 */
export const TranscriptText = memo(function TranscriptText(props: {
  mentions: readonly ActorIdentity[];
  role?: string;
  text: string;
}) {
  const roleKind = transcriptRoleKind(props.role ?? "");
  const blocks = parseMarkdownBlocks(props.text);

  return (
    <MentionPeopleProvider mentions={props.mentions}>
      <div className="grid min-w-0 gap-2">
        {blocks.map((block, index) => {
          if (block.language === "markdown" && !block.fenced) {
            return (
              <TranscriptMarkdown
                compact={roleKind === "assistant" || roleKind === "user"}
                key={index}
                text={block.code}
              />
            );
          }

          return (
            <div
              className="min-w-0 overflow-hidden rounded-md border border-dashboard-border-subtle bg-dashboard-surface-panel px-3 py-2.5"
              key={index}
            >
              <HighlightedCode code={block.code} language={block.language} />
            </div>
          );
        })}
      </div>
    </MentionPeopleProvider>
  );
});
