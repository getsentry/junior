import type { Page } from "@playwright/test";
import type {
  AutomationListItem,
  SearchInboxItem,
} from "@sentry/junior/api/schema";

import { mockSearchReport } from "../src/mock-reporting/search";

/** The rows that a test's mocked lists hold, read at each search. */
type SearchRows = {
  automations?: () => readonly AutomationListItem[];
  inboxItems?: () => readonly (SearchInboxItem & { body: string })[];
};

// One route for each page, so the mocked Inbox and Automations of one test
// answer the same search.
const pageRows = new WeakMap<Page, SearchRows>();

/**
 * Answer `/api/search` from a test's mocked rows, as the server matches
 * them. Sources that no test mocks keep the mock server's rows.
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
    const response = await route.fetch();
    const served = await response.json();
    const report = mockSearchReport(
      {
        automations: mocked.automations?.() ?? [],
        inboxItems: mocked.inboxItems?.() ?? [],
      },
      new URL(route.request().url()).searchParams,
    );
    return route.fulfill({
      json: {
        ...served,
        ...(mocked.automations && report?.automations
          ? { automations: report.automations }
          : undefined),
        ...(mocked.inboxItems && report?.inboxItems
          ? { inboxItems: report.inboxItems }
          : undefined),
      },
      response,
    });
  });
}
