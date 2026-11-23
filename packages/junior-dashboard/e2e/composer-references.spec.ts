import type { Page } from "@playwright/test";

import { expect, test } from "./test";
import { waitForReadPosition } from "./harness";
import { pasteText } from "./paste-text";
import { pickOption } from "./pick-option";

// A Thread the viewer takes part in. It has a nested Thread and two files.
const THREAD_ID = "junior:internal:dashboard-qa:thread";
const NESTED_THREAD_ID = "junior:internal:dashboard-qa:thread:nested";
const CHECKOUT_ID = "slack:CQA123:1770003600.000200";
const PULL_REQUEST = "https://github.com/getsentry/junior/pull/3842";

async function openThread(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/conversations/${encodeURIComponent(THREAD_ID)}`);
  const composer = page.getByRole("textbox", {
    name: "Continue this conversation",
  });
  await expect(composer).toHaveAttribute("contenteditable", "true");
  await composer.click();
  return composer;
}

// Messages and linked work that the page sends, once each response is in.
function recordWrites(page: Page) {
  const sent: string[] = [];
  const linked: string[] = [];
  page.on("requestfinished", (request) => {
    if (request.method() !== "POST") return;
    const { pathname } = new URL(request.url());
    if (pathname.endsWith("/messages")) {
      sent.push(request.postDataJSON().message);
    }
    if (pathname.endsWith("/annotations")) {
      linked.push(request.postDataJSON().url);
    }
  });
  return { linked, sent };
}

function conversationUrl(baseURL: string, id: string) {
  return `${new URL(baseURL).origin}/conversations/${encodeURIComponent(id)}`;
}

test("@ finds Conversations, Tasks and files, and links the work it sends", async ({
  page,
  dashboard,
}) => {
  const { linked, sent } = recordWrites(page);
  const composer = await openThread(page, dashboard.baseURL);
  const mentions = page.getByRole("listbox", { name: "Mentions" });

  await composer.pressSequentially("Compare @inves");
  const conversations = mentions.getByRole("group", { name: "Conversations" });
  await expect(conversations.getByRole("option").first()).toHaveText(
    /Investigate checkout latency/,
  );
  await expect(mentions).not.toHaveAttribute("aria-busy", "true");
  await composer.press("Enter");
  await expect(mentions).toBeHidden();
  await expect(composer.locator("[data-reference='conversation']")).toHaveText(
    "Investigate checkout latency",
  );

  // Only this Conversation's Threads and Tasks.
  await composer.pressSequentially("with @rech");
  const tasks = mentions.getByRole("group", { name: "Tasks" });
  await expect(tasks.getByRole("option")).toHaveText([
    /Recheck pin order in Safari/,
  ]);
  await expect(mentions).not.toHaveAttribute("aria-busy", "true");
  await composer.press("ArrowDown");
  await composer.press("ArrowUp");
  await expect(
    mentions.getByRole("option", { name: /Recheck pin order/ }),
  ).toHaveAttribute("aria-selected", "true");
  await composer.press("Tab");
  await expect(composer.locator("[data-reference='task']")).toHaveText(
    "Recheck pin order in Safari",
  );

  // Files already in this Conversation.
  await composer.pressSequentially("and @rows");
  const files = mentions.getByRole("group", { name: "Files" });
  await expect(files.getByRole("option")).toHaveText([/pinned-rows\.txt/]);
  await expect(mentions).not.toHaveAttribute("aria-busy", "true");
  await pickOption(files.getByRole("option"));
  await expect(composer.locator("[data-reference='file']")).toHaveText(
    "pinned-rows.txt",
  );

  // The same Conversation twice is linked once.
  await composer.pressSequentially("again @inves");
  await expect(conversations.getByRole("option").first()).toHaveText(
    /Investigate checkout latency/,
  );
  await expect(mentions).not.toHaveAttribute("aria-busy", "true");
  await composer.press("Enter");
  await composer.press("Enter");

  const checkout = conversationUrl(dashboard.baseURL, CHECKOUT_ID);
  const nested = conversationUrl(dashboard.baseURL, NESTED_THREAD_ID);
  await expect
    .poll(() => sent)
    .toEqual([
      `Compare <${checkout}|Investigate checkout latency> with <${nested}|Recheck pin order in Safari> and pinned-rows.txt again <${checkout}|Investigate checkout latency>`,
    ]);
  await expect(composer).toHaveText("");
  await expect.poll(() => linked.sort()).toEqual([checkout, nested].sort());

  // Work that the Conversation already links is not linked again.
  await composer.pressSequentially("one more @inves");
  await expect(conversations.getByRole("option").first()).toHaveText(
    /Investigate checkout latency/,
  );
  await expect(mentions).not.toHaveAttribute("aria-busy", "true");
  // The sent message reads the card of its link.
  const cardRead = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/objects" &&
      url.searchParams.getAll("url").join() === checkout
    );
  });
  await composer.press("Enter");
  await composer.press("Enter");
  await expect.poll(() => sent).toHaveLength(2);
  expect(linked).toHaveLength(2);
  await cardRead;
});

test("@ finds memories and sends each as a labeled link to its page", async ({
  page,
  dashboard,
}) => {
  const { linked, sent } = recordWrites(page);
  const composer = await openThread(page, dashboard.baseURL);
  const mentions = page.getByRole("listbox", { name: "Mentions" });

  // `@` takes one word, which must start a word of the memory.
  await composer.pressSequentially("Follow @runb");
  const memories = mentions.getByRole("group", { name: "Memories" });
  await expect(memories.getByRole("option")).toHaveText([
    /^Deploy runbooks live in Notion/,
  ]);
  await expect(mentions).not.toHaveAttribute("aria-busy", "true");
  await composer.press("Enter");
  await expect(mentions).toBeHidden();
  // A long memory is cut to the start of its text.
  const label =
    "Deploy runbooks live in Notion under Engineering, then Releases. Start with the rollback checklist before any productio…";
  await expect(composer).toHaveText(`Follow ${label}`);
  await composer.press("Enter");

  const memory = `${new URL(dashboard.baseURL).origin}/memories/memory-deploy-runbook`;
  await expect.poll(() => sent).toEqual([`Follow <${memory}|${label}>`]);
  await expect(composer).toHaveText("");
  // A memory is not work, so the Conversation links nothing.
  expect(linked).toEqual([]);
});

test("the active row stays put when a source above it loads", async ({
  page,
  dashboard,
}) => {
  // Hold the Conversation search, so its rows come in above the Task.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (url) => url.pathname === "/api/conversations" && url.searchParams.has("q"),
    async (route) => {
      await held;
      await route.fallback();
    },
  );
  const composer = await openThread(page, dashboard.baseURL);
  const mentions = page.getByRole("listbox", { name: "Mentions" });
  const task = mentions
    .getByRole("group", { name: "Tasks" })
    .getByRole("option", { name: /Recheck pin order/ });

  await composer.pressSequentially("@sa");
  await expect(
    mentions.getByRole("group", { name: "People" }).getByRole("option"),
  ).toHaveText([/Sam Ortiz/]);
  await expect(task).toBeVisible();
  await composer.press("ArrowDown");
  await expect(task).toHaveAttribute("aria-selected", "true");

  release();
  await expect(
    mentions.getByRole("group", { name: "Conversations" }).getByRole("option"),
  ).not.toHaveCount(0);
  await expect(mentions).not.toHaveAttribute("aria-busy", "true");
  await expect(task).toHaveAttribute("aria-selected", "true");
  await composer.press("Enter");
  await expect(composer.locator("[data-reference='task']")).toHaveText(
    "Recheck pin order in Safari",
  );
});

test("# finds pull requests and channels", async ({ page, dashboard }) => {
  const { linked, sent } = recordWrites(page);
  const composer = await openThread(page, dashboard.baseURL);
  const references = page.getByRole("listbox", { name: "References" });

  await composer.pressSequentially("See #3842");
  const pulls = references.getByRole("group", { name: "Pull requests" });
  await expect(pulls.getByRole("option")).toHaveText([
    /getsentry\/junior#3842/,
  ]);
  await expect(references).not.toHaveAttribute("aria-busy", "true");
  await composer.press("Enter");
  await expect(references).toBeHidden();
  const chip = composer.locator("[data-reference='code_change']");
  await expect(chip).toHaveText("junior#3842");
  await expect(chip).toHaveAttribute("title", "getsentry/junior#3842");

  await composer.pressSequentially("in #proj-rel");
  const channels = references.getByRole("group", { name: "Channels" });
  await expect(channels.getByRole("option")).toHaveText([/#proj-release/]);
  await expect(references).not.toHaveAttribute("aria-busy", "true");
  await composer.press("Enter");
  await expect(composer.locator("[data-reference='channel']")).toHaveText(
    "#proj-release",
  );
  // The thread ends at seq 5 when it opens. The sent message comes after it.
  const readSaved = waitForReadPosition(page, 5);
  await composer.press("Enter");

  await expect
    .poll(() => sent)
    .toEqual([
      `See <${PULL_REQUEST}|getsentry/junior#3842> in <#CQA456|proj-release>`,
    ]);
  await expect.poll(() => linked).toEqual([PULL_REQUEST]);
  await readSaved;
});

test("a draft keeps the kind of a chip inserted last", async ({
  page,
  dashboard,
}) => {
  const composer = await openThread(page, dashboard.baseURL);
  await composer.pressSequentially("@reche");
  const mentions = page.getByRole("listbox", { name: "Mentions" });
  const task = mentions
    .getByRole("group", { name: "Tasks" })
    .getByRole("option", { name: /Recheck pin order/ });
  await expect(mentions).not.toHaveAttribute("aria-busy", "true");
  await expect(task).toHaveAttribute("aria-selected", "true");
  await composer.press("Enter");
  await expect(composer.locator("[data-reference='task']")).toBeVisible();

  // Nothing is typed after the chip before the draft is stored.
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.values(localStorage).some((value) =>
          value.includes('"kind":"task"'),
        ),
      ),
    )
    .toBe(true);
  await page.reload();
  await expect(
    page
      .getByRole("textbox", { name: "Continue this conversation" })
      .locator("[data-reference='task']"),
  ).toHaveText("Recheck pin order in Safari");
});

test("# stays text after a word character, before a space, and in a link", async ({
  page,
  dashboard,
}) => {
  const searches: string[] = [];
  await page.route("**/api/code/changes/search?*", async (route) => {
    searches.push(new URL(route.request().url()).searchParams.get("q") ?? "");
    await route.fallback();
  });
  const composer = await openThread(page, dashboard.baseURL);
  await composer.pressSequentially(
    "a#b # heading https://example.com/docs#top 3#1",
  );
  await expect(composer).toHaveText(
    "a#b # heading https://example.com/docs#top 3#1",
  );
  // A real reference opens the menu, so the menu had time to open above.
  await composer.pressSequentially(" #38");
  await expect(
    page
      .getByRole("listbox", { name: "References" })
      .getByRole("option", { name: /getsentry\/junior#3842/ }),
  ).toBeVisible();
  // Only the last reference searched.
  expect(searches.length).toBeGreaterThan(0);
  expect(searches.filter((query) => !"38".startsWith(query))).toEqual([]);
});

test("pasted references become chips, and other links stay text", async ({
  page,
  dashboard,
}) => {
  const composer = await openThread(page, dashboard.baseURL);
  const checkout = conversationUrl(dashboard.baseURL, CHECKOUT_ID);
  const pasted = `<#CQA456|proj-release> <${PULL_REQUEST}|getsentry/junior#3842> <${checkout}|Investigate checkout latency> <https://example.com|docs>`;
  await pasteText(page, pasted);
  await expect(composer.locator("[data-reference]")).toHaveText([
    "#proj-release",
    "junior#3842",
    "Investigate checkout latency",
  ]);
  await expect(composer).toContainText("<https://example.com|docs>");
});
