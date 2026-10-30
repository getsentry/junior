import { Children, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { cn } from "../styles";
import {
  safeTranscriptHref,
  TRANSCRIPT_ANCHOR_CLASS,
} from "./transcriptMarkdownLinks";
import { renderMentionText } from "./transcriptMentions";
import { HighlightText, useTranscriptSearch } from "./transcriptSearch";

/**
 * Render transcript markdown as readable prose.
 *
 * The text is CommonMark plus GFM, with a hard break for each newline. Agent
 * replies also use Slack-style `•` bullets and bold-only section labels, so
 * those render as lists and headings too.
 */
export function TranscriptMarkdown(props: {
  compact?: boolean;
  text: string;
}): ReactNode {
  if (!props.text.trim()) return null;

  return (
    <div
      className={cn(
        "min-w-0 break-words text-dashboard-text [overflow-wrap:anywhere]",
        props.compact
          ? "font-sans text-base leading-relaxed"
          : "font-sans text-sm leading-6 md:leading-7",
      )}
    >
      <div className={cn("grid min-w-0", props.compact ? "gap-3" : "gap-2")}>
        <Markdown
          components={COMPONENTS}
          remarkPlugins={[remarkGfm, remarkBreaks, remarkSectionLabels]}
          urlTransform={safeTranscriptHref}
        >
          {normalizeSlackBullets(props.text)}
        </Markdown>
      </div>
    </div>
  );
}

// Slack-style replies use "•" and "◦" bullets. CommonMark only knows -, *, +.
function normalizeSlackBullets(text: string): string {
  return text.replace(/^([ \t]*)[•◦](?=[ \t])/gm, "$1-");
}

type MarkdownNode = {
  children?: MarkdownNode[];
  depth?: number;
  type: string;
  value?: string;
};

/**
 * Agents often start a top-level paragraph with a bold-only line, such as
 * `**Gaps**`, as a section label. Make that line a heading so the section
 * reads as a group.
 */
function remarkSectionLabels() {
  return (tree: MarkdownNode) => {
    tree.children = tree.children?.flatMap(splitSectionLabel);
  };
}

function splitSectionLabel(node: MarkdownNode): MarkdownNode[] {
  const [label, ...rest] = node.children ?? [];
  if (node.type !== "paragraph" || label?.type !== "strong") return [node];

  const colon = rest[0]?.type === "text" && rest[0].value === ":";
  const afterLabel = colon ? rest.slice(1) : rest;
  if (afterLabel.length > 0 && afterLabel[0]?.type !== "break") return [node];

  const heading: MarkdownNode = {
    children: colon ? [label, rest[0]!] : [label],
    depth: 3,
    type: "heading",
  };
  const body = afterLabel.slice(1);
  return body.length > 0
    ? [heading, { children: body, type: "paragraph" }]
    : [heading];
}

const HEADING_CLASS =
  "m-0 min-w-0 font-semibold tracking-[-0.01em] text-dashboard-text [&:not(:first-child)]:mt-1 [&+*]:-mt-1";

const COMPONENTS: Components = {
  a: ({ children, href }) => (
    <TranscriptAnchor href={href}>{children}</TranscriptAnchor>
  ),
  blockquote: ({ children }) => (
    <blockquote className="m-0 grid min-w-0 gap-2 border-l-2 border-dashboard-border pl-3 text-dashboard-text-muted">
      {children}
    </blockquote>
  ),
  code: ({ children }) => (
    <code className="rounded-[0.25rem] bg-dashboard-fill-strong px-1 py-0.5 font-mono text-[0.9em] text-dashboard-text">
      {Children.map(children, (child) =>
        typeof child === "string" ? <HighlightText text={child} /> : child,
      )}
    </code>
  ),
  del: ({ children }) => (
    <del className="text-dashboard-text-muted">{renderText(children)}</del>
  ),
  em: ({ children }) => (
    <em className="italic text-dashboard-text">{renderText(children)}</em>
  ),
  h1: ({ children }) => (
    <h1 className={cn(HEADING_CLASS, "text-[1.05em]")}>
      {renderText(children)}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className={cn(HEADING_CLASS, "text-[1.05em]")}>
      {renderText(children)}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className={cn(HEADING_CLASS, "text-[1em]")}>{renderText(children)}</h3>
  ),
  h4: ({ children }) => (
    <h4 className={cn(HEADING_CLASS, "text-[1em]")}>{renderText(children)}</h4>
  ),
  h5: ({ children }) => (
    <h5 className={cn(HEADING_CLASS, "text-[1em]")}>{renderText(children)}</h5>
  ),
  h6: ({ children }) => (
    <h6 className={cn(HEADING_CLASS, "text-[1em]")}>{renderText(children)}</h6>
  ),
  hr: () => <hr className="m-0 w-full border-dashboard-border" />,
  // Do not load remote images from transcript text. Link to them instead.
  img: ({ alt, src }) => (
    <TranscriptAnchor href={typeof src === "string" ? src : undefined}>
      {alt || src}
    </TranscriptAnchor>
  ),
  li: ({ children, className }) => (
    <li
      className={cn(
        "min-w-0 pl-1 [&>*+*]:mt-1.5",
        className?.includes("task-list-item") && "-ml-5 list-none",
      )}
    >
      {renderText(children)}
    </li>
  ),
  ol: ({ children, start }) => (
    <ol
      className="m-0 grid min-w-0 list-outside list-decimal gap-1.5 pl-6 text-dashboard-text marker:text-dashboard-text-muted"
      start={start}
    >
      {children}
    </ol>
  ),
  p: ({ children }) => (
    <p className="m-0 min-w-0 whitespace-normal">{renderText(children)}</p>
  ),
  pre: ({ children }) => (
    <pre className="m-0 min-w-0 overflow-x-auto rounded-md border border-dashboard-border-subtle bg-dashboard-surface-panel px-3 py-2.5 font-mono text-sm [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-dashboard-text">
      {renderText(children)}
    </strong>
  ),
  table: ({ children }) => (
    <div className="min-w-0 max-w-full overflow-hidden rounded-md border border-dashboard-border bg-dashboard-fill-faint">
      <Table className="w-max min-w-full">{children}</Table>
    </div>
  ),
  tbody: ({ children }) => <TableBody>{children}</TableBody>,
  td: ({ children, style }) => (
    <TableCell
      className={cn("px-2.5 py-1.5 align-top", alignClass(style?.textAlign))}
    >
      {renderText(children)}
    </TableCell>
  ),
  th: ({ children, style }) => (
    <TableHead
      className={cn("px-2.5 py-1.5", alignClass(style?.textAlign))}
      scope="col"
    >
      {renderText(children)}
    </TableHead>
  ),
  thead: ({ children }) => (
    <TableHeader className="bg-dashboard-overlay-soft">{children}</TableHeader>
  ),
  tr: ({ children }) => (
    <TableRow className="[thead_&]:border-dashboard-border">
      {children}
    </TableRow>
  ),
  ul: ({ children }) => (
    <ul className="m-0 grid min-w-0 list-outside list-disc gap-1.5 pl-6 text-dashboard-text marker:text-dashboard-text-muted">
      {children}
    </ul>
  ),
};

// Text nodes can hold Slack mention tokens and transcript search matches.
function renderText(children: ReactNode): ReactNode {
  return Children.map(children, (child, index) =>
    typeof child === "string" ? renderMentionText(child, `t-${index}`) : child,
  );
}

function alignClass(align: unknown): string | undefined {
  if (align === "center") return "text-center";
  if (align === "right") return "text-right";
  return undefined;
}

function TranscriptAnchor(props: { children: ReactNode; href?: string }) {
  // `safeTranscriptHref` removes unsafe destinations. Keep their label text.
  if (!props.href) return <>{renderText(props.children)}</>;

  const opensNewTab = /^https?:/i.test(props.href);
  return (
    <a
      className={TRANSCRIPT_ANCHOR_CLASS}
      href={props.href}
      rel={opensNewTab ? "noreferrer" : undefined}
      target={opensNewTab ? "_blank" : undefined}
    >
      {typeof props.children === "string" ? (
        <SearchAwareLinkLabel href={props.href} label={props.children} />
      ) : (
        props.children
      )}
    </a>
  );
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
