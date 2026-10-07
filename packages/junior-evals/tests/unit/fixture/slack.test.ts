import { describe, expect, it } from "vitest";
import { installSlackMock } from "@junior-evals/fixture/slack";

async function conversationsInfo(channel: string): Promise<{
  status: number;
  body: { ok?: boolean; channel?: { topic?: { value?: string } } };
}> {
  const response = await fetch("https://slack.com/api/conversations.info", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ channel }).toString(),
  });
  return { status: response.status, body: await response.json() };
}

describe("Slack mock", () => {
  it("answers conversations.info for channels with and without fixture info", async () => {
    const slack = installSlackMock();
    slack.setChannelInfo("CHINTS", { topic: "ALL CAPS TYPING ONLY" });

    // A channel without fixture info falls through to the shared handler,
    // which must still read the request body.
    const plain = await conversationsInfo("CPLAIN");
    expect(plain.status).toBe(200);
    expect(plain.body.ok).toBe(true);

    const hinted = await conversationsInfo("CHINTS");
    expect(hinted.status).toBe(200);
    expect(hinted.body.channel?.topic?.value).toBe("ALL CAPS TYPING ONLY");
  });
});
