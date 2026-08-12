import type { ReactNode } from "react";

import { cn } from "../styles";
import {
  findTranscriptMarkdownLinks,
  TRANSCRIPT_ANCHOR_CLASS,
} from "./transcriptMarkdownLinks";
import { HighlightText, useTranscriptSearch } from "./transcriptSearch";

type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "paragraph"; lines: string[] };

/** Render transcript markdown as readable prose with GFM-style hard breaks. */
export function TranscriptMarkdown(props: {
  compact?: boolean;
  text: string;
}): ReactNode {
  const blocks = parseMarkdownProseBlocks(props.text);
  if (blocks.length === 0) return null;

  return (
    <div
      className={cn(
        "min-w-0 break-words text-dashboard-text [overflow-wrap:anywhere]",
        props.compact
          ? "font-sans text-sm leading-6"
          : "font-sans text-sm leading-6 md:leading-7",
      )}
    >
      <div className="grid min-w-0 gap-2">
        {blocks.map((block, index) => (
          <MarkdownBlockView block={block} key={index} />
        ))}
      </div>
    </div>
  );
}

function MarkdownBlockView(props: { block: MarkdownBlock }) {
  switch (props.block.type) {
    case "heading": {
      const className = cn(
        "m-0 min-w-0 font-semibold tracking-[-0.01em] text-dashboard-text",
        props.block.level <= 2 ? "text-[1.05em]" : "text-[1em]",
      );
      const content = renderInlineMarkdown(props.block.text);
      switch (props.block.level) {
        case 1:
          return <h1 className={className}>{content}</h1>;
        case 2:
          return <h2 className={className}>{content}</h2>;
        case 3:
          return <h3 className={className}>{content}</h3>;
        case 4:
          return <h4 className={className}>{content}</h4>;
        case 5:
          return <h5 className={className}>{content}</h5>;
        default:
          return <h6 className={className}>{content}</h6>;
      }
    }
    case "list": {
      const ListTag = props.block.ordered ? "ol" : "ul";
      return (
        <ListTag
          className={cn(
            "m-0 grid min-w-0 list-outside gap-1 pl-5 text-dashboard-text",
            props.block.ordered ? "list-decimal" : "list-disc",
          )}
        >
          {props.block.items.map((item, index) => (
            <li className="min-w-0 pl-1" key={index}>
              {renderInlineMarkdown(item)}
            </li>
          ))}
        </ListTag>
      );
    }
    case "paragraph":
      return (
        <p className="m-0 min-w-0 whitespace-normal text-dashboard-text">
          {props.block.lines.map((line, index) => (
            <span key={index}>
              {index > 0 ? <br /> : null}
              {renderInlineMarkdown(line)}
            </span>
          ))}
        </p>
      );
  }
}

function parseMarkdownProseBlocks(text: string): MarkdownBlock[] {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
  if (!normalized) return [];

  const blocks: MarkdownBlock[] = [];
  for (const chunk of normalized.split(/\n{2,}/)) {
    const lines = chunk.split("\n");
    let index = 0;
    while (index < lines.length) {
      const line = lines[index] ?? "";
      const heading = matchHeading(line);
      if (heading) {
        blocks.push(heading);
        index += 1;
        continue;
      }

      const ordered = isOrderedListItem(line);
      const unordered = isUnorderedListItem(line);
      if (ordered || unordered) {
        const items: string[] = [];
        while (
          index < lines.length &&
          (ordered
            ? isOrderedListItem(lines[index] ?? "")
            : isUnorderedListItem(lines[index] ?? ""))
        ) {
          items.push(
            (lines[index] ?? "").replace(
              ordered ? /^\s*\d+\.\s+/ : /^\s*[-*+]\s+/,
              "",
            ),
          );
          index += 1;
        }
        blocks.push({ items, ordered, type: "list" });
        continue;
      }

      const paragraphLines: string[] = [];
      while (
        index < lines.length &&
        !matchHeading(lines[index] ?? "") &&
        !isOrderedListItem(lines[index] ?? "") &&
        !isUnorderedListItem(lines[index] ?? "")
      ) {
        paragraphLines.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({ lines: paragraphLines, type: "paragraph" });
    }
  }

  return blocks;
}

function matchHeading(line: string): MarkdownBlock | undefined {
  const match = /^(#{1,6})\s+(.+)$/.exec(line);
  if (!match) return undefined;
  return {
    level: match[1]!.length as 1 | 2 | 3 | 4 | 5 | 6,
    text: match[2]!.trimEnd(),
    type: "heading",
  };
}

function isUnorderedListItem(line: string): boolean {
  return /^\s*[-*+]\s+\S/.test(line);
}

function isOrderedListItem(line: string): boolean {
  return /^\s*\d+\.\s+\S/.test(line);
}

function renderInlineMarkdown(text: string): ReactNode[] {
  // code -> emphasis -> links, so bold/italic can wrap URLs without leaking ** into hrefs
  return renderInlineCode(text, 0);
}

function renderInlineCode(text: string, keyBase: number): ReactNode[] {
  if (!text) return [];

  const nodes: ReactNode[] = [];
  const codePattern = /(`+)([^`]+?)\1/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let part = 0;

  while ((match = codePattern.exec(text))) {
    if (match.index > cursor) {
      nodes.push(
        ...renderEmphasisText(
          text.slice(cursor, match.index),
          `${keyBase}-${part++}`,
        ),
      );
    }
    nodes.push(
      <code
        className="rounded-[0.25rem] bg-dashboard-fill-strong px-1 py-0.5 font-mono text-[0.9em] text-cyan-50"
        key={`code-${keyBase}-${part++}`}
      >
        <HighlightText text={match[2] ?? ""} />
      </code>,
    );
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    nodes.push(...renderEmphasisText(text.slice(cursor), `${keyBase}-${part}`));
  }
  return nodes;
}

function renderEmphasisText(text: string, keyBase: string): ReactNode[] {
  if (!text) return [];

  const nodes: ReactNode[] = [];
  const pattern = /(\*\*|__)(.+?)\1|\*([^*]+?)\*/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let part = 0;

  while ((match = pattern.exec(text))) {
    if (match.index > cursor) {
      nodes.push(
        ...renderLinkText(text.slice(cursor, match.index), `${keyBase}-t-${part++}`),
      );
    }
    nodes.push(
      match[1] ? (
        <strong
          className="font-semibold text-dashboard-text"
          key={`${keyBase}-b-${part++}`}
        >
          {renderLinkText(match[2] ?? "", `${keyBase}-bc-${part}`)}
        </strong>
      ) : (
        <em
          className="italic text-dashboard-text"
          key={`${keyBase}-i-${part++}`}
        >
          {renderLinkText(match[3] ?? "", `${keyBase}-ic-${part}`)}
        </em>
      ),
    );
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    nodes.push(...renderLinkText(text.slice(cursor), `${keyBase}-t-${part}`));
  }
  return nodes;
}

function renderLinkText(text: string, keyBase: string): ReactNode[] {
  if (!text) return [];

  const links = findTranscriptMarkdownLinks(text);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let part = 0;

  for (const link of links) {
    if (link.start > cursor) {
      nodes.push(
        <HighlightText
          key={`${keyBase}-s-${part++}`}
          text={text.slice(cursor, link.start)}
        />,
      );
    }
    nodes.push(
      <TranscriptAnchor href={link.href} key={`${keyBase}-a-${link.start}`}>
        <SearchAwareLinkLabel href={link.href} label={link.label} />
      </TranscriptAnchor>,
    );
    cursor = link.end;
  }

  if (cursor < text.length) {
    nodes.push(
      <HighlightText key={`${keyBase}-s-${part}`} text={text.slice(cursor)} />,
    );
  }
  return nodes;
}

function SearchAwareLinkLabel(props: { href: string; label: string }) {
  const search = useTranscriptSearch();
  const hrefMatches =
    search.active && props.href.toLowerCase().includes(search.normalizedQuery);
  const labelMatches = props.label
    .toLowerCase()
    .includes(search.normalizedQuery);

  if (hrefMatches && !labelMatches) {
    return (
      <mark
        className="rounded-[2px] bg-amber-400/20 px-0.5 text-inherit not-italic"
        title={`Matched URL: ${props.href}`}
      >
        {props.label}
      </mark>
    );
  }

  return <HighlightText text={props.label} />;
}

function TranscriptAnchor(props: { children: ReactNode; href: string }) {
  const opensNewTab = /^https?:/i.test(props.href);
  return (
    <a
      className={TRANSCRIPT_ANCHOR_CLASS}
      href={props.href}
      rel={opensNewTab ? "noreferrer" : undefined}
      target={opensNewTab ? "_blank" : undefined}
    >
      {props.children}
    </a>
  );
}
