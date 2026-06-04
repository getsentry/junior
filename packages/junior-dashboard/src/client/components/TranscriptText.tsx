import type { ReactNode } from "react";

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

/** Render transcript markdown/code blocks with structured markup expansion. */
export function TranscriptText(props: {
  firstChildIndex: number;
  lastChildIndex: number;
  role?: string;
  text: string;
}) {
  const blocks = parseMarkdownBlocks(props.text, {
    outputOnly: transcriptRoleKind(props.role ?? "") === "assistant",
  });
  let seenChildren = props.firstChildIndex;

  return (
    <div className="grid min-w-0 gap-2">
      {blocks.map((block, index) => {
        const firstChildIndex = seenChildren;
        const childCount = countStructuredBlockChildren(block);
        seenChildren += childCount;

        if (block.language === "markdown" && !block.fenced) {
          return <MarkdownProse key={index} text={block.code} />;
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

function MarkdownProse(props: { text: string }) {
  return (
    <div className="min-w-0 whitespace-pre-wrap break-words text-[0.92rem] leading-relaxed [overflow-wrap:anywhere]">
      {renderMarkdownInline(props.text)}
    </div>
  );
}

function renderMarkdownInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const link = findNextInlineLink(text, cursor);
    if (!link) break;

    if (link.start > cursor) nodes.push(text.slice(cursor, link.start));
    nodes.push(
      <TranscriptAnchor href={link.href} key={`link-${link.start}`}>
        {link.label}
      </TranscriptAnchor>,
    );
    if (link.suffix) nodes.push(link.suffix);
    cursor = link.end;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function TranscriptAnchor(props: { children: ReactNode; href: string }) {
  const opensNewTab = /^https?:/i.test(props.href);
  return (
    <a
      className="font-medium text-[#d8ccff] underline decoration-[#beaaff]/45 underline-offset-2 transition-colors hover:text-white hover:decoration-white"
      href={props.href}
      rel={opensNewTab ? "noreferrer" : undefined}
      target={opensNewTab ? "_blank" : undefined}
    >
      {props.children}
    </a>
  );
}

type InlineLink = {
  end: number;
  href: string;
  label: string;
  start: number;
  suffix?: string;
};

function findNextInlineLink(
  text: string,
  start: number,
): InlineLink | undefined {
  const markdownLink = findNextMarkdownLink(text, start);
  const bareLink = findNextBareLink(text, start);

  if (!markdownLink) return bareLink;
  if (!bareLink) return markdownLink;
  return markdownLink.start <= bareLink.start ? markdownLink : bareLink;
}

function findNextMarkdownLink(
  text: string,
  start: number,
): InlineLink | undefined {
  for (
    let linkStart = text.indexOf("[", start);
    linkStart >= 0;
    linkStart = text.indexOf("[", linkStart + 1)
  ) {
    const labelEnd = text.indexOf("]", linkStart + 1);
    if (labelEnd < 0) return undefined;
    if (text[labelEnd + 1] !== "(") continue;

    const label = text.slice(linkStart + 1, labelEnd);
    if (!label || label.includes("\n")) continue;

    const destination = readMarkdownDestination(text, labelEnd + 2);
    if (!destination) continue;

    const href = safeMarkdownHref(destination.href);
    if (!href) continue;

    return {
      end: destination.end,
      href,
      label,
      start: linkStart,
    };
  }
}

function readMarkdownDestination(
  text: string,
  start: number,
): { end: number; href: string } | undefined {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char !== ")") continue;

    if (depth > 0) {
      depth -= 1;
      continue;
    }

    const href = text.slice(start, index);
    return href ? { end: index + 1, href } : undefined;
  }
}

function findNextBareLink(text: string, start: number): InlineLink | undefined {
  const bareUrlPattern = /(https?:\/\/[^\s<>"']+|mailto:[^\s<>"']+)/gi;
  bareUrlPattern.lastIndex = start;

  let match: RegExpExecArray | null;
  while ((match = bareUrlPattern.exec(text))) {
    const rawHref = match[0];
    const bareLink = trimBareUrl(rawHref);
    const href = safeMarkdownHref(bareLink.href);
    if (!href) continue;

    return {
      end: match.index + rawHref.length,
      href,
      label: href,
      start: match.index,
      ...(bareLink.suffix ? { suffix: bareLink.suffix } : {}),
    };
  }
}

function safeMarkdownHref(href: string): string | undefined {
  const trimmed = href.trim();
  if (!trimmed || /[\u0000-\u001f\u007f\s]/.test(trimmed)) return undefined;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "mailto:"
      ? trimmed
      : undefined;
  } catch {
    return undefined;
  }
}

function trimBareUrl(href: string): { href: string; suffix: string } {
  let trimmed = href;
  let suffix = "";

  while (shouldTrimBareUrlSuffix(trimmed)) {
    suffix = `${trimmed.slice(-1)}${suffix}`;
    trimmed = trimmed.slice(0, -1);
  }

  return { href: trimmed, suffix };
}

function shouldTrimBareUrlSuffix(href: string): boolean {
  const last = href.at(-1);
  if (!last) return false;
  if (/[.,;:!?]/.test(last)) return true;
  return last === ")" && closingParensExceedOpening(href);
}

function closingParensExceedOpening(value: string): boolean {
  let balance = 0;
  for (const char of value) {
    if (char === "(") balance += 1;
    if (char === ")") balance -= 1;
  }
  return balance < 0;
}
