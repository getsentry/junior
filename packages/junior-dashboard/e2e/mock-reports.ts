import type { Route } from "@playwright/test";
import {
  codePersonReportSchema,
  codeRepositoryQuerySchema,
  codeRepositoryReportSchema,
  conversationDetailQuerySchema,
  conversationDetailReportSchema,
  conversationFeedQuerySchema,
  conversationFeedSchema,
  conversationOutlineSchema,
  inboxItemCountSchema,
  inboxItemListSchema,
  objectLinksReportSchema,
  type CodePersonReport,
  type CodeRepositoryReport,
  type ConversationDetailReport,
  type ConversationFeed,
  type ObjectLinksReport,
} from "@sentry/junior/api/schema";
import type { z } from "zod";
import type * as DashboardApp from "../src/app";

// A test that changes a mock answer builds all of it here and fulfills it, so
// the mock server never sees that read. These read the built dashboard
// (`dist/app.js`): it holds the state that the running server reads, so the
// answer shows the test's earlier writes. A plain string keeps the type check
// from needing a build.
const BUILT_APP = "../dist/app.js";

async function mockReports(): Promise<typeof DashboardApp.mockReports> {
  const app: typeof DashboardApp = await import(BUILT_APP);
  return app.mockReports;
}

/** The last path segment of a request URL, or the one `fromEnd` back, decoded. */
function pathSegment(url: URL, fromEnd = 1): string {
  return decodeURIComponent(url.pathname.split("/").at(-fromEnd)!);
}

/**
 * The feed page that the mock API answers for `url`, which defaults to the
 * route's request.
 */
export async function mockFeedPage(
  route: Route,
  url = new URL(route.request().url()),
): Promise<ConversationFeed> {
  const query = conversationFeedQuerySchema.parse(
    Object.fromEntries(url.searchParams),
  );
  const page = (await mockReports()).conversationFeedPage(query, url.origin);
  if (!page) throw new Error(`No mock feed page for ${url.search}`);
  return conversationFeedSchema.parse(page);
}

type MockConversationDetail = ConversationDetailReport & { mailbox?: unknown };

/**
 * The detail that the mock API answers for a Conversation, with the mailbox
 * when the route's request asks for it, or undefined when the mock API has no
 * such Conversation. `conversationId` defaults to the one that the request
 * names.
 */
export async function findMockConversationDetail(
  route: Route,
  conversationId?: string,
): Promise<MockConversationDetail | undefined> {
  const url = new URL(route.request().url());
  const query = conversationDetailQuerySchema.parse(
    Object.fromEntries(url.searchParams),
  );
  const report = (await mockReports()).conversationDetail(
    conversationId ?? pathSegment(url),
    query,
  );
  if (!report) return undefined;
  const detail = conversationDetailReportSchema.parse(report.detail);
  return report.mailbox ? { ...detail, mailbox: report.mailbox } : detail;
}

/** Like `findMockConversationDetail`, for a Conversation that must exist. */
export async function mockConversationDetail(
  route: Route,
  conversationId?: string,
): Promise<MockConversationDetail> {
  const detail = await findMockConversationDetail(route, conversationId);
  if (!detail)
    throw new Error(`No mock Conversation for ${route.request().url()}`);
  return detail;
}

/** The cards that the mock API answers for the links of `/api/objects`. */
export async function mockObjectLinks(
  route: Route,
): Promise<ObjectLinksReport> {
  const urls = new URL(route.request().url()).searchParams.getAll("url");
  return objectLinksReportSchema.parse((await mockReports()).objectLinks(urls));
}

/** The code report of the person that `/api/people/:email/code` names. */
export async function mockPeopleCode(route: Route): Promise<CodePersonReport> {
  const email = pathSegment(new URL(route.request().url()), 2);
  const report = (await mockReports()).peopleCode(email);
  if (!report) throw new Error(`No mock person ${email}`);
  return codePersonReportSchema.parse(report);
}

/** The report of the repository that `/api/code/repositories/:id` names. */
export async function mockCodeRepository(
  route: Route,
): Promise<CodeRepositoryReport> {
  const url = new URL(route.request().url());
  const id = pathSegment(url);
  const { state } = codeRepositoryQuerySchema.parse(
    Object.fromEntries(url.searchParams),
  );
  const report = (await mockReports()).codeRepository(id, state);
  if (!report) throw new Error(`No mock repository ${id}`);
  return codeRepositoryReportSchema.parse(report);
}

/** The Inbox items that the mock API lists for the query of `/api/inbox-items`. */
export async function mockInboxItemList(
  route: Route,
): Promise<z.output<typeof inboxItemListSchema>> {
  const query = Object.fromEntries(new URL(route.request().url()).searchParams);
  return inboxItemListSchema.parse((await mockReports()).inboxItemList(query));
}

/** The counts that the mock API answers for `/api/inbox-items/count`. */
export async function mockInboxItemCount(
  route: Route,
): Promise<z.output<typeof inboxItemCountSchema>> {
  const query = Object.fromEntries(new URL(route.request().url()).searchParams);
  return inboxItemCountSchema.parse(
    (await mockReports()).inboxItemCount(query),
  );
}

/** The rows that the mock API searches for `/api/search`. */
export async function mockServerSearchRows() {
  return (await mockReports()).searchRows();
}

/** The notification settings that the mock API answers. */
export async function mockNotificationSettings() {
  return (await mockReports()).notificationSettings();
}

/** The outline that the mock API answers for a Conversation. */
export async function mockConversationOutline(conversationId: string) {
  const outline = (await mockReports()).conversationOutline(conversationId);
  if (!outline) throw new Error(`No mock Conversation ${conversationId}`);
  return conversationOutlineSchema.parse(outline);
}
