import type {
  SpaceDetailReport,
  SpaceSummary,
  SpaceTreeReport,
} from "@sentry/junior/api/schema";
import { NOW_MS } from "./fixtures";

const HOUR_MS = 60 * 60 * 1000;

function iso(hoursAgo: number): string {
  return new Date(NOW_MS - hoursAgo * HOUR_MS).toISOString();
}

const SPACES: SpaceSummary[] = [
  {
    spaceId: "space-sdks",
    parentSpaceId: null,
    name: "SDKs",
    description: "Client SDKs, their releases, and platform support.",
    path: ["SDKs"],
    childCount: 2,
    conversationCount: 1,
    totalConversationCount: 5,
    lastActivityAt: iso(1),
  },
  {
    spaceId: "space-sdks-javascript",
    parentSpaceId: "space-sdks",
    name: "JavaScript",
    description: "The JavaScript SDK family, including framework integrations.",
    path: ["SDKs", "JavaScript"],
    childCount: 1,
    conversationCount: 2,
    totalConversationCount: 3,
    lastActivityAt: iso(1),
  },
  {
    spaceId: "space-sdks-javascript-cloudflare",
    parentSpaceId: "space-sdks-javascript",
    name: "Cloudflare",
    description: "Cloudflare Workers and Pages support in the JavaScript SDK.",
    path: ["SDKs", "JavaScript", "Cloudflare"],
    childCount: 0,
    conversationCount: 1,
    totalConversationCount: 1,
    lastActivityAt: iso(1),
  },
  {
    spaceId: "space-sdks-python",
    parentSpaceId: "space-sdks",
    name: "Python",
    description: "The Python SDK and its integrations.",
    path: ["SDKs", "Python"],
    childCount: 0,
    conversationCount: 1,
    totalConversationCount: 1,
    lastActivityAt: iso(30),
  },
  {
    spaceId: "space-incidents",
    parentSpaceId: null,
    name: "Incidents",
    description: "Production incidents, their triage, and follow-up work.",
    path: ["Incidents"],
    childCount: 0,
    conversationCount: 2,
    totalConversationCount: 2,
    lastActivityAt: iso(5),
  },
  {
    spaceId: "space-junior",
    parentSpaceId: null,
    name: "Junior",
    description: "Building and operating Junior itself.",
    path: ["Junior"],
    childCount: 0,
    conversationCount: 0,
    totalConversationCount: 0,
    lastActivityAt: null,
  },
];

/** Mock Space tree for local dashboard development. */
export function readMockSpaceTree(): SpaceTreeReport {
  return { spaces: SPACES };
}

/** Mock Space detail for local dashboard development. */
export function readMockSpaceDetail(
  spaceId: string,
): SpaceDetailReport | undefined {
  const space = SPACES.find((candidate) => candidate.spaceId === spaceId);
  if (!space) return undefined;
  const breadcrumbs = space.path.slice(0, -1).map((name) => {
    const ancestor = SPACES.find((candidate) => candidate.name === name)!;
    return { spaceId: ancestor.spaceId, name };
  });
  return {
    space,
    breadcrumbs,
    children: SPACES.filter((candidate) => candidate.parentSpaceId === spaceId),
    conversations:
      space.totalConversationCount === 0
        ? []
        : [
            {
              conversationId: "slack:CQA123:1770003600.000200",
              spaceId,
              title: "Cloudflare SDK release is blocked on a flaky test",
              channelName: "proj-sdk-javascript",
              summary:
                "The team traced the flaky Workers test to a timer mock and chose to release after the fix merged.",
              lastActivityAt: iso(1),
            },
            {
              conversationId: "slack:CQA123:1770000000.000100",
              spaceId,
              title: "Why are source maps missing for Pages deployments?",
              channelName: "discuss-sdks",
              summary:
                "Source maps upload before the Pages build writes them. The fix moves the upload to a post-build step.",
              lastActivityAt: iso(26),
            },
          ],
    privateConversationCount: space.totalConversationCount > 2 ? 1 : 0,
  };
}
