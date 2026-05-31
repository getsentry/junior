import {
  countStructuredBlockChildren,
  HighlightedCode,
  StructuredMarkup,
} from "../code";
import { canRenderStructuredMarkup, parseMarkdownBlocks } from "../format";

/** Render transcript markdown/code blocks with structured markup expansion. */
export function TranscriptText(props: {
  firstChildIndex: number;
  lastChildIndex: number;
  role?: string;
  text: string;
}) {
  const blocks = parseMarkdownBlocks(props.text, {
    outputOnly: props.role?.toLowerCase() === "assistant",
  });
  let seenChildren = props.firstChildIndex;

  return (
    <div className="grid min-w-0 gap-2">
      {blocks.map((block, index) => {
        const firstChildIndex = seenChildren;
        const childCount = countStructuredBlockChildren(block);
        seenChildren += childCount;

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
