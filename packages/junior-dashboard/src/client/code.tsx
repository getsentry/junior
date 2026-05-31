import { useQuery } from "@tanstack/react-query";
import { codeToHtml, type BundledLanguage } from "shiki/bundle/web";

import { canRenderStructuredMarkup, parseMarkupNodes } from "./format";
import type { CodeBlock, MarkupNode } from "./types";

/** Count rendered children so transcripts can decide which markup node expands. */
export function countStructuredBlockChildren(block: CodeBlock): number {
  if (!canRenderStructuredMarkup(block.language)) return 1;
  const rootCount = parseMarkupNodes(block.code, block.language).length;
  return rootCount > 0 ? rootCount : 1;
}

/** Render structured markup blocks as collapsible nodes instead of flat code. */
export function StructuredMarkup(props: {
  block: CodeBlock;
  firstChildIndex: number;
  lastChildIndex: number;
}) {
  const nodes = parseMarkupNodes(props.block.code, props.block.language);
  if (nodes.length === 0) {
    return (
      <HighlightedCode
        code={props.block.code}
        language={props.block.language}
      />
    );
  }

  return (
    <>
      {nodes.map((node, index) => (
        <div
          className="grid min-w-0 gap-0 py-0.5 pl-4 font-mono text-[0.86rem] leading-relaxed text-[#b8b8b8]"
          key={index}
        >
          <MarkupNodeView
            defaultOpen={props.firstChildIndex + index === props.lastChildIndex}
            node={node}
          />
        </div>
      ))}
    </>
  );
}

function MarkupNodeView(props: { defaultOpen?: boolean; node: MarkupNode }) {
  if (props.node.type === "text") {
    return (
      <div className="min-w-0 whitespace-pre-wrap break-words text-white">
        {props.node.text.trim()}
      </div>
    );
  }

  const children = props.node.children;
  const hasChildren = children.length > 0;
  const attributes = props.node.attributes.map(([name, value]) => (
    <span className="ml-1.5 text-[#b8b8b8]" key={name}>
      {name}=<span className="text-white">"{value}"</span>
    </span>
  ));

  if (!hasChildren) {
    return (
      <div className="-ml-1 flex min-w-0 flex-wrap items-baseline px-1 py-0.5">
        <span className="text-[#888]">&lt;</span>
        <span className="font-bold text-white">{props.node.tagName}</span>
        {attributes}
        <span className="text-[#888]"> /&gt;</span>
      </div>
    );
  }

  return (
    <details
      className="group min-w-0 break-words"
      open={props.defaultOpen ?? true}
    >
      <summary className="-ml-1 flex w-full max-w-full cursor-pointer list-none flex-wrap items-baseline px-1 py-0.5 transition-colors hover:bg-white/[0.05] hover:text-white [&::-webkit-details-marker]:hidden">
        <span className="mr-1 w-2 text-white group-open:hidden">+</span>
        <span className="mr-1 hidden w-2 text-white group-open:inline">-</span>
        <span className="text-[#888]">&lt;</span>
        <span className="font-bold text-white">{props.node.tagName}</span>
        {attributes}
        <span className="text-[#888]">&gt;</span>
      </summary>
      <div className="ml-1 grid gap-0 border-l border-white/10 pl-3">
        {children.map((child, index) => (
          <MarkupNodeView
            defaultOpen={index === children.length - 1}
            key={index}
            node={child}
          />
        ))}
      </div>
      <div
        className="-ml-1 flex min-w-0 flex-wrap items-baseline px-1 py-0.5 transition-colors hover:bg-white/[0.05]"
        role="button"
        tabIndex={0}
      >
        <span className="text-[#888]">&lt;/</span>
        <span className="font-bold text-white">{props.node.tagName}</span>
        <span className="text-[#888]">&gt;</span>
      </div>
    </details>
  );
}

/** Render highlighted code while keeping Shiki output responsive in transcripts. */
export function HighlightedCode(props: {
  code: string;
  language: BundledLanguage;
}) {
  const highlighted = useQuery({
    queryKey: ["highlight", props.language, props.code],
    queryFn: async () =>
      codeToHtml(props.code, {
        lang: props.language,
        theme: "github-dark",
      }),
    staleTime: Infinity,
  });

  if (!highlighted.data) {
    return (
      <pre className="m-0 min-w-0 whitespace-pre-wrap break-words bg-transparent p-0 font-mono text-[0.86rem] leading-relaxed text-white">
        <code>{props.code}</code>
      </pre>
    );
  }

  return (
    <div
      className="min-w-0 overflow-visible [&_code]:whitespace-pre-wrap [&_code]:break-words [&_pre]:!m-0 [&_pre]:!overflow-visible [&_pre]:!bg-transparent [&_pre]:!p-0 [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre]:font-mono [&_pre]:text-[0.86rem] [&_pre]:leading-relaxed"
      dangerouslySetInnerHTML={{ __html: highlighted.data }}
    />
  );
}
