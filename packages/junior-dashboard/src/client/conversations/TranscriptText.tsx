import { memo } from "react";

import { HighlightedCode } from "../code";
import { parseMarkdownBlocks, transcriptRoleKind } from "../format";
import { TranscriptMarkdown } from "./TranscriptMarkdown";

/** Render transcript prose as Markdown with explicit fenced code blocks. */
export const TranscriptText = memo(function TranscriptText(props: {
  role?: string;
  text: string;
}) {
  const roleKind = transcriptRoleKind(props.role ?? "");
  const blocks = parseMarkdownBlocks(props.text);

  return (
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
          <HighlightedCode
            code={block.code}
            key={index}
            language={block.language}
          />
        );
      })}
    </div>
  );
});
