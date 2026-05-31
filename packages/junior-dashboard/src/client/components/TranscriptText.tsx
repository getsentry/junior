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
  text: string;
}) {
  const blocks = parseMarkdownBlocks(props.text);
  let seenChildren = props.firstChildIndex;

  return (
    <div className="grid min-w-0 gap-2">
      {blocks.map((block, index) => {
        const firstChildIndex = seenChildren;
        const childCount = countStructuredBlockChildren(block);
        seenChildren += childCount;

        if (!canRenderStructuredMarkup(block.language)) {
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
