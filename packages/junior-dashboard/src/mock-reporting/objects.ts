import {
  conversationObjectCard,
  messageObjectCard,
  personObjectCard,
  webPageObjectCard,
  type AttachObjectLinkResponse,
  type ObjectLinksReport,
} from "@sentry/junior/api/schema";
import type { OwnedObjectAnnotation } from "@sentry/junior-plugin-api";
import {
  addMockAnnotation,
  readMockConversationDetail,
  readMockPeopleDirectory,
} from "./fixtures";

// Return the decoded segment after `/{page}/`, on any host: mocks have no
// configured dashboard origin.
function pageSegment(url: URL, page: string): string | undefined {
  const match = new RegExp(`^/${page}/([^/]+)/?$`).exec(url.pathname);
  return match ? decodeURIComponent(match[1]!) : undefined;
}

// The mock release thread links to one Google Doc, one Calendar event, and
// one Drive file and folder.
const GOOGLE_OBJECTS: Record<string, Omit<OwnedObjectAnnotation, "url">> = {
  "/document/d/1MockReleaseChecklist_0123456789/edit": {
    kind: "object",
    objectType: "document",
    key: "1MockReleaseChecklist_0123456789",
    label: "Release 4.2 checklist",
    title: "Release 4.2 checklist",
    displayType: "Google Doc",
    facts: {
      type: "document",
      summary:
        "Run these steps in order before the 4.2 release. Each owner checks their step, and the release lead signs off in the go/no-go meeting.",
      owner: "Morgan Lee",
      modifiedAt: "2026-02-02T08:15:00.000Z",
    },
    plugin: "google",
  },
  "/file/d/1MockReleaseMetricsPdf_0123456789/view": {
    kind: "object",
    objectType: "document",
    key: "1MockReleaseMetricsPdf_0123456789",
    label: "Release 4.2 metrics.pdf",
    title: "Release 4.2 metrics.pdf",
    displayType: "PDF",
    facts: {
      type: "document",
      owner: "Morgan Lee",
      modifiedAt: "2026-02-02T07:40:00.000Z",
      thumbnailUrl:
        "/api/images/mock-release-metrics.thumbnail?w=640&v=1770018000000",
    },
    plugin: "google",
  },
  "/drive/folders/1MockReleaseAssets_0123456789": {
    kind: "object",
    objectType: "document",
    key: "1MockReleaseAssets_0123456789",
    label: "Release 4.2 assets",
    title: "Release 4.2 assets",
    displayType: "Google Drive folder",
    facts: {
      type: "document",
      owner: "Morgan Lee",
      modifiedAt: "2026-02-01T18:05:00.000Z",
    },
    plugin: "google",
  },
  "/calendar/event": {
    kind: "object",
    objectType: "calendar_event",
    key: "rel42gonogo",
    label: "Release 4.2 go/no-go",
    title: "Release 4.2 go/no-go",
    facts: {
      type: "calendar_event",
      summary:
        "Decide go or no-go for 4.2. Bring the open risk list and the checklist status.",
      when: "Mon, Feb 2, 15:00 – 15:30 PST",
    },
    plugin: "google",
  },
};
// The mock release thread links to one Sentry issue.
const SENTRY_ISSUE: Omit<OwnedObjectAnnotation, "url"> = {
  kind: "object",
  objectType: "task",
  key: "acme/4567",
  label: "JUNIOR-3ZK",
  title: "TypeError: cart.total is undefined",
  displayType: "Sentry issue",
  status: "unresolved",
  description: "1,234 events, 56 users",
  facts: {
    type: "task",
    summary: "app/checkout.ts in submitOrder",
    assignees: ["Morgan Lee"],
    priority: "High",
    project: "junior",
    labels: ["error", "regressed"],
    trend: {
      label: "Events, last 24 hours",
      points: [
        2, 1, 0, 0, 1, 3, 2, 4, 3, 2, 5, 4, 3, 6, 8, 5, 4, 12, 30, 52, 47, 61,
        44, 38,
      ],
    },
  },
  plugin: "sentry",
};
const SENTRY_ISSUE_PATH = "/issues/JUNIOR-3ZK/";

// The mock release thread links to one Sentry Explore chart: p95 span
// duration of the top span operations, in five-minute buckets.
function wave(base: number, spike: number): number[] {
  return Array.from({ length: 48 }, (_, index) => {
    const ramp = index > 30 ? spike * Math.min(1, (index - 30) / 4) : 0;
    return Math.round(base + 6 * Math.sin(index / 3) + ramp);
  });
}
const SENTRY_CHART: Omit<OwnedObjectAnnotation, "url"> = {
  kind: "object",
  objectType: "chart",
  key: "chart:5f0c2a9e41d7b3c8a6e2f1d09b7c4a35",
  label: "Explore traces",
  title: "p95(span.duration) by span.op",
  displayType: "Explore traces",
  facts: {
    type: "chart",
    display: "line",
    yAxis: "p95(span.duration)",
    range: "Last 24 hours",
    series: [
      { label: "http.client", points: wave(180, 240) },
      { label: "db", points: wave(90, 40) },
      { label: "cache.get", points: wave(30, 5) },
    ],
  },
  plugin: "sentry",
};
const SENTRY_CHART_PATH = "/explore/traces/";

// The mock release thread links to one Sentry trace: a checkout request
// whose payment call failed.
const SENTRY_TRACE_ID = "a8c0e1b2d3f4a5b6c7d8e9f0a1b2c3d4";
const SENTRY_TRACE: Omit<OwnedObjectAnnotation, "url"> = {
  kind: "object",
  objectType: "trace",
  key: `trace:acme/${SENTRY_TRACE_ID}`,
  label: SENTRY_TRACE_ID.slice(0, 8),
  title: "POST /api/checkout",
  displayType: "Sentry trace",
  facts: {
    type: "trace",
    rootOp: "http.server",
    rootName: "POST /api/checkout",
    durationMs: 2430,
    spanCount: 186,
    errorCount: 2,
    performanceIssueCount: 1,
    projects: ["storefront", "checkout-api", "payments"],
    spans: [
      {
        op: "http.server",
        name: "POST /api/checkout",
        startMs: 0,
        durationMs: 2430,
      },
      { op: "middleware", name: "authenticate", startMs: 4, durationMs: 38 },
      {
        op: "db",
        name: "SELECT * FROM carts WHERE id = %s",
        startMs: 45,
        durationMs: 120,
      },
      { op: "cache.get", name: "cart:totals", startMs: 170, durationMs: 6 },
      {
        op: "db",
        name: "SELECT * FROM cart_items WHERE cart_id = %s",
        startMs: 180,
        durationMs: 410,
        issue: true,
      },
      {
        op: "http.client",
        name: "POST https://payments.internal/charge",
        startMs: 600,
        durationMs: 1480,
        issue: true,
      },
      {
        op: "queue.publish",
        name: "orders.created",
        startMs: 2090,
        durationMs: 55,
      },
      {
        op: "serialize",
        name: "CheckoutResponse",
        startMs: 2150,
        durationMs: 260,
      },
    ],
  },
  plugin: "sentry",
};
const SENTRY_TRACE_PATH = `/explore/traces/trace/${SENTRY_TRACE_ID}/`;

// The mock release thread links to one Notion page, inline and alone on
// its line.
const NOTION_PAGE_ID = "4f2a9c1e7b3d4e5fa6b7c8d9e0f1a2b3";
const NOTION_PAGE: Omit<OwnedObjectAnnotation, "url"> = {
  kind: "object",
  objectType: "document",
  key: NOTION_PAGE_ID,
  label: "🚀 Release 4.2 launch plan",
  title: "🚀 Release 4.2 launch plan",
  displayType: "Notion page",
  sourceUpdatedAt: "2026-02-02T09:30:00.000Z",
  facts: {
    type: "document",
    summary:
      "Ship 4.2 to every team by Friday. Support gets the release notes a day early, and marketing posts the blog after the deploy finishes.",
    modifiedAt: "2026-02-02T09:30:00.000Z",
    thumbnailUrl: `/api/images/mock-notion-cover.signature?w=640&v=1770024600000`,
  },
  plugin: "notion",
};

/** The mock photo path for the one mock person who has a photo. */
const MOCK_AVATAR_PATH = "/api/people/avatars/mock-morgan";

/** A round initials photo, so person links show a photo in mock mode. */
export const MOCK_AVATAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#7c3aed"/><text x="32" y="41" fill="#fff" font-family="sans-serif" font-size="26" font-weight="600" text-anchor="middle">ML</text></svg>`;

// The mock release thread links to one Slack message.
const SLACK_MESSAGE_PATH = "/archives/CQA456/p1770021700000100";

// The mock release thread links to one oEmbed video and one blog post. The
// mock image route serves every thumbnail.
const MOCK_THUMBNAIL_URL = "/api/images/mock-thumbnail.signature?w=640";
const WEB_PAGES: Record<string, Parameters<typeof webPageObjectCard>[0]> = {
  "https://www.youtube.com/watch?v=MockLaunchDemo": {
    author: "Sentry",
    media: "video",
    siteName: "YouTube",
    thumbnailUrl: MOCK_THUMBNAIL_URL,
    title: "Junior 4.2 launch demo",
    url: "https://www.youtube.com/watch?v=MockLaunchDemo",
  },
  "https://blog.example.com/posts/release-4-2": {
    author: "Morgan Lee",
    description:
      "Release 4.2 adds cards for Slack messages, Google Docs, and any public web page.",
    siteName: "Example Blog",
    thumbnailUrl: MOCK_THUMBNAIL_URL,
    title: "What's new in Release 4.2",
    url: "https://blog.example.com/posts/release-4-2",
  },
};

function mockObject(href: string): ObjectLinksReport["objects"][number][] {
  if (!URL.canParse(href)) return [];
  const url = new URL(href);
  const webPage = WEB_PAGES[url.href];
  if (webPage) {
    const object = webPageObjectCard(webPage);
    return [{ object: { ...object, plugin: "junior" }, url: href }];
  }
  const google = url.hostname.endsWith(".google.com")
    ? GOOGLE_OBJECTS[url.pathname]
    : undefined;
  if (google) return [{ object: { ...google, url: href }, url: href }];
  if (
    url.hostname === "www.notion.so" &&
    url.pathname.endsWith(`-${NOTION_PAGE_ID}`)
  ) {
    return [{ object: { ...NOTION_PAGE, url: href }, url: href }];
  }
  if (url.hostname === "acme.sentry.io" && url.pathname === SENTRY_ISSUE_PATH) {
    return [{ object: { ...SENTRY_ISSUE, url: href }, url: href }];
  }
  if (url.hostname === "acme.sentry.io" && url.pathname === SENTRY_CHART_PATH) {
    return [{ object: { ...SENTRY_CHART, url: href }, url: href }];
  }
  if (url.hostname === "acme.sentry.io" && url.pathname === SENTRY_TRACE_PATH) {
    return [{ object: { ...SENTRY_TRACE, url: href }, url: href }];
  }
  if (url.hostname.endsWith(".slack.com")) {
    if (url.pathname !== SLACK_MESSAGE_PATH) return [];
    const object = messageObjectCard({
      author: "Morgan Lee",
      channel: "#proj-release",
      key: "slack:TQA:CQA456:1770021700.000100",
      sentAt: new Date(1770021700_000).toISOString(),
      text: "Release notes are ready for review. Ping me before the train leaves at 3 PM, and I will hold the payments deploy until the pin lands.",
      url: href,
    });
    return [{ object: { ...object, plugin: "junior" }, url: href }];
  }
  const conversationId = pageSegment(url, "conversations");
  const detail = conversationId
    ? readMockConversationDetail(conversationId)
    : undefined;
  // Match the API: a private Conversation resolves only for a participant.
  if (detail && (detail.visibility !== "private" || detail.isParticipant)) {
    const object = conversationObjectCard({
      brief: detail.brief?.content.summary,
      participants: detail.participants ?? [],
      summary: detail,
      url: href,
    });
    return [{ object: { ...object, plugin: "junior" }, url: href }];
  }
  const email =
    url.protocol === "mailto:"
      ? decodeURIComponent(url.pathname)
      : pageSegment(url, "people");
  // The directory read is slow, so read it only for a person link.
  if (!email) return [];
  const person = readMockPeopleDirectory().people.find(
    (candidate) => candidate.actor.email === email.toLowerCase(),
  );
  if (!person) return [];
  const morgan = person.actor.email === "dev@example.com";
  const object = personObjectCard({
    // One mock person has a linked GitHub account and a photo.
    ...(morgan ? { githubHandle: "dev-example" } : undefined),
    person: morgan
      ? { ...person.actor, avatarUrl: MOCK_AVATAR_PATH }
      : person.actor,
    url: href,
  });
  return [{ object: { ...object, plugin: "junior" }, url: href }];
}

/** Resolve mock links to the cards that the API would show. */
export function readMockObjectLinks(
  urls: readonly string[],
): ObjectLinksReport {
  return { objects: [...new Set(urls)].flatMap(mockObject) };
}

/**
 * Attach a mock link to a Conversation, like the attach API. Mocks have one
 * viewer, so only the object must resolve.
 */
export function attachMockObjectLink(
  conversationId: string,
  url: string,
): AttachObjectLinkResponse | undefined {
  const detail = readMockConversationDetail(conversationId);
  const object = mockObject(url)[0]?.object;
  if (!detail || !object || object.objectType === "person") return undefined;
  // Match the API: another link to the same object is a duplicate too.
  if (
    detail.annotations?.some(
      (annotation) =>
        annotation.url === url ||
        (annotation.plugin === object.plugin && annotation.key === object.key),
    )
  ) {
    return { status: "unchanged" };
  }
  const now = new Date().toISOString();
  addMockAnnotation(conversationId, {
    kind: "resource_link",
    key: object.key,
    label: url,
    objectType: object.objectType,
    plugin: object.plugin,
    url,
    createdAt: now,
    updatedAt: now,
  });
  return { status: "attached" };
}
