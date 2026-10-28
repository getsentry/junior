import { describe, expect, it } from "vitest";
import { maybeSyncAssistantTitle } from "@/chat/slack/assistant-thread/title";

/** A Slack adapter whose title call fails with each queued error first. */
function titleAdapter(failures: unknown[] = []) {
  const titles: string[] = [];
  return {
    titles,
    getSlackAdapter: () => ({
      setAssistantTitle: async (
        _channelId: string,
        _threadTs: string,
        title: string,
      ) => {
        titles.push(title);
        const failure = failures.shift();
        if (failure) throw failure;
      },
    }),
  };
}

describe("maybeSyncAssistantTitle", () => {
  it("does not try again after Slack denies the title permission", async () => {
    const slack = titleAdapter([{ data: { error: "no_permission" } }]);
    const thread = { channelId: "D0TITLEDENIED", threadTs: "1700000000.000" };

    await maybeSyncAssistantTitle({ ...thread, ...slack, title: "First" });
    await maybeSyncAssistantTitle({ ...thread, ...slack, title: "First" });

    expect(slack.titles).toEqual(["First"]);
  });

  it("tries again on a later turn after another Slack failure", async () => {
    const slack = titleAdapter([new Error("socket hang up")]);
    const thread = { channelId: "D0TITLERETRY", threadTs: "1700000000.000" };

    await maybeSyncAssistantTitle({ ...thread, ...slack, title: "First" });
    await maybeSyncAssistantTitle({ ...thread, ...slack, title: "First" });
    await maybeSyncAssistantTitle({ ...thread, ...slack, title: "First" });

    expect(slack.titles).toEqual(["First", "First"]);
  });
});
