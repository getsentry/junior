import { codeToHtml } from "shiki/bundle/web";
import { describe, expect, it } from "vitest";

import {
  buildTranscriptMarkdownDecorations,
  findTranscriptMarkdownLinks,
} from "../src/client/components/transcriptMarkdownLinks";

describe("transcript markdown links", () => {
  it("finds safe markdown links, bare links, and skips unsafe destinations", () => {
    const text =
      'See [trace](https://sentry.example/trace), https://docs.example/path)., [local](/api/dashboard/me), [titled](https://docs.example/titled "Docs"), and [bad](javascript:https://unsafe.example).';

    expect(findTranscriptMarkdownLinks(text)).toEqual([
      {
        end: 41,
        href: "https://sentry.example/trace",
        label: "trace",
        start: 4,
      },
      {
        end: 68,
        href: "https://docs.example/path",
        label: "https://docs.example/path",
        start: 43,
      },
      {
        end: 144,
        href: "https://docs.example/titled",
        label: "titled",
        start: 100,
      },
    ]);
  });

  it("does not let malformed nested labels swallow later valid links", () => {
    const text = "See [broken [real](https://nested.example/ok).";

    expect(findTranscriptMarkdownLinks(text)).toEqual([
      {
        end: 45,
        href: "https://nested.example/ok",
        label: "real",
        start: 12,
      },
    ]);
  });

  it("leaves markdown-looking links inside inline code alone", () => {
    const text =
      "Use `[syntax](https://example.com)` and ``https://bare.example`` before [real](https://real.example) plus https://bare-real.example.";

    expect(
      findTranscriptMarkdownLinks(text).map(({ href, label }) => ({
        href,
        label,
      })),
    ).toEqual([
      {
        href: "https://real.example",
        label: "real",
      },
      {
        href: "https://bare-real.example",
        label: "https://bare-real.example",
      },
    ]);
  });

  it("leaves escaped markdown links literal", () => {
    const text =
      "Keep \\[literal](https://literal.example) but link [real](https://real.example).";

    expect(
      findTranscriptMarkdownLinks(text).map(({ href, label }) => ({
        href,
        label,
      })),
    ).toEqual([
      {
        href: "https://real.example",
        label: "real",
      },
    ]);
  });

  it("builds Shiki anchor decorations without losing markdown highlighting", async () => {
    const text =
      "## Trace summary\n- `span.op` is in [the trace](https://sentry.example/trace/abc).\n- `[literal](https://literal.example)` and \\[escaped](https://escaped.example).\n- [broken [real](https://nested.example/ok).\n- [local](/api/dashboard/me) and [bad](javascript:alert).";
    const links = findTranscriptMarkdownLinks(text);
    const highlighted = await codeToHtml(text, {
      decorations: buildTranscriptMarkdownDecorations(links),
      lang: "markdown",
      theme: "github-dark",
    });

    expect(highlighted).toContain('style="color:#79B8FF;font-weight:bold"');
    expect(highlighted).toContain('href="https://sentry.example/trace/abc"');
    expect(highlighted).toContain('target="_blank"');
    expect(highlighted).toContain('rel="noreferrer"');
    expect(highlighted).toContain(">the trace</a>");
    expect(highlighted).not.toContain(
      "[the trace](https://sentry.example/trace/abc)",
    );
    expect(highlighted).toContain('href="https://nested.example/ok"');
    expect(highlighted).toContain(">real</a>");
    expect(highlighted).not.toContain(">broken [real</a>");
    expect(highlighted).toContain("https://literal.example");
    expect(highlighted).toContain("https://escaped.example");
    expect(highlighted).not.toContain('href="https://literal.example"');
    expect(highlighted).not.toContain('href="https://escaped.example"');
    expect(highlighted).toContain("local");
    expect(highlighted).toContain("/api/dashboard/me");
    expect(highlighted).toContain("javascript:alert");
    expect(highlighted).not.toContain('href="/api/dashboard/me"');
    expect(highlighted).not.toContain('href="javascript:alert"');
  });

  it("does not autolink bare URLs inside ignored markdown destinations", () => {
    const text =
      "Ignore [local](/api/dashboard/https://internal.example), [bad](javascript:https://unsafe.example), and keep https://safe.example.";

    expect(
      findTranscriptMarkdownLinks(text).map(({ href, label }) => ({
        href,
        label,
      })),
    ).toEqual([
      {
        href: "https://safe.example",
        label: "https://safe.example",
      },
    ]);
  });
});
