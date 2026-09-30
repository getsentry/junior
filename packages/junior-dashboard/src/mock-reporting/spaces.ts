import type {
  ActorIdentity,
  SpaceConversation,
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
    description: "sdk releases, platform support, integrations",
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
    description: "sentry-javascript, browser, node, frameworks",
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
    description: "workers, pages, source maps",
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
    description: "sentry-python, django, celery",
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
    description: "outages, triage, postmortems",
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
    description: "getsentry/junior, spaces, briefs, backfills",
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

function person(slackUserName: string, fullName: string): ActorIdentity {
  return { email: `${slackUserName}@sentry.io`, fullName, slackUserName };
}

const MORGAN = person("morgan", "Morgan Lee");
const AVERY = person("avery", "Avery Chen");
const RILEY = person("riley", "Riley Park");

function pullRequest(
  repository: string,
  number: number,
  status: "open" | "merged" | "closed",
  hoursAgo: number,
): NonNullable<SpaceConversation["annotations"]>[number] {
  return {
    kind: "resource_link",
    key: `${repository}#${number}`,
    label: `${repository}#${number}`,
    objectType: "code_change",
    plugin: "github",
    status,
    url: `https://github.com/${repository}/pull/${number}`,
    createdAt: iso(hoursAgo + 2),
    updatedAt: iso(hoursAgo),
  };
}

function spaceConversation(
  spaceId: string,
  input: {
    conversationId: string;
    title: string;
    channelName: string;
    kind: SpaceConversation["kind"];
    hoursAgo: number;
    participants: ActorIdentity[];
    annotations?: SpaceConversation["annotations"];
  },
): SpaceConversation {
  return {
    conversationId: input.conversationId,
    displayTitle: input.title,
    cumulativeDurationMs: 90_000,
    isParticipant: false,
    visibility: "public",
    status: "completed",
    startedAt: iso(input.hoursAgo + 1),
    lastSeenAt: iso(input.hoursAgo),
    lastProgressAt: iso(input.hoursAgo),
    surface: "slack",
    channel: input.conversationId.split(":")[1],
    channelName: input.channelName,
    actorIdentity: input.participants[0],
    participants: input.participants,
    ...(input.annotations ? { annotations: input.annotations } : undefined),
    spaceId,
    kind: input.kind,
  };
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
  const empty = space.totalConversationCount === 0;
  const conversations = empty
    ? []
    : [
        spaceConversation(spaceId, {
          conversationId: "slack:CQA123:1770003600.000200",
          title: "Cloudflare SDK release is blocked on a flaky test",
          channelName: "#proj-sdk-javascript",
          kind: "bug",
          hoursAgo: 1,
          participants: [MORGAN, AVERY, RILEY],
          annotations: [
            pullRequest("getsentry/sentry-javascript", 15321, "merged", 1),
          ],
        }),
        spaceConversation(spaceId, {
          conversationId: "slack:CQA123:1770001800.000150",
          title: "Add a D1 query integration for Workers",
          channelName: "proj-sdk-javascript",
          kind: "feature",
          hoursAgo: 6,
          participants: [AVERY, MORGAN],
          annotations: [
            pullRequest("getsentry/sentry-javascript", 15340, "open", 6),
          ],
        }),
        spaceConversation(spaceId, {
          conversationId: "slack:CQA123:1770000000.000100",
          title: "Why are source maps missing for Pages deployments?",
          channelName: "discuss-sdks",
          kind: "question",
          hoursAgo: 26,
          participants: [RILEY],
        }),
      ];
  return {
    space,
    breadcrumbs,
    children: SPACES.filter((candidate) => candidate.parentSpaceId === spaceId),
    facts: empty
      ? {
          participants: [],
          kinds: [],
        }
      : {
          participants: [MORGAN, AVERY, RILEY],
          kinds: [
            { kind: "bug", conversationCount: 1 },
            { kind: "feature", conversationCount: 1 },
            { kind: "question", conversationCount: 1 },
          ],
        },
    conversations,
    privateConversationCount: space.totalConversationCount > 2 ? 1 : 0,
  };
}
