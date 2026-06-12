import type { Destination } from "@sentry/junior-plugin-api";
import type { AssistantReplyRequestContext } from "@/chat/respond";
import type { Requester } from "@/chat/requester";

export const TEST_SLACK_DESTINATION = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} as const satisfies Destination;

export const TEST_SLACK_REQUESTER = {
  platform: "slack",
  teamId: TEST_SLACK_DESTINATION.teamId,
  userId: "U123",
} as const satisfies Requester;

type LegacyRequester = {
  email?: string;
  fullName?: string;
  userId: string;
  userName?: string;
};

export type TestReplyRequestContext = Omit<
  Partial<AssistantReplyRequestContext>,
  "destination" | "requester"
> & {
  destination?: Destination;
  requester?: Requester | LegacyRequester;
};

function requesterForDestination(
  requester: Requester | LegacyRequester | undefined,
  destination: Destination,
): Requester {
  if (requester && "platform" in requester) {
    return requester;
  }
  if (destination.platform === "local") {
    return {
      platform: "local",
      userId: requester?.userId ?? TEST_SLACK_REQUESTER.userId,
      ...(requester?.email ? { email: requester.email } : {}),
      ...(requester?.fullName ? { fullName: requester.fullName } : {}),
      ...(requester?.userName ? { userName: requester.userName } : {}),
    };
  }
  return {
    platform: "slack",
    teamId: destination.teamId,
    userId: requester?.userId ?? TEST_SLACK_REQUESTER.userId,
    ...(requester?.email ? { email: requester.email } : {}),
    ...(requester?.fullName ? { fullName: requester.fullName } : {}),
    ...(requester?.userName ? { userName: requester.userName } : {}),
  };
}

/** Build a complete reply request context for runtime component tests. */
export function makeTestReplyContext(
  options: TestReplyRequestContext = {},
): AssistantReplyRequestContext {
  const destination = options.destination ?? TEST_SLACK_DESTINATION;
  return {
    ...options,
    destination,
    requester: requesterForDestination(options.requester, destination),
  } as AssistantReplyRequestContext;
}
