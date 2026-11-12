import {
  conversationObjectCard,
  personObjectCard,
  type ObjectLinksReport,
} from "@sentry/junior/api/schema";
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

function mockObject(href: string): ObjectLinksReport["objects"][number][] {
  if (!URL.canParse(href)) return [];
  const url = new URL(href);
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
