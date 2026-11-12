import {
  conversationObjectCard,
  personObjectCard,
  type ObjectLinksReport,
} from "@sentry/junior/api/schema";
import type { OwnedObjectAnnotation } from "@sentry/junior-plugin-api";
import {
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
    facts: { type: "calendar_event", when: "Mon, Feb 2, 15:00 – 15:30 PST" },
    plugin: "google",
  },
};

function mockObject(href: string): ObjectLinksReport["objects"][number][] {
  if (!URL.canParse(href)) return [];
  const url = new URL(href);
  const google = url.hostname.endsWith(".google.com")
    ? GOOGLE_OBJECTS[url.pathname]
    : undefined;
  if (google) return [{ object: { ...google, url: href }, url: href }];
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
  const object = personObjectCard({
    // One mock person has a linked GitHub account, to show the handle.
    ...(person.actor.email === "dev@example.com"
      ? { githubHandle: "dev-example" }
      : undefined),
    person: person.actor,
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
