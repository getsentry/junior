# Slack MSW Test Authoring Playbook

Use this playbook for new Slack integration tests in `tests/`.

## Preconditions

- Global MSW lifecycle is already wired in Vitest via `tests/msw/setup.ts`.
- Slack host unhandled requests fail by default.
- `SLACK_BOT_TOKEN` is set in global setup; tests can override locally if needed.

## Minimal test workflow

1. Import the real module under test.
2. Queue Slack endpoint responses with `queueSlackApiResponse(...)`.
3. Execute the real module function.
4. Assert returned result.
5. Assert captured outbound request payload with `getCapturedSlackApiCalls(...)`.

## Canonical template

```ts
import { describe, it, expect } from "vitest";
import { queueSlackApiResponse, getCapturedSlackApiCalls } from "./msw/handlers/slack-api";
import { chatPostMessageOk } from "./fixtures/slack/factories/api";
import { postMessageToChannel } from "@/chat/slack-actions/channel";

describe("postMessageToChannel", () => {
  it("posts to Slack with expected payload", async () => {
    queueSlackApiResponse("chat.postMessage", {
      body: chatPostMessageOk({ ts: "1700000000.200", channel: "C123" })
    });

    const result = await postMessageToChannel({ channelId: "C123", text: "hello" });

    expect(result.ts).toBe("1700000000.200");

    const calls = getCapturedSlackApiCalls("chat.postMessage");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toMatchObject({
      channel: "C123",
      text: "hello",
      mrkdwn: "true"
    });
  });
});
```

## Error and retry scenarios

Use these helpers from `tests/msw/handlers/slack-api.ts`:

- `queueSlackApiError(method, { error, needed, provided, status, headers })`
- `queueSlackRateLimit(method, retryAfterSeconds, body)`

Use these when validating error mapping and retry behavior in `withSlackRetries` code paths.

## Request assertion checklist

- Correct Slack method endpoint used.
- Required arguments present and correctly typed.
- Method-specific payload shape matches module contract.
- Expected number of calls made (single vs retries vs pagination).

## File upload checklist

For `filesUploadV2` paths, assert all three legs:

1. `files.getUploadURLExternal`
2. `https://files.slack.com/upload/...`
3. `files.completeUploadExternal`

Use `getCapturedSlackFileUploadCalls()` for external upload assertions.
