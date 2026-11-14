import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { dashboardCoreQueryOptions } from "../src/client/api";
import {
  DisplayText,
  KnownObjectsProvider,
} from "../src/client/display-text/DisplayText";
import {
  splitStandaloneUrls,
  textHasStandaloneUrl,
} from "../src/client/display-text/knownObjects";
import { displayPlainText } from "../src/client/display-text/plainText";
import type { DashboardCoreData } from "../src/client/types";

// Links can ask the API for cards, so display text needs a query client.
// A viewer email seeds the signed-in person that mentions compare against.
function markup(children: ReactNode, viewerEmail?: string) {
  const client = new QueryClient();
  if (viewerEmail) {
    client.setQueryData(dashboardCoreQueryOptions().queryKey, {
      me: { user: { email: viewerEmail } },
    } as DashboardCoreData);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  );
}

function renderedLinks(text: string) {
  const html = markup(<DisplayText text={text} />);
  return {
    html,
    links: [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g)].map(
      // Drop the outbound icon so labels compare as text.
      ([, href, label]) => ({
        href,
        label: label?.replace(/<svg.*<\/svg>/, ""),
      }),
    ),
  };
}

describe("display text links", () => {
  it("links safe destinations and keeps only the label of unsafe ones", () => {
    const { html, links } = renderedLinks(
      'See [trace](https://sentry.example/trace), https://docs.example/path)., [local](/api/me), [titled](https://docs.example/titled "Docs"), [bad](javascript:https://unsafe.example), [data](data:text/html,hi), and ![pixel](javascript:alert(1)).',
    );

    expect(links).toEqual([
      { href: "https://sentry.example/trace", label: "trace" },
      {
        href: "https://docs.example/path",
        label: "https://docs.example/path",
      },
      { href: "https://docs.example/titled", label: "titled" },
    ]);
    expect(html).not.toMatch(/javascript:|data:|\/api\/me|<img/);
    expect(html).toContain("local");
    expect(html).toContain("bad");
    expect(html).toContain("pixel");
  });

  it("renders CommonMark autolinks without their angle-bracket syntax", () => {
    const { links } = renderedLinks(
      "See <https://docs.example/path> and <mailto:team@example.com>, but keep `<https://literal.example>` literal.",
    );

    expect(links).toEqual([
      {
        href: "https://docs.example/path",
        label: "https://docs.example/path",
      },
      { href: "mailto:team@example.com", label: "mailto:team@example.com" },
    ]);
  });

  it("does not let malformed nested labels swallow later valid links", () => {
    const { links } = renderedLinks(
      "See [broken [real](https://nested.example/ok).",
    );

    expect(links).toEqual([
      { href: "https://nested.example/ok", label: "real" },
    ]);
  });

  it("leaves links inside inline code and escaped link syntax literal", () => {
    const { html, links } = renderedLinks(
      "Use `[syntax](https://example.com)` and ``https://bare.example``, keep \\[literal](https://literal.example), but link [real](https://real.example) plus https://bare-real.example.",
    );

    // GFM still links the bare URL inside escaped link syntax, as GitHub does.
    expect(links).toEqual([
      {
        href: "https://literal.example",
        label: "https://literal.example",
      },
      { href: "https://real.example", label: "real" },
      {
        href: "https://bare-real.example",
        label: "https://bare-real.example",
      },
    ]);
    expect(html).toContain("[syntax](https://example.com)");
    expect(html).toContain("https://bare.example");
    expect(html).toContain("[literal](");
  });

  it("does not autolink bare URLs inside dropped link destinations", () => {
    const { links } = renderedLinks(
      "Ignore [local](/api/internal/https://internal.example), [bad](javascript:https://unsafe.example), and keep https://safe.example.",
    );

    expect(links).toEqual([
      { href: "https://safe.example", label: "https://safe.example" },
    ]);
  });

  it("keeps emphasis markers outside bare URLs", () => {
    expect(renderedLinks("see https://example.com**bold** here").links).toEqual(
      [{ href: "https://example.com", label: "https://example.com" }],
    );
    expect(renderedLinks("see <https://example.com/a*b> here").links).toEqual([
      { href: "https://example.com/a*b", label: "https://example.com/a*b" },
    ]);
  });
});

describe("display text tokens", () => {
  const mentions = [{ fullName: "Junior", slackUserId: "U0BOT" }];
  const text =
    "**Done** :smile: <@U0BOT> see <https://example.com/pr|the PR> :wave::skin-tone-3: :custom_parrot:";

  it("renders Slack mentions, links, and emoji the same way in each mode", () => {
    const block = markup(<DisplayText mentions={mentions} text={text} />);
    const inline = markup(
      <DisplayText inline mentions={mentions} text={text} />,
    );

    for (const html of [block, inline]) {
      expect(html).toContain("<strong");
      expect(html).toContain("@Junior");
      expect(html).toContain("😄");
      expect(html).toContain("👋🏼");
      // Workspace emoji are not in the dataset, so they stay as text.
      expect(html).toContain(":custom_parrot:");
      expect(html).toContain("the PR");
      expect(html).not.toContain("U0BOT&gt;");
    }
    expect(block).toContain('href="https://example.com/pr"');
    // Inline text can sit in a button or a card link, so it has no links.
    expect(inline).not.toContain("<a ");
    expect(inline).not.toMatch(/<(p|div|ul|li|h\d)[\s>]/);
  });

  it("keeps emoji codes literal inside code", () => {
    const html = markup(<DisplayText text="Use `:smile:`." />);

    expect(html).toContain(":smile:");
    expect(html).not.toContain("😄");
  });

  it("returns the same names and emoji as plain text", () => {
    expect(displayPlainText(text, mentions)).toBe(
      "Done 😄 @Junior see the PR 👋🏼 :custom_parrot:",
    );
  });
});

describe("display text object links", () => {
  const PR = "https://github.com/acme/app/pull/7";
  const PERSON = "https://junior.example.com/people/dev%40example.com";
  const NO_PHOTO_PERSON = "https://junior.example.com/people/ada%40example.com";
  const PHOTO = "/api/people/avatars/dev";
  const CONVERSATION = "https://junior.example.com/conversations/slack%3AC1";
  const DOC = "https://docs.google.com/document/d/doc1/edit";
  const MESSAGE = "https://acme.slack.com/archives/C1/p1770021700000100";
  const PAGE = "https://blog.example.com/posts/release";
  const VIDEO = "https://www.youtube.com/watch?v=demo";
  const saved = {
    createdAt: "2026-08-07T08:00:00.000Z",
    kind: "object" as const,
    updatedAt: "2026-08-07T08:00:00.000Z",
  };
  const annotations = [
    {
      ...saved,
      displayType: "Pull request",
      key: "acme/app#7",
      label: "acme/app#7",
      objectType: "code_change" as const,
      plugin: "github",
      status: "open",
      title: "Retry checkout writes",
      url: PR,
    },
    {
      ...saved,
      displayType: "Person",
      facts: {
        type: "person" as const,
        avatarUrl: PHOTO,
        email: "dev@example.com",
      },
      key: "dev@example.com",
      label: "Morgan Lee",
      objectType: "person" as const,
      plugin: "junior",
      title: "Morgan Lee",
      url: PERSON,
    },
    {
      ...saved,
      displayType: "Person",
      facts: { type: "person" as const, email: "ada@example.com" },
      key: "ada@example.com",
      label: "Ada Park",
      objectType: "person" as const,
      plugin: "junior",
      title: "Ada Park",
      url: NO_PHOTO_PERSON,
    },
    {
      ...saved,
      displayType: "Conversation",
      key: "slack:C1",
      label: "Investigate checkout latency",
      objectType: "conversation" as const,
      plugin: "junior",
      status: "running",
      title: "Investigate checkout latency",
      url: CONVERSATION,
    },
    {
      ...saved,
      displayType: "Google Doc",
      key: "doc1",
      label: "Release checklist",
      objectType: "document" as const,
      plugin: "google",
      title: "Release checklist",
      url: DOC,
    },
    {
      ...saved,
      displayType: "Message",
      key: "slack:C1:1770021700.000100",
      label: "#proj-release",
      objectType: "message" as const,
      plugin: "junior",
      title: "Hold the deploy until the pin lands.",
      url: MESSAGE,
    },
    {
      ...saved,
      displayType: "Web page",
      key: PAGE,
      label: "Release notes",
      objectType: "web_page" as const,
      plugin: "junior",
      title: "Release notes",
      url: PAGE,
    },
    {
      ...saved,
      displayType: "Web page",
      facts: {
        type: "web_page" as const,
        media: "video" as const,
        thumbnailUrl: "/api/images/demo.signature?w=640",
      },
      key: VIDEO,
      label: "Launch demo",
      objectType: "web_page" as const,
      plugin: "junior",
      title: "Launch demo",
      url: VIDEO,
    },
  ];

  function byUrl(url: string) {
    return annotations.find((annotation) => annotation.url === url)!;
  }

  function render(text: string, viewerEmail?: string) {
    return markup(
      <KnownObjectsProvider annotations={annotations}>
        <DisplayText text={text} />
      </KnownObjectsProvider>,
      viewerEmail,
    );
  }

  function anchors(html: string) {
    return [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g)].map(
      ([anchor, href, label]) => ({ anchor, href, label }),
    );
  }

  function cardCount(html: string, name: string) {
    return html.split(`aria-label="${name}"`).length - 1;
  }

  it("shows a bare URL in a sentence or a list as a plain link with its title", () => {
    for (const text of [`Opened ${PR} for review.`, `- ${PR}`, `> ${PR}`]) {
      const html = render(text);
      expect(anchors(html)).toEqual([
        expect.objectContaining({
          href: PR,
          label: "Retry checkout writes (#7)",
        }),
      ]);
      expect(html).not.toContain("· Open");
      expect(html).not.toContain("Last fetched");
    }
  });

  it("keeps the label of a link unless the title already is the label", () => {
    const PAGE_TITLE = `${"Long title ".repeat(30)}end`;
    const html = markup(
      <KnownObjectsProvider
        annotations={[
          { ...byUrl(PR), title: "Fix the #72 regression" },
          {
            ...byUrl(PAGE),
            label: `${PAGE_TITLE.slice(0, 255)}…`,
            title: PAGE_TITLE,
          },
          // Some sources cut the label short with no "…".
          {
            ...byUrl(DOC),
            label: PAGE_TITLE.slice(0, 256),
            title: PAGE_TITLE,
          },
        ]}
      >
        <DisplayText text={`See ${PR}, ${PAGE} and ${DOC}.`} />
      </KnownObjectsProvider>,
    );
    expect(anchors(html).map(({ label }) => label)).toEqual([
      "Fix the #72 regression (#7)",
      `${PAGE_TITLE.slice(0, 79).trimEnd()}…`,
      `${PAGE_TITLE.slice(0, 79).trimEnd()}…`,
    ]);
  });

  it("shows only plain links in a paragraph of links, and a person as a GitHub-style mention", () => {
    const html = render(
      `Next, ${PERSON} picks up ${CONVERSATION}. Track it in ${DOC}, hold: ${MESSAGE}, and read ${PAGE}`,
    );
    const [person, ...rest] = anchors(html);
    // The person is a round photo, then `@Name` as plain link text.
    expect(person).toMatchObject({ href: PERSON, label: "@Morgan Lee" });
    expect(html).toMatch(
      new RegExp(
        `<img alt="" class="[^"]*rounded-full[^"]*"[^>]* src="${PHOTO}"/><a `,
      ),
    );
    // Each label is only the title text: no icon and no status.
    expect(rest.map(({ href, label }) => ({ href, label }))).toEqual([
      { href: CONVERSATION, label: "Investigate checkout latency" },
      { href: DOC, label: "Release checklist" },
      { href: MESSAGE, label: "#proj-release" },
      { href: PAGE, label: "Release notes" },
    ]);
    for (const link of [person!, ...rest]) {
      expect(link.anchor).not.toMatch(/border|bg-/);
    }
    // No status, no outbound icon and no person icon.
    expect(html).not.toContain(" · ");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("data-self-mention");
  });

  it("marks only the viewer's own mention", () => {
    const html = render(
      `Next, ${PERSON} and ${NO_PHOTO_PERSON} pick it up.`,
      "DEV@example.com",
    );
    expect(html.match(/data-self-mention=""/g)).toHaveLength(1);
    expect(html).toMatch(
      /data-self-mention=""[^>]*><img [^>]*><a [^>]*>@Morgan Lee</,
    );

    const slack = markup(
      <MemoryRouter>
        <DisplayText
          mentions={[
            {
              avatarUrl: PHOTO,
              email: "dev@example.com",
              fullName: "Morgan Lee",
              slackUserId: "U123",
            },
          ]}
          text="Ping <@U123>."
        />
      </MemoryRouter>,
      "dev@example.com",
    );
    expect(slack).toMatch(
      /data-self-mention=""[^>]*><img [^>]*><a [^>]*>@Morgan Lee</,
    );
  });

  it("shows only the name for a person with no photo", () => {
    const html = render(`Ask ${NO_PHOTO_PERSON} first.`);
    expect(anchors(html).map(({ label }) => label)).toEqual(["@Ada Park"]);
    expect(html).not.toMatch(/<img|<svg/);
  });

  it("shows a bare URL alone in a paragraph as the full card", () => {
    for (const text of [`Done.\n\n${PR}/\n\nThanks.`, `<${PR}>`]) {
      const html = render(text);
      expect(cardCount(html, "Pull request: Retry checkout writes")).toBe(1);
      expect(html).toContain("Last fetched");
    }
  });

  // The muted line above the card title.
  function cardMeta(html: string) {
    return html.match(/<p class="m-0 mb-1 [^"]*">([^<]*)<\/p>/)?.[1];
  }

  it("shows a card for a URL of any type alone on its line", () => {
    // Core owns `junior` objects, so no card names that plugin. A web page
    // without a site name names its host.
    for (const [url, name, meta] of [
      [PERSON, "Person: Morgan Lee", "Person"],
      [
        CONVERSATION,
        "Conversation: Investigate checkout latency",
        "Conversation",
      ],
      [DOC, "Google Doc: Release checklist", "Google Doc · google"],
      [
        MESSAGE,
        "Message: Hold the deploy until the pin lands.",
        "Message · #proj-release",
      ],
      [PAGE, "Web page: Release notes", "blog.example.com"],
    ] as const) {
      const html = render(`Done.\n\n${url}`);
      expect(cardCount(html, name)).toBe(1);
      expect(cardMeta(html)).toBe(meta);
    }
  });

  it("names the site and author of a web page card", () => {
    const html = markup(
      <KnownObjectsProvider
        annotations={[
          {
            ...annotations.find((annotation) => annotation.key === PAGE)!,
            facts: {
              type: "web_page" as const,
              author: "Morgan Lee",
              siteName: "Example Blog",
            },
          },
        ]}
      >
        <DisplayText text={`Done.\n\n${PAGE}`} />
      </KnownObjectsProvider>,
    );
    expect(cardMeta(html)).toBe("Example Blog · Morgan Lee");
    // The header names them, so the facts do not repeat them.
    expect(html.split("Morgan Lee").length - 1).toBe(1);
  });

  it("shows only the thumbnail of a video alone on its line", () => {
    const html = render(`Demo:\n\n${VIDEO}`);
    expect(html).toMatch(
      /<a [^>]*href="https:\/\/www.youtube.com\/watch\?v=demo"[^>]*><img alt="Launch demo"[^>]*src="\/api\/images\/demo.signature\?w=640"/,
    );
    expect(cardCount(html, "Web page: Launch demo")).toBe(0);
  });

  it("shows one card for a URL repeated in a message", () => {
    for (const text of [
      `${PR}\n\nAgain:\n\n${PR}`,
      `${PR}\n\n\`\`\`\ncode\n\`\`\`\n\n${PR}`,
    ]) {
      const html = render(text);
      expect(cardCount(html, "Pull request: Retry checkout writes")).toBe(1);
      expect(html).toContain(">Retry checkout writes (#7)</a>");
    }
  });

  it("keeps the text of a labeled link", () => {
    const html = render(`See [the fix](${PR}).`);
    expect(html).toMatch(
      /<a [^>]*href="https:\/\/github.com\/acme\/app\/pull\/7"[^>]*>the fix/,
    );
    expect(html).not.toContain("acme/app#7");
    expect(html).not.toContain("Last fetched");
  });

  it("leaves links to unknown objects and other pages plain", () => {
    for (const url of [
      "https://github.com/acme/app/pull/8",
      `${PR}#discussion_r1`,
      `${PR}/files`,
    ]) {
      for (const text of [`See ${url} now.`, url]) {
        const html = render(text);
        expect(html).toContain(`>${url}<`);
        expect(html).not.toContain("acme/app#7");
      }
    }
  });

  it("finds a bare URL alone in a paragraph outside code fences", () => {
    expect(textHasStandaloneUrl(`Ready.\n\n${PR}`, PR)).toBe(true);
    expect(textHasStandaloneUrl(`<${PR}/>`, PR)).toBe(true);
    expect(textHasStandaloneUrl(`Ready: ${PR}`, PR)).toBe(false);
    expect(textHasStandaloneUrl(`[PR](${PR})`, PR)).toBe(false);
    expect(textHasStandaloneUrl("```\n" + PR + "\n```", PR)).toBe(false);
    expect(textHasStandaloneUrl(`Ready.\n\n    ${PR}`, PR)).toBe(false);
    expect(textHasStandaloneUrl(`Ready.\n\n\t${PR}`, PR)).toBe(false);
  });

  it("splits the bare URLs that show as cards from the prose", () => {
    const ISSUE = "https://github.com/getsentry/junior/issues/7";
    expect(
      splitStandaloneUrls(`Ready.\n\n${PR}\n\nMore: ${ISSUE}\n\n<${ISSUE}>`),
    ).toEqual({ prose: `Ready.\n\nMore: ${ISSUE}`, urls: [PR, ISSUE] });
    const fenced = "```\n" + PR + "\n\nstill code\n```";
    expect(splitStandaloneUrls(`Run:\n\n${fenced}\n\n${PR}`)).toEqual({
      prose: `Run:\n\n${fenced}`,
      urls: [PR],
    });
    expect(splitStandaloneUrls(`Ready.\n\n    ${PR}`)).toEqual({
      prose: `Ready.\n\n    ${PR}`,
      urls: [],
    });
    expect(splitStandaloneUrls(PR)).toEqual({ prose: "", urls: [PR] });
  });
});
