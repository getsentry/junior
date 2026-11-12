import { Children, type ReactNode, type RefCallback } from "react";
import type { OwnedObjectAnnotation } from "@sentry/junior/api/schema";
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
import {
  HighlightText,
  useTranscriptSearch,
} from "../conversations/transcriptSearch";
import { cn } from "../styles";
import { ANCHOR_CLASS, safeHref, slackLinksToMarkdown } from "./links";
import { renderTextTokens } from "./mentions";
import { OutboundLink } from "../components/OutboundLink";
import { ObjectCard } from "../conversations/ObjectCard";
import {
  ObjectLinkChip,
  ObjectLinkPreview,
  useKnownObject,
} from "./ObjectLinks";
import {
  resolvableUrl,
  useResolvedObject,
  useWhenVisible,
} from "./resolvedObjects";

/**
 * Render display text Markdown as readable prose.
 *
 * The text is CommonMark plus GFM, with a hard break for each newline. Agent
 * replies also use Slack-style `•` bullets, `<url|label>` links, and
 * bold-only section labels, so those render as lists, links, and headings
 * too. Inline mode keeps only inline formatting, so the text fits in one
 * line or in a button. Document mode reads a Markdown file: plain CommonMark
 * plus GFM, where a newline in a paragraph does not break the line.
 *
 * A link to a known object (`KnownObjectsProvider`) previews its card on
 * hover. Other links ask the API for a card when they scroll into view or
 * the reader hovers them, and stay plain links until a card arrives.
 * Outside document mode, a bare URL in running text shows as a chip, and a
 * bare URL alone in a top-level paragraph shows the full card.
 */
export function MarkdownText(props: {
  chat?: boolean;
  compact?: boolean;
  document?: boolean;
  inline?: boolean;
  text: string;
}): ReactNode {
  if (!props.text.trim()) return null;
  const source = props.document
    ? props.text
    : normalizeSlackBullets(slackLinksToMarkdown(props.text));

  if (props.inline) {
    return (
      <Markdown
        components={INLINE_COMPONENTS}
        remarkPlugins={[remarkGfm]}
        urlTransform={safeHref}
      >
        {source}
      </Markdown>
    );
  }

  return (
    <div
      className={cn(
        "min-w-0 break-words text-dashboard-text [overflow-wrap:anywhere]",
        props.chat
          ? "font-sans text-base leading-relaxed"
          : "font-sans text-sm leading-6",
        !props.chat && !props.compact && "md:leading-7",
      )}
    >
      <div className={cn("grid min-w-0", props.chat ? "gap-3" : "gap-2")}>
        <Markdown
          components={COMPONENTS}
          remarkPlugins={
            props.document
              ? [remarkGfm]
              : [
                  remarkGfm,
                  remarkBreaks,
                  remarkBareUrlStops,
                  remarkSectionLabels,
                  remarkObjectLinks,
                ]
          }
          urlTransform={safeHref}
        >
          {source}
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
  data?: { hProperties?: Record<string, unknown> };
  depth?: number;
  position?: { start: { offset?: number } };
  type: string;
  url?: string;
  value?: string;
};

/**
 * End a bare URL at `*`, as Slack output does (`readBareUrl` in
 * `packages/junior/src/chat/slack/mrkdwn.ts`). GFM keeps `*` in the URL, so
 * `https://example.com**bold**` would link to `https://example.com**bold`.
 */
function remarkBareUrlStops() {
  return (tree: MarkdownNode, file: { value: unknown }) => {
    splitBareUrls(tree, String(file.value));
  };
}

function splitBareUrls(parent: MarkdownNode, source: string): void {
  parent.children = parent.children?.flatMap((node) => {
    splitBareUrls(node, source);
    const text = node.children?.[0];
    const stop = node.url?.indexOf("*") ?? -1;
    const bare =
      node.type === "link" &&
      node.children?.length === 1 &&
      text?.value === node.url &&
      source[node.position?.start.offset ?? -1] !== "<";
    if (!bare || stop <= 0) return [node];

    const url = node.url!.slice(0, stop);
    return [
      { ...node, children: [{ type: "text", value: url }], url },
      { type: "text", value: node.url!.slice(stop) },
    ];
  });
}

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

/**
 * Mark each top-level paragraph that holds only a bare URL, so the paragraph
 * can show the full card of a known object. A bare URL in a list, a quote,
 * or a sentence stays inline.
 */
function remarkObjectLinks() {
  return (tree: MarkdownNode) => {
    for (const node of tree.children ?? []) {
      const [link, ...rest] = node.children ?? [];
      if (node.type !== "paragraph" || rest.length > 0) continue;
      if (link?.type !== "link" || !isBareLink(link)) continue;
      node.data = {
        ...node.data,
        hProperties: { ...node.data?.hProperties, dataObjectUrl: link.url },
      };
    }
  };
}

// A bare URL is a link whose text is its URL, such as an autolink.
function isBareLink(link: MarkdownNode): boolean {
  const [text, ...rest] = link.children ?? [];
  return rest.length === 0 && text?.type === "text" && text.value === link.url;
}

const HEADING_CLASS =
  "m-0 min-w-0 font-semibold tracking-[-0.01em] text-dashboard-text [&:not(:first-child)]:mt-1 [&+*]:-mt-1";

const COMPONENTS: Components = {
  a: ({ children, href, node }) => (
    <TranscriptAnchor
      bare={
        node?.children.length === 1 &&
        node.children[0]?.type === "text" &&
        node.children[0].value === href
      }
      href={href}
    >
      {children}
    </TranscriptAnchor>
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
  p: ({ children, node }) => (
    <Paragraph objectUrl={node?.properties.dataObjectUrl}>{children}</Paragraph>
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

// Text nodes can hold Slack mention tokens, emoji codes, and search matches.
function renderText(children: ReactNode): ReactNode {
  return Children.map(children, (child, index) =>
    typeof child === "string" ? renderTextTokens(child, `t-${index}`) : child,
  );
}

// Inline mode ends each block with a newline. A one-line container shows it
// as a space, and a `whitespace-pre-wrap` container keeps the line break.
function InlineBlock(props: { children?: ReactNode }) {
  return (
    <>
      {renderText(props.children)}
      {"\n"}
    </>
  );
}

function InlineCell(props: { children?: ReactNode }) {
  return <>{renderText(props.children)} </>;
}

function InlineContainer(props: { children?: ReactNode }) {
  return <>{props.children}</>;
}

const INLINE_COMPONENTS: Components = {
  // A link cannot sit in a button or in another link, so keep the label.
  a: ({ children }) => <>{renderText(children)}</>,
  blockquote: InlineContainer,
  code: COMPONENTS.code,
  del: COMPONENTS.del,
  em: COMPONENTS.em,
  h1: InlineBlock,
  h2: InlineBlock,
  h3: InlineBlock,
  h4: InlineBlock,
  h5: InlineBlock,
  h6: InlineBlock,
  hr: () => "\n",
  img: ({ alt }) => alt ?? null,
  li: InlineBlock,
  ol: InlineContainer,
  p: InlineBlock,
  pre: InlineContainer,
  strong: COMPONENTS.strong,
  table: InlineContainer,
  tbody: InlineContainer,
  td: InlineCell,
  th: InlineCell,
  thead: InlineContainer,
  tr: InlineBlock,
  ul: InlineContainer,
};

function alignClass(align: unknown): string | undefined {
  if (align === "center") return "text-center";
  if (align === "right") return "text-right";
  return undefined;
}

function Paragraph(props: { children: ReactNode; objectUrl?: unknown }) {
  const known = useKnownObject(
    typeof props.objectUrl === "string" ? props.objectUrl : undefined,
  );
  if (known) return <ObjectCard card={known} />;
  if (typeof props.objectUrl === "string" && resolvableUrl(props.objectUrl)) {
    return (
      <ResolvedParagraph objectUrl={props.objectUrl}>
        {props.children}
      </ResolvedParagraph>
    );
  }
  return <PlainParagraph>{props.children}</PlainParagraph>;
}

// The link in the paragraph asks for the card. This reads the same entry.
function ResolvedParagraph(props: { children: ReactNode; objectUrl: string }) {
  const { card } = useResolvedObject(props.objectUrl);
  if (card) return <ObjectCard card={card} live />;
  return <PlainParagraph>{props.children}</PlainParagraph>;
}

function PlainParagraph(props: { children: ReactNode }) {
  return (
    <p className="m-0 min-w-0 whitespace-normal">
      {renderText(props.children)}
    </p>
  );
}

function TranscriptAnchor(props: {
  bare?: boolean;
  children: ReactNode;
  href?: string;
}) {
  const card = useKnownObject(props.href);
  // `safeHref` removes unsafe destinations. Keep their label text.
  if (!props.href) return <>{renderText(props.children)}</>;
  const label =
    typeof props.children === "string" ? (
      <SearchAwareLinkLabel href={props.href} label={props.children} />
    ) : (
      props.children
    );
  if (card) {
    return (
      <ObjectAnchor bare={props.bare} card={card} href={props.href}>
        {label}
      </ObjectAnchor>
    );
  }
  if (resolvableUrl(props.href)) {
    return (
      <ResolvedAnchor bare={props.bare} href={props.href}>
        {label}
      </ResolvedAnchor>
    );
  }
  return <PlainAnchor href={props.href}>{label}</PlainAnchor>;
}

// A link without a saved object asks the API for a card when it scrolls
// into view or the reader hovers it.
function ResolvedAnchor(props: {
  bare?: boolean;
  children: ReactNode;
  href: string;
}) {
  const { card, request } = useResolvedObject(props.href);
  const observe = useWhenVisible(request);
  if (card) {
    return (
      <ObjectAnchor bare={props.bare} card={card} href={props.href} live>
        {props.children}
      </ObjectAnchor>
    );
  }
  return (
    <PlainAnchor href={props.href} observe={observe} onPointerEnter={request}>
      {props.children}
    </PlainAnchor>
  );
}

function ObjectAnchor(props: {
  bare?: boolean;
  card: OwnedObjectAnnotation;
  children: ReactNode;
  href: string;
  live?: boolean;
}) {
  if (props.bare) {
    return (
      <ObjectLinkChip card={props.card} href={props.href} live={props.live} />
    );
  }
  return (
    <ObjectLinkPreview
      card={props.card}
      className={ANCHOR_CLASS}
      href={props.href}
      live={props.live}
    >
      {props.children}
    </ObjectLinkPreview>
  );
}

function PlainAnchor(props: {
  children: ReactNode;
  href: string;
  observe?: RefCallback<HTMLAnchorElement>;
  onPointerEnter?: () => void;
}) {
  if (!/^https?:/i.test(props.href)) {
    return (
      <a
        className={ANCHOR_CLASS}
        href={props.href}
        onPointerEnter={props.onPointerEnter}
        ref={props.observe}
      >
        {props.children}
      </a>
    );
  }
  return (
    <OutboundLink
      className={ANCHOR_CLASS}
      href={props.href}
      onPointerEnter={props.onPointerEnter}
      ref={props.observe}
    >
      {props.children}
    </OutboundLink>
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
        className="rounded-[2px] bg-amber-400/20 text-inherit not-italic"
        title={`Matched URL: ${props.href}`}
      >
        {props.label}
      </mark>
    );
  }

  return <HighlightText text={props.label} />;
}
