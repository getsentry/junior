import { githubPlugin } from "@sentry/junior-github";
import { encodeObjectImageRef } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJuniorApi } from "@/api";
import { readConversationDetail } from "@/api/conversations/detail";
import type { JuniorApiEnv } from "@/api/route";
import {
  CONVERSATION_DETAIL_VERSION_HEADER,
  CONVERSATION_VERSION_HEADER,
  conversationDetailReportSchema,
} from "@/api/schema";
import { createApp, defineJuniorPlugins } from "@/app";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import { decodeImageId } from "@/chat/images/ids";
import { createPluginAnnotations } from "@/chat/plugins/annotations";
import { storeConversationMetadataFixture } from "../../../fixtures/conversation-metadata";
import {
  createGitHubApp,
  GITHUB_API,
  GITHUB_REPO,
  linkGitHubMember,
  pullRequest,
  sendGitHubWebhook,
  stubGitHubApp,
} from "../../../fixtures/github-objects";
import { signedInViewer } from "../../../fixtures/user";
import { mswServer } from "../../../msw/server";

describe("conversation detail annotations", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("only returns annotations to viewers with private-content access", async () => {
    const conversationId = "slack:C-private:annotated-detail";
    await getConversationStore().recordActivity({
      actor: {
        email: "Participant@Example.com",
        platform: "slack",
        slackUserId: "U-participant",
        teamId: "TPRIVATE",
      },
      conversationId,
      destination: {
        channelId: "CPRIVATE",
        platform: "slack",
        teamId: "TPRIVATE",
      },
      nowMs: 1,
      source: "slack",
      title: "Private annotated conversation",
      visibility: "private",
    });
    const annotations = createPluginAnnotations({
      conversationId,
      db: getDb(),
      plugin: "github",
    });
    await annotations.upsert({
      kind: "resource_link",
      key: "getsentry/junior#1081",
      label: "getsentry/junior #1081",
      status: "open",
      url: "https://github.com/getsentry/junior/pull/1081",
    });
    await storeConversationMetadataFixture(getDb(), {
      conversationId,
      summary: "The private summary is participant-only.",
    });

    const hidden = await readConversationDetail(conversationId);
    expect(hidden).toMatchObject({
      annotations: [],
      eventHistory: { status: "redacted" },
    });
    expect(hidden).not.toHaveProperty("summary");
    await expect(
      readConversationDetail(conversationId, {
        viewer: await signedInViewer("participant@example.com"),
      }),
    ).resolves.toMatchObject({
      summary: "The private summary is participant-only.",
      annotations: [
        {
          key: "getsentry/junior#1081",
          kind: "resource_link",
          label: "getsentry/junior #1081",
          plugin: "github",
          status: "open",
          url: "https://github.com/getsentry/junior/pull/1081",
        },
      ],
      eventHistory: { status: "available" },
    });
  });

  it("reads each annotation's object live for the viewer, and shows only its label to a viewer who cannot read it", async () => {
    stubGitHubApp();
    const attachment =
      "https://github.com/user-attachments/assets/0f8c2d6e-5a4b-4c3d-9e8f-7a6b5c4d3e2f";
    mswServer.use(
      http.get(`${GITHUB_API}/pulls/35`, () =>
        HttpResponse.json(
          pullRequest(35, {
            body: `Before and after:\n\n![after](${attachment})`,
            merged: true,
            state: "closed",
            title: "Show screenshots on cards",
          }),
        ),
      ),
      // What GitHub shows signed out.
      http.get(
        `${GITHUB_REPO}/pull/35`,
        () => new HttpResponse(null, { status: 404 }),
      ),
    );
    await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
    await linkGitHubMember();
    const conversationId = "local:test:live-annotations";
    await getConversationStore().recordActivity({
      destination: { platform: "local" as const, conversationId },
      conversationId,
      nowMs: 1,
      source: "internal",
      title: "Pull request with screenshots",
      visibility: "public",
    });
    // Junior saved the pull request when it opened it.
    await createPluginAnnotations({
      conversationId,
      db: getDb(),
      plugin: "github",
    }).upsert({
      kind: "object",
      objectType: "code_change",
      key: "getsentry/junior#35",
      // A card never shows the stored label. GitHub makes it.
      label: "Saved label",
      title: "Draft title",
      status: "open",
      url: `${GITHUB_REPO}/pull/35`,
    });

    try {
      const member = await readConversationDetail(conversationId, {
        viewer: await signedInViewer("alice@example.com"),
      });
      expect(member?.annotations).toEqual([
        expect.objectContaining({
          key: "getsentry/junior#35",
          kind: "object",
          label: "getsentry/junior#35",
          plugin: "github",
          status: "merged",
          title: "Show screenshots on cards",
        }),
      ]);
      expect(member?.sidebarAnnotations).toEqual([
        expect.objectContaining({
          status: "merged",
          title: "Show screenshots on cards",
        }),
      ]);
      // The live card names its description images by Junior image paths.
      const [image] = member?.annotations?.[0]?.previewImages ?? [];
      const id = image?.src.match(/^\/api\/images\/([^?]+)\?w=320$/)?.[1];
      expect(image?.srcSet).toBe(
        `${image?.src} 1x, /api/images/${id}?w=640 2x`,
      );
      // The browser gets a signed id, never the address of the image.
      expect(JSON.stringify(image)).not.toContain("user-attachments");
      expect(id && decodeImageId(id)).toEqual({
        ref: encodeObjectImageRef({
          key: "getsentry/junior#35",
          url: attachment,
        }),
        source: "github",
      });

      // A reader without access to the repository sees the label that
      // GitHub makes from the link, and the link.
      const outsider = await readConversationDetail(conversationId, {
        viewer: await signedInViewer("bob@example.com"),
      });
      expect(outsider?.annotations).toEqual([
        {
          createdAt: expect.any(String),
          key: "getsentry/junior#35",
          kind: "resource_link",
          label: "getsentry/junior#35",
          objectType: "code_change",
          plugin: "github",
          updatedAt: expect.any(String),
          url: `${GITHUB_REPO}/pull/35`,
        },
      ]);
      expect(JSON.stringify(outsider?.sidebarAnnotations)).not.toMatch(
        /Draft title|Saved label|Show screenshots|merged|open/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refreshes an open page when the provider changes an annotated object, and only then", async () => {
    stubGitHubApp();
    mswServer.use(
      http.get(`${GITHUB_API}/pulls/36`, () =>
        HttpResponse.json(pullRequest(36)),
      ),
    );
    const github = await createGitHubApp();
    await linkGitHubMember();
    const conversationId = "local:test:provider-change";
    await getConversationStore().recordActivity({
      destination: { platform: "local" as const, conversationId },
      conversationId,
      nowMs: 1,
      source: "internal",
      title: "Pull request that merges",
      visibility: "public",
    });
    await createPluginAnnotations({
      conversationId,
      db: getDb(),
      plugin: "github",
    }).upsert({
      kind: "object",
      objectType: "code_change",
      key: "getsentry/junior#36",
      label: "getsentry/junior#36",
      subject: { id: "36000", kind: "pull_request" },
      title: "Cache GitHub objects",
      url: `${GITHUB_REPO}/pull/36`,
    });
    const viewer = await signedInViewer("alice@example.com");
    const api = new Hono<JuniorApiEnv>();
    api.use("*", async (context, next) => {
      context.set("viewer", viewer);
      await next();
    });
    api.route("/", createJuniorApi());
    const poll = (etag: string) =>
      api.request(`http://localhost/api/conversations/${conversationId}`, {
        headers: { [CONVERSATION_DETAIL_VERSION_HEADER]: etag },
      });
    const statusOf = async (response: Response) =>
      conversationDetailReportSchema.parse(await response.json())
        .annotations?.[0]?.status;

    try {
      const open = await poll("none");
      expect(await statusOf(open)).toBe("open");
      const openEtag = open.headers.get(CONVERSATION_DETAIL_VERSION_HEADER)!;
      const openVersion = open.headers.get(CONVERSATION_VERSION_HEADER);
      expect((await poll(openEtag)).status).toBe(304);

      const merged = pullRequest(36, {
        closed_at: "2026-01-02T04:00:00Z",
        merged: true,
        merged_at: "2026-01-02T04:00:00Z",
        state: "closed",
        updated_at: "2026-01-02T04:00:00Z",
      });
      await sendGitHubWebhook(github, "pull_request", {
        action: "closed",
        pull_request: merged,
      });
      // The merge writes no Annotation, but the page's version moves, so
      // an open page and the versions poll read the live card again.
      const refreshed = await poll(openEtag);
      expect(refreshed.status).toBe(200);
      expect(refreshed.headers.get(CONVERSATION_VERSION_HEADER)).not.toBe(
        openVersion,
      );
      expect(await statusOf(refreshed)).toBe("merged");

      // A redelivery changes nothing, so the page stays as it is.
      const mergedEtag = refreshed.headers.get(
        CONVERSATION_DETAIL_VERSION_HEADER,
      )!;
      await sendGitHubWebhook(github, "pull_request", {
        action: "closed",
        pull_request: merged,
      });
      expect((await poll(mergedEtag)).status).toBe(304);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
