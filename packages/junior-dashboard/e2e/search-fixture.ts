import type { Page } from "@playwright/test";
import type {
  AutomationListItem,
  SearchInboxItem,
  SearchMemory,
} from "@sentry/junior/api/schema";

import { mockSearchReport } from "../src/mock-reporting/search";
import { mockServerSearchRows } from "./mock-reports";

/** The rows that a test's mocked lists hold, read at each search. */
type SearchRows = {
  automations?: () => readonly AutomationListItem[];
  inboxItems?: () => readonly (SearchInboxItem & { body: string })[];
  memories?: () => readonly SearchMemory[];
};

// One route for each page, so the mocked Inbox and Automations of one test
// answer the same search.
const pageRows = new WeakMap<Page, SearchRows>();

/**
 * Answer `/api/search` from a test's mocked rows, as the server matches
 * them. Sources that no test mocks search the mock server's rows.
 */
export async function mockSearchRows(
  page: Page,
  rows: SearchRows,
): Promise<void> {
  const known = pageRows.get(page);
  if (known) {
    Object.assign(known, rows);
    return;
  }
  const mocked = { ...rows };
  pageRows.set(page, mocked);
  await page.route(/\/api\/search\?/, async (route) => {
    const served = await mockServerSearchRows();
    const report = mockSearchReport(
      {
        automations: mocked.automations?.() ?? served.automations,
        inboxItems: mocked.inboxItems?.() ?? served.inboxItems,
        memories: mocked.memories?.() ?? served.memories,
        // No spec mocks To-dos, so the mock server's To-dos answer.
        todos: served.todos,
      },
      new URL(route.request().url()).searchParams,
    );
    return report
      ? route.fulfill({ json: report })
      : route.fulfill({
          json: { error: "Invalid search query." },
          status: 400,
        });
  });
}
