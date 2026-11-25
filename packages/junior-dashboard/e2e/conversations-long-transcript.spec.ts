import { expect, test } from "./test";
import { desktop, mobile, screenshot } from "./screenshot";
import {
  EVENT_COUNT,
  PAGE_SIZE,
  MAX_MOUNTED_ROWS,
  MEMORY_CAPTURE_SEQ,
  mockLongConversation,
  mountedRows,
  row,
  distanceFromBottom,
  recordRowMarks,
} from "./long-transcript-fixture";

test("mounts only the rows near the viewport of a long transcript", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  const mock = await mockLongConversation(page, {
    lastReadSeq: EVENT_COUNT - 1,
    paged: false,
  });
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  const transcript = page.getByLabel("Conversation transcript");
  await expect(
    transcript.getByText(`Transcript message ${EVENT_COUNT - 1} `),
  ).toBeInViewport();
  expect(await mountedRows(transcript)).toBeLessThanOrEqual(MAX_MOUNTED_ROWS);

  // A memory jump mounts the far row of its Turn before it scrolls there.
  const details = page.getByRole("complementary", {
    name: "Conversation details",
    exact: true,
  });
  await details
    .getByRole("button", { name: "1 recalled · 2 captured" })
    .click();
  await details
    .getByRole("listitem")
    .filter({ hasText: "Dashboard transcript events should remain" })
    .getByRole("button", { name: "Go to message" })
    .click();
  await expect(
    transcript.getByText(`Transcript message ${MEMORY_CAPTURE_SEQ - 1} `),
  ).toBeInViewport();
  expect(await mountedRows(transcript)).toBeLessThanOrEqual(MAX_MOUNTED_ROWS);
  // The outline marks the person message at the top of the transcript, and
  // scrolls its list to it, a few frames after the jump. Wait for both, so
  // the shot does not catch the outline before the jump.
  const activeItem = page
    .getByRole("navigation", { name: "Conversation outline" })
    .getByRole("button", { name: "Transcript message 996 with" });
  await expect(activeItem).toHaveAttribute("aria-current", "location");
  await expect(activeItem).toBeInViewport();
  await screenshot(page, "conversation-long-transcript-memory", {
    view: "desktop",
  });

  // Search finds rows that are not mounted.
  await page.keyboard.press("ControlOrMeta+f");
  const search = page.getByPlaceholder("Search transcript…");
  await expect(search).toBeFocused();
  await search.fill("Transcript message 123");
  await expect(page.getByText("1/11", { exact: true })).toBeVisible();
  // Enter goes to the next match. Shift+Enter goes back and wraps around.
  await search.press("Enter");
  await expect(page.getByText("2/11", { exact: true })).toBeVisible();
  await expect(
    transcript.getByText("Transcript message 1230 "),
  ).toBeInViewport();
  await search.press("Shift+Enter");
  await search.press("Shift+Enter");
  await expect(page.getByText("11/11", { exact: true })).toBeVisible();
  await expect(
    transcript.getByText("Transcript message 1239 "),
  ).toBeInViewport();

  // A second press goes to the browser's find.
  await page.evaluate(() => {
    window.addEventListener(
      "keydown",
      (event) => {
        document.body.dataset["findPrevented"] = String(event.defaultPrevented);
      },
      { once: true },
    );
  });
  await page.keyboard.press("ControlOrMeta+f");
  await expect(page.locator("body")).toHaveAttribute(
    "data-find-prevented",
    "false",
  );

  // Escape closes the search, not the details panel.
  await search.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(details).toBeVisible();
});

test("keeps a Reply rating while its row unmounts", async ({
  page,
  dashboard,
}) => {
  const feedback: unknown[] = [];
  await page.addInitScript(() => {
    Object.assign(window, {
      __JUNIOR_DASHBOARD_SENTRY__: {
        dsn: "https://public@sentry.example/1",
        tracesSampleRate: 0,
      },
    });
  });
  await page.route("https://sentry.example/**", async (route) => {
    const item = route.request().postData()?.split("\n").at(-1) ?? "";
    if (item.includes('"type":"feedback"')) feedback.push(JSON.parse(item));
    await route.fulfill({ json: {} });
  });
  await page.clock.install();
  await page.setViewportSize(desktop);
  const mock = await mockLongConversation(page, {
    lastReadSeq: EVENT_COUNT - 1,
    paged: false,
  });
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  const transcript = page.getByLabel("Conversation transcript");
  const reply = row(transcript, EVENT_COUNT - 1);
  const good = reply.getByRole("button", { name: "Good reply" });
  const bad = reply.getByRole("button", { name: "Bad reply" });
  const scrollTo = (place: "top" | "bottom") =>
    transcript.evaluate(
      (element, top) => element.scrollTo({ top }),
      place === "top" ? 0 : 1e9,
    );
  await good.hover();
  await good.click();

  // A pending Good stays pending while its row unmounts, then sends once.
  await scrollTo("top");
  await expect(reply).toHaveCount(0);
  await scrollTo("bottom");
  await expect(good).toHaveAttribute("aria-pressed", "true");
  await expect(bad).toBeVisible();
  await scrollTo("top");
  await expect(reply).toHaveCount(0);
  await page.clock.runFor(5000);
  await expect.poll(() => feedback.length).toBe(1);
  await scrollTo("bottom");
  await expect(good).toHaveAttribute("aria-pressed", "true");
  await expect(bad).toHaveCount(0);
  await good.click();
  await page.clock.runFor(5000);
  expect(feedback).toHaveLength(1);
});

test("opens a Message link on its row and marks it", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  const mock = await mockLongConversation(page, {
    lastReadSeq: EVENT_COUNT - 1,
    paged: true,
  });
  const rowMarks = await recordRowMarks(page);
  await page.goto(
    `${dashboard.baseURL}/conversations/${mock.conversationId}?message=message-400`,
  );
  const transcript = page.getByLabel("Conversation transcript");
  await expect(row(transcript, 400)).toBeInViewport();
  await expect.poll(rowMarks).toEqual([400]);
  expect(mock.pageRequests).toContain("?message=message-400&limit=300");
});

test("opens an event link on its row and marks it", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  const mock = await mockLongConversation(page, {
    lastReadSeq: EVENT_COUNT - 1,
    paged: true,
  });
  let release = () => {};
  mock.holdReads = new Promise((resolve) => {
    release = resolve;
  });
  const rowMarks = await recordRowMarks(page);
  await page.goto(
    `${dashboard.baseURL}/conversations/${mock.conversationId}#event-1200`,
  );
  const transcript = page.getByLabel("Conversation transcript");
  // The latest page does not hold the row, so the read around it loads it.
  await expect.poll(() => mock.pageRequests).toEqual(["?event=1200&limit=300"]);
  await expect(row(transcript, 1_200)).toHaveCount(0);
  release();
  const linked = transcript.locator("#event-1200");
  await expect(linked).toBeInViewport();
  await expect(linked).toHaveAttribute("data-transcript-seq", "1200");
  await expect.poll(rowMarks).toEqual([1_200]);
  // The link shows the transcript row. It does not open the event log.
  expect(new URL(page.url()).searchParams.has("event")).toBe(false);
  expect(new URL(page.url()).hash).toBe("#event-1200");
});

test("opens an event link past the last event on the last row", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  const mock = await mockLongConversation(page, {
    lastReadSeq: EVENT_COUNT - 1,
    paged: true,
  });
  const rowMarks = await recordRowMarks(page);
  await page.goto(
    `${dashboard.baseURL}/conversations/${mock.conversationId}#event-5000`,
  );
  const transcript = page.getByLabel("Conversation transcript");
  // The read around the seq holds the last events, so the last row shows
  // and the link reads no more.
  await expect(row(transcript, EVENT_COUNT - 1)).toBeInViewport();
  await expect.poll(rowMarks).toEqual([EVENT_COUNT - 1]);
  expect(mock.pageRequests).toEqual(["?event=5000&limit=300"]);
});

test("holds the top row while earlier pages load above it", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  const mock = await mockLongConversation(page, {
    lastReadSeq: EVENT_COUNT - 1,
    paged: true,
  });
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  const transcript = page.getByLabel("Conversation transcript");
  await expect(
    transcript.getByText(`Transcript message ${EVENT_COUNT - 1} `),
  ).toBeInViewport();

  for (let load = 1; load <= 4; load += 1) {
    let release = () => {};
    mock.holdEarlier = new Promise((resolve) => {
      release = resolve;
    });
    const firstSeq = EVENT_COUNT - PAGE_SIZE * load;
    await transcript.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(
      transcript.getByText("Loading earlier messages…"),
    ).toBeVisible();
    const firstRow = row(transcript, firstSeq);
    await expect(firstRow).toBeInViewport();
    const distance = await distanceFromBottom(transcript);
    release();
    // The last row of the earlier page mounts just above the reader.
    await expect(row(transcript, firstSeq - 1)).toBeAttached();
    await expect
      .poll(async () =>
        Math.abs((await distanceFromBottom(transcript)) - distance),
      )
      .toBeLessThan(2);
    await expect(firstRow).toBeInViewport();
    expect(await mountedRows(transcript)).toBeLessThanOrEqual(MAX_MOUNTED_ROWS);
  }
  expect(mock.pageRequests).toEqual(
    [1, 2, 3, 4].map((load) => `?before=${EVENT_COUNT - PAGE_SIZE * load}`),
  );
});

test("keeps the current search match while earlier pages load", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  const mock = await mockLongConversation(page, {
    lastReadSeq: EVENT_COUNT - 1,
    paged: true,
  });
  let release = () => {};
  mock.holdEarlier = new Promise((resolve) => {
    release = resolve;
  });
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  const transcript = page.getByLabel("Conversation transcript");
  await expect(
    transcript.getByText(`Transcript message ${EVENT_COUNT - 1} `),
  ).toBeInViewport();

  await page.keyboard.press("ControlOrMeta+f");
  const search = page.getByPlaceholder("Search transcript…");
  // The latest page holds 1969, 1979, 1989, and 1999.
  await search.fill("9 with");
  await expect(page.getByText("1/4", { exact: true })).toBeVisible();
  await search.press("Enter");
  await expect(page.getByText("2/4", { exact: true })).toBeVisible();

  // The earlier page adds four matches before 1979, which stays current.
  let releaseNext = () => {};
  mock.holdEarlier = new Promise((resolve) => {
    releaseNext = resolve;
  });
  release();
  await expect(page.getByText("6/8", { exact: true })).toBeVisible();
  await search.press("Enter");
  await expect(page.getByText("7/8", { exact: true })).toBeVisible();
  await expect(
    transcript.getByText("Transcript message 1989 "),
  ).toBeInViewport();
  releaseNext();
  await mock.pageReadsLanded();

  // The jump left the latest, so clearing the search does not pin to it.
  await search.fill("");
  // Rows that do not match come back.
  await expect(
    transcript.getByText(/^Transcript message \d+[0-8] with/).first(),
  ).toBeAttached();
  await expect(
    transcript.getByText(`Transcript message ${EVENT_COUNT - 1} `),
  ).not.toBeInViewport();
});

test("opens far behind at the marker and jumps to the latest", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  const mock = await mockLongConversation(page, {
    lastReadSeq: 1_000,
    paged: true,
  });
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  const transcript = page.getByLabel("Conversation transcript");
  await expect(
    transcript.getByRole("separator", { name: "New messages" }),
  ).toBeInViewport();
  await expect(
    transcript.getByText("Transcript message 1001 "),
  ).toBeInViewport();
  expect(await mountedRows(transcript)).toBeLessThanOrEqual(MAX_MOUNTED_ROWS);

  await page.getByRole("button", { name: "Jump to latest" }).first().click();
  await expect(
    transcript.getByText(`Transcript message ${EVENT_COUNT - 1} `),
  ).toBeInViewport();
  expect(await mountedRows(transcript)).toBeLessThanOrEqual(MAX_MOUNTED_ROWS);
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  test("scrolls up through a long transcript without corrections", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize(mobile);
    const mock = await mockLongConversation(page, {
      lastReadSeq: EVENT_COUNT - 1,
      paged: false,
    });
    await page.goto(
      `${dashboard.baseURL}/conversations/${mock.conversationId}`,
    );
    const transcript = page.getByLabel("Conversation transcript");
    await expect(
      transcript.getByText(`Transcript message ${EVENT_COUNT - 1} `),
    ).toBeInViewport();

    // Count the scroll corrections of the scroll owner. Rows that mount
    // above the reader use the measured size of rows like them, so a touch
    // scroll needs none.
    await transcript.evaluate((element) => {
      const scrollTo = element.scrollTo.bind(element);
      element.dataset["scrollCorrections"] = "0";
      element.scrollTo = (...args: Parameters<typeof scrollTo>) => {
        element.dataset["scrollCorrections"] = String(
          Number(element.dataset["scrollCorrections"]) + 1,
        );
        scrollTo(...args);
      };
    });
    const session = await page.context().newCDPSession(page);
    // The transcript fills the width of a phone.
    const x = Math.round(mobile.width / 2);
    for (let swipe = 0; swipe < 6; swipe += 1) {
      // CDP touch events scroll like a finger. Playwright has no swipe.
      const points = (y: number) => [{ x, y }];
      await session.send("Input.dispatchTouchEvent", {
        touchPoints: points(200),
        type: "touchStart",
      });
      for (let y = 220; y <= 700; y += 20) {
        await session.send("Input.dispatchTouchEvent", {
          touchPoints: points(y),
          type: "touchMove",
        });
      }
      await session.send("Input.dispatchTouchEvent", {
        touchPoints: [],
        type: "touchEnd",
      });
    }
    await expect(
      transcript.getByText(`Transcript message ${EVENT_COUNT - 1} `),
    ).toHaveCount(0);
    await expect(transcript).toHaveAttribute("data-scroll-corrections", "0");
    // No screenshot: where a fling stops depends on the timing of the touch
    // events, so each run would show other rows.
    expect(await mountedRows(transcript)).toBeLessThanOrEqual(MAX_MOUNTED_ROWS);
  });
});
