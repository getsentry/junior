import {
  countStructuredBlockChildren,
  HighlightedCode,
  StructuredMarkup,
} from "../code";
import {
  canRenderStructuredMarkup,
  parseMarkdownBlocks,
  transcriptRoleKind,
} from "../format";
import { TranscriptMarkdown } from "./TranscriptMarkdown";

/** Render transcript markdown/code blocks with structured markup expansion. */
export function TranscriptText(props: {
  firstChildIndex: number;
  lastChildIndex: number;
  role?: string;
  text: string;
}) {
  const roleKind = transcriptRoleKind(props.role ?? "");
  const blocks = parseMarkdownBlocks(props.text, {
    outputOnly: roleKind === "assistant",
  });
  let seenChildren = props.firstChildIndex;

  return (
    <div className="grid min-w-0 gap-2">
      {blocks.map((block, index) => {
        const firstChildIndex = seenChildren;
        const childCount = countStructuredBlockChildren(block);
        seenChildren += childCount;

        if (block.language === "markdown" && !block.fenced) {
          return (
            <TranscriptMarkdown
              compact={roleKind === "assistant" || roleKind === "user"}
              key={index}
              text={block.code}
            />
          );
        }

        if (!canRenderStructuredMarkup(block)) {
          return (
            <HighlightedCode
              code={block.code}
              key={index}
              language={block.language}
            />
          );
        }

        return (
          <StructuredMarkup
            block={block}
            firstChildIndex={firstChildIndex}
            key={index}
            lastChildIndex={props.lastChildIndex}
          />
        );
      })}
    </div>
  );
}
