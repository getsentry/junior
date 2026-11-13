import {
  conversationObjectCard,
  messageObjectCard,
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

// The mock release thread links to one Slack message.
const SLACK_MESSAGE_PATH = "/archives/CQA456/p1770021700000100";

function mockObject(href: string): ObjectLinksReport["objects"][number][] {
  if (!URL.canParse(href)) return [];
  const url = new URL(href);
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
