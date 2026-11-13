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

// The mock release thread links to one Google Doc and one Calendar event.
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
  if (url.hostname === "acme.sentry.io" && url.pathname === SENTRY_ISSUE_PATH) {
    return [{ object: { ...SENTRY_ISSUE, url: href }, url: href }];
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
