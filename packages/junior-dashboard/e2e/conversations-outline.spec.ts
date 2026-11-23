import type { Page } from "@playwright/test";

import { expect, test } from "./test";
import { desktop } from "./screenshot";
import {
  EVENT_COUNT,
  MAX_MOUNTED_ROWS,
  MEMORY_CAPTURE_SEQ,
  mockLongConversation,
  mountedRows,
  row,
  scrollbarHidden,
  recordRowMarks,
} from "./long-transcript-fixture";

// Each frame that the row shows, record its place in the viewport: its
// offset in the transcript content less the scroll offset. The stand-in
// covers the row until the jump settles, so those frames do not count.
async function sampleRowPlaces(page: Page, seq: number) {
  await page.evaluate((seq) => {
    const places: number[] = [];
    Object.assign(window, { rowPlaces: places });
    const sample = () => {
      const scroll = document.querySelector(
        '[aria-label="Conversation transcript"]',
      );
      const row = scroll?.querySelector(`[data-transcript-seq="${seq}"]`);
      if (scroll && row && !document.querySelector("[data-outline-stand-in]")) {
        let offset = 0;
        for (
          let element: Element | null = row;
          element instanceof HTMLElement && element !== scroll;
          element = element.offsetParent
        ) {
          offset += element.offsetTop;
        }
        places.push(offset - scroll.scrollTop);
      }
      if (places.length < 60) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, seq);
}

/** How far the sampled row moved from where it first showed. */
async function rowShift(page: Page): Promise<number> {
  const places = await page.evaluate(
    () => (window as Window & { rowPlaces?: number[] }).rowPlaces ?? [],
  );
  expect(places.length).toBeGreaterThan(0);
  return Math.max(...places.map((place) => Math.abs(place - places[0]!)));
}

test("jumps to a far message from the outline", async ({ page, dashboard }) => {
  // The outline shows beside a transcript that fills its column too.
  await page.setViewportSize(desktop);
  const mock = await mockLongConversation(page, {
    lastReadSeq: EVENT_COUNT - 1,
    paged: true,
  });
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  const transcript = page.getByLabel("Conversation transcript");
  const outline = page.getByRole("navigation", {
    name: "Conversation outline",
  });
  await expect(
    transcript.getByText(`Transcript message ${EVENT_COUNT - 1} `),
  ).toBeInViewport();
  // The outline lists every person message, not only the loaded page.
  await expect(outline.getByRole("button")).toHaveCount(EVENT_COUNT / 2 - 1);
  await expect(row(transcript, 1_234)).toHaveCount(0);
  // By default the scrollbar stays, the outline sits on the left, and it
  // marks no thumb.
  expect(await scrollbarHidden(transcript)).toBe(false);
  await expect(outline).toHaveAttribute("data-side", "left");
  await expect(outline.locator("button[data-in-view]")).toHaveCount(0);

  const item = outline.getByRole("button", {
    name: "Transcript message 1234 with",
  });
  // The preview of a message that has not loaded shows its reply too.
  await item.hover();
  await expect(
    page.locator('[data-slot="message-outline-preview-description"]'),
  ).toHaveText(/^Transcript message 1235 /);
  await expect(
    page.locator('[data-slot="message-outline-preview-meta"]'),
  ).toHaveText(/^Andrew Asker · /);
  // The preview reads the page of its message, so the click needs no read.
  await expect.poll(() => mock.pageRequests).toContain("?event=1234&limit=300");
  const requests = mock.pageRequests.length;
  await item.click();
  // The message starts at the top of the viewport.
  await expect(row(transcript, 1_234)).toBeInViewport({ ratio: 1 });
  await expect(row(transcript, 1_233)).not.toBeInViewport({ ratio: 0.5 });
  await expect(item).toHaveAttribute("aria-current", "location");
  expect(await mountedRows(transcript)).toBeLessThanOrEqual(MAX_MOUNTED_ROWS);
  expect(mock.pageRequests).toHaveLength(requests);
});

test("scrolls with the outline instead of the scrollbar", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 900, width: 1920 });
  const mock = await mockLongConversation(page, {
    lastReadSeq: EVENT_COUNT - 1,
    paged: true,
  });
  await page.goto(`${dashboard.baseURL}/settings#scroll-conversations-with`);
  await page.getByRole("radio", { name: "Outline" }).click();
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  const transcript = page.getByLabel("Conversation transcript");
  const outline = page.getByRole("navigation", {
    name: "Conversation outline",
  });
  await expect(outline.getByRole("button")).toHaveCount(EVENT_COUNT / 2 - 1);
  await expect.poll(() => scrollbarHidden(transcript)).toBe(true);
  // The outline takes the place of the scrollbar on the right.
  await expect(outline).toHaveAttribute("data-side", "right");
  // The items on screen form a thumb that holds the active item.
  const thumb = outline.locator("button[data-in-view]");
  await expect(thumb.first()).toHaveAttribute("aria-current", "location");

  // The wheel still scrolls the transcript.
  const before = await transcript.evaluate((element) => element.scrollTop);
  await transcript.hover();
  await page.mouse.wheel(0, -600);
  await expect
    .poll(() => transcript.evaluate((element) => element.scrollTop))
    .toBeLessThan(before);

  // A drag up the list moves the transcript to the item under the pointer,
  // through the pages that are not loaded.
  const active = outline.locator("button[aria-current]");
  const startSeq = Number(
    /message (\d+) /.exec((await active.getAttribute("aria-label"))!)![1],
  );
  const target = outline.getByRole("button", {
    name: `Transcript message ${startSeq - 100} with`,
  });
  await active.dragTo(target, { steps: 20 });
  await expect(target).toHaveAttribute("aria-current", "location");
  await expect(row(transcript, startSeq - 100)).toBeInViewport();
  expect(await mountedRows(transcript)).toBeLessThanOrEqual(MAX_MOUNTED_ROWS);

  // A press released off the list ends there, so a later hover does not
  // move the transcript.
  await target.hover();
  await page.mouse.down();
  await row(transcript, startSeq - 100).hover();
  await page.mouse.up();
  await outline
    .getByRole("button", { name: `Transcript message ${startSeq - 60} with` })
    .hover();
  await expect(target).toHaveAttribute("aria-current", "location");
  await expect(row(transcript, startSeq - 100)).toBeInViewport();

  // A shorter transcript shows fewer items, and the thumb follows.
  const inView = await thumb.count();
  await page.setViewportSize({ height: 600, width: 1920 });
  await expect.poll(() => thumb.count()).toBeLessThan(inView);

  // Where the outline hides, the scrollbar comes back.
  await page.setViewportSize({ height: 900, width: 700 });
  await expect(outline).toBeHidden();
  await expect.poll(() => scrollbarHidden(transcript)).toBe(false);
});

test("shows a far message at once while its page loads", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 900, width: 1920 });
  const mock = await mockLongConversation(page, {
    lastReadSeq: EVENT_COUNT - 1,
    paged: true,
  });
  await page.goto(`${dashboard.baseURL}/settings#scroll-conversations-with`);
  await page.getByRole("radio", { name: "Outline" }).click();
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  const transcript = page.getByLabel("Conversation transcript");
  const outline = page.getByRole("navigation", {
    name: "Conversation outline",
  });
  await expect(outline).toHaveAttribute("data-replaces-scrollbar", "");
  // No page read lands until the end.
  let landReads!: () => void;
  mock.holdReads = new Promise((resolve) => {
    landReads = resolve;
  });

  const item = outline.getByRole("button", {
    name: "Transcript message 400 with",
  });
  await item.click();
  // The message and the start of its reply show from the outline alone.
  const standIn = page.locator('[data-outline-stand-in="400"]');
  await expect(standIn).toBeVisible();
  await expect(standIn).toContainText("Transcript message 400 ");
  await expect(standIn).toContainText("Transcript message 401 ");
  await expect(item).toHaveAttribute("aria-current", "location");
  await expect(row(transcript, 400)).toHaveCount(0);
  await expect.poll(() => mock.pageRequests).toContain("?event=400&limit=300");

  // When the page lands, its rows take the place of the stand-in.
  landReads();
  await expect(row(transcript, 400)).toBeInViewport({ ratio: 1 });
  await expect(row(transcript, 399)).not.toBeInViewport({ ratio: 0.5 });
  await expect(standIn).toHaveCount(0);
  await expect(item).toHaveAttribute("aria-current", "location");

  // The stand-in takes the pointer from the rows below it, and the wheel
  // dismisses it.
  let landNextReads = () => {};
  mock.holdReads = new Promise((resolve) => {
    landNextReads = resolve;
  });
  await outline
    .getByRole("button", { name: "Transcript message 800 with" })
    .click();
  const nextStandIn = page.locator('[data-outline-stand-in="800"]');
  await nextStandIn.hover();
  await page.mouse.wheel(0, -400);
  await expect(nextStandIn).toHaveCount(0);
  landNextReads();
  await mock.pageReadsLanded();
});

test("holds read events, so a near jump reads only the events it lacks", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  const rowMarks = await recordRowMarks(page);
  const mock = await mockLongConversation(page, {
    lastReadSeq: EVENT_COUNT - 1,
    paged: true,
  });
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  const transcript = page.getByLabel("Conversation transcript");
  const outline = page.getByRole("navigation", {
    name: "Conversation outline",
  });
  await expect(
    transcript.getByText(`Transcript message ${EVENT_COUNT - 1} `),
  ).toBeInViewport();
  // The outline list follows the transcript while the rows settle, so each
  // click waits until the preview shows its item.
  const pickOutlineItem = async (seq: number) => {
    const item = outline.getByRole("button", {
      name: `Transcript message ${seq} with`,
    });
    await expect(async () => {
      await item.hover();
      await expect(
        page.locator('[data-slot="message-outline-preview-title"]'),
      ).toHaveText(new RegExp(`^Transcript message ${seq} `), {
        timeout: 1_000,
      });
    }).toPass();
    await item.click();
  };

  await pickOutlineItem(400);
  await expect(row(transcript, 400)).toBeInViewport({ ratio: 1 });
  // The row it lands on shows a mark for a moment.
  await expect.poll(rowMarks).toContain(400);
  await expect(row(transcript, 400)).not.toHaveAttribute("data-highlighted");
  // The reads hold the 150 events on each side of the message.
  const held = (seq: number) =>
    mock.pageRanges.some(([from, to]) => from <= seq && seq <= to);
  expect(held(251) && held(550)).toBe(true);

  // A jump near the held events reads on from them, and a jump back to
  // them reads at most the events past their ends. No read serves a seq
  // that an earlier read served.
  for (const seq of [600, 420]) {
    await pickOutlineItem(seq);
    await expect(row(transcript, seq)).toBeInViewport({ ratio: 1 });
    await expect.poll(rowMarks).toContain(seq);
  }
  const served = new Set<number>();
  for (const [from, to] of mock.pageRanges) {
    for (let seq = from; seq <= to; seq++) {
      expect(served.has(seq), `seq ${seq} read twice`).toBe(false);
      served.add(seq);
    }
  }
  expect(mock.pageRequests.some((search) => search.startsWith("?after="))).toBe(
    true,
  );
});

test("keeps a far message still from the stand-in to its rows", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 900, width: 1920 });
  const mock = await mockLongConversation(page, {
    lastReadSeq: EVENT_COUNT - 1,
    paged: true,
  });
  await page.goto(`${dashboard.baseURL}/settings#scroll-conversations-with`);
  await page.getByRole("radio", { name: "Outline" }).click();
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  const outline = page.getByRole("navigation", {
    name: "Conversation outline",
  });
  await expect(outline).toHaveAttribute("data-replaces-scrollbar", "");
  let landReads!: () => void;
  mock.holdReads = new Promise((resolve) => {
    landReads = resolve;
  });

  await sampleRowPlaces(page, 1_200);
  await outline
    .getByRole("button", { name: "Transcript message 1200 with" })
    .click();
  await expect(page.locator('[data-outline-stand-in="1200"]')).toBeVisible();
  landReads();
  await expect(
    row(page.getByLabel("Conversation transcript"), 1_200),
  ).toBeInViewport({ ratio: 1 });
  await expect(page.locator("[data-outline-stand-in]")).toHaveCount(0);
  // The row holds its place while the rows around it measure.
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as Window & { rowPlaces?: number[] }).rowPlaces?.length,
      ),
    )
    .toBe(60);
  expect(await rowShift(page)).toBeLessThanOrEqual(2);
});

test("drags the outline through messages whose pages load slowly", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 900, width: 1920 });
  // Person messages lie far apart, so each item is on a page that is not
  // loaded, and each page takes a while to load.
  const mock = await mockLongConversation(page, {
    lastReadSeq: EVENT_COUNT - 1,
    paged: true,
    personEvery: 25,
  });
  mock.readDelayMs = 500;
  await page.goto(`${dashboard.baseURL}/settings#scroll-conversations-with`);
  await page.getByRole("radio", { name: "Outline" }).click();
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  const outline = page.getByRole("navigation", {
    name: "Conversation outline",
  });
  const outlineItem = (seq: number) =>
    outline.getByRole("button", { name: `Transcript message ${seq} with` });
  const active = outline.locator("button[aria-current]");
  const activeSeq = async () =>
    Number(
      /message (\d+) /.exec((await active.getAttribute("aria-label"))!)![1],
    );
  const previewTitle = page.locator(
    '[data-slot="message-outline-preview-title"]',
  );
  // The memory event takes the place of one person message.
  await expect(outline.getByRole("button")).toHaveCount(EVENT_COUNT / 25 - 1);
  await expect(outline).toHaveAttribute("data-replaces-scrollbar", "");
  const startSeq = await activeSeq();
  const requests = mock.pageRequests.length;
  // No page read lands during the drag.
  let landReads!: () => void;
  mock.holdReads = new Promise((resolve) => {
    landReads = resolve;
  });

  // A person presses an item and moves the pointer past item after item.
  // The transcript follows at once, with the rows or the stand-in of each.
  await active.hover();
  await page.mouse.down();
  for (let seq = startSeq - 25; seq >= startSeq - 1_000; seq -= 25) {
    if (seq === MEMORY_CAPTURE_SEQ) continue;
    await outlineItem(seq).hover();
    await expect(previewTitle).toHaveText(
      new RegExp(`^Transcript message ${seq} `),
    );
    await expect(
      page
        .locator(`[data-outline-stand-in="${seq}"]`)
        .or(row(page.getByLabel("Conversation transcript"), seq)),
    ).toBeVisible();
    await expect.poll(activeSeq).toBe(seq);
  }
  // It reads one page at a time, not one page for each of the 39 items that
  // the pointer passed.
  expect(mock.pageRequests.length - requests).toBeLessThanOrEqual(1);
  landReads();
  await page.mouse.up();
  await expect(outlineItem(startSeq - 1_000)).toHaveAttribute(
    "aria-current",
    "location",
  );
  await expect(
    page
      .getByLabel("Conversation transcript")
      .locator(`[data-transcript-seq="${startSeq - 1_000}"]`),
  ).toBeInViewport();
});

test("points at the outline item under a still pointer while the list scrolls", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 900, width: 1920 });
  const mock = await mockLongConversation(page, {
    lastReadSeq: EVENT_COUNT - 1,
    paged: true,
  });
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  const outline = page.getByRole("navigation", {
    name: "Conversation outline",
  });
  await expect(outline.getByRole("button")).toHaveCount(EVENT_COUNT / 2 - 1);
  // The list scrolls to the active item near its end, so a wheel up has
  // room to scroll.
  await expect(outline.locator("button[aria-current]")).toBeInViewport();
  await outline.getByRole("list").hover({ position: { x: 4, y: 200 } });
  const pointed = outline.locator("button[data-highlighted]");
  const title = page.locator('[data-slot="message-outline-preview-title"]');
  const before = (await pointed.getAttribute("aria-label"))!;
  await expect(title).toHaveText(before);

  // A wheel scrolls the list without a pointer move. The pointed item and
  // its preview follow the item that is now under the pointer.
  await page.mouse.wheel(0, -400);
  await expect(pointed).not.toHaveAttribute("aria-label", before);
  await expect(title).toHaveText((await pointed.getAttribute("aria-label"))!);
});

test("points at the outline item under the pointer with a larger font size", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 900, width: 2560 });
  const mock = await mockLongConversation(page, {
    lastReadSeq: EVENT_COUNT - 1,
    paged: true,
  });
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  // A browser font size or a text-only zoom changes rem.
  await page.addStyleTag({ content: "html { font-size: 20px; }" });
  const outline = page.getByRole("navigation", {
    name: "Conversation outline",
  });
  await expect(outline.getByRole("button")).toHaveCount(EVENT_COUNT / 2 - 1);
  const item = outline.getByRole("button", {
    name: "Transcript message 1990 with",
  });
  await item.hover();
  await expect(
    page.locator('[data-slot="message-outline-preview-title"]'),
  ).toHaveText((await item.getAttribute("aria-label"))!);
});
