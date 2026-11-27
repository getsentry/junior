import type { User } from "@sentry/junior-plugin-api";
import { sentryPlugin } from "@sentry/junior-sentry";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "@/app";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import { closeDb } from "@/chat/db";
import { defineJuniorPlugins } from "@/plugins";
import { testViewer } from "../../fixtures/user";
import { mswServer } from "../../msw/server";
import { readLiveCards } from "../../fixtures/object-cards";

const SENTRY_SCOPE =
  "alerts:write event:write member:read org:read project:releases project:write team:write";
const ORG_READ_TOKEN = "org-read-token";
const REGION = "https://us.sentry.io";

const VERSION = "checkout@4.2.0+9f1c2ab";
const RELEASE_URL = `https://sentry.sentry.io/releases/${encodeURIComponent(VERSION)}/`;

const PROJECTS = [
  {
    id: 11,
    slug: "checkout",
    newGroups: 3,
    health: { crashFreeSessions: 99, totalSessions: 3000 },
  },
  {
    id: 12,
    slug: "payments",
    newGroups: 1,
    health: { crashFreeSessions: 95, totalSessions: 1000 },
  },
];

/**
 * Fake Sentry's org and release APIs. Like Sentry, a token reads the
 * release only when its viewer can see one of the release's projects, and
 * it then lists all of them. Health comes only with `health=1`, and
 * `project` narrows the release to one project the viewer can see.
 * Junior's org read token reads no release.
 */
function fakeSentry(access: Record<string, number[]>, version = VERSION) {
  const queries: string[] = [];
  mswServer.use(
    http.get("https://sentry.io/api/0/organizations/:org/", ({ params }) =>
      HttpResponse.json({ slug: params["org"], links: { regionUrl: REGION } }),
    ),
    http.get(
      `${REGION}/api/0/organizations/sentry/releases/:version/`,
      ({ params, request }) => {
        const token = request.headers.get("authorization") ?? "none";
        const url = new URL(request.url);
        queries.push(`${token} ${url.host}${url.pathname}${url.search}`);
        const viewer = token.replace(/^Bearer (.+)-token$/, "$1");
        const visible = access[viewer] ?? [];
        const project = url.searchParams.get("project");
        const projects = project
          ? PROJECTS.filter(({ id }) => String(id) === project)
          : PROJECTS;
        if (
          params["version"] !== version ||
          !PROJECTS.some(({ id }) => visible.includes(id)) ||
          (project && !visible.includes(Number(project)))
        ) {
          return HttpResponse.json({ detail: "Not found" }, { status: 404 });
        }
        const health = url.searchParams.get("health") === "1";
        return HttpResponse.json({
          version,
          shortVersion: "4.2.0 (9f1c2ab)",
          dateCreated: "2026-11-13T18:00:00.000Z",
          dateReleased: "2026-11-13T18:05:00.000Z",
          newGroups: projects.reduce(
            (sum, { newGroups }) => sum + newGroups,
            0,
          ),
          deployCount: 2,
          lastDeploy: {
            id: "7",
            environment: "production",
            dateFinished: "2026-11-13T18:20:00.000Z",
            name: null,
          },
          authors: [{ email: "dev@example.com" }],
          projects: projects.map(({ health: data, ...rest }) => ({
            ...rest,
            name: rest.slug,
            hasHealthData: health,
            healthData: health
              ? { ...data, sessionsCrashed: 0, sessionsErrored: 0 }
              : null,
          })),
        });
      },
    ),
  );
  return { queries };
}

async function connectSentry(viewer: User, name: string) {
  await createUserTokenStore().set(viewer.id, "sentry", {
    accessToken: `${name}-token`,
    expiresAt: Date.now() + 3_600_000,
    refreshToken: `${name}-refresh`,
    scope: SENTRY_SCOPE,
  });
}

describe("Sentry release link cards", () => {
  beforeEach(async () => {
    vi.stubEnv("SENTRY_READ_TOKEN", ORG_READ_TOKEN);
    await createApp({
      dashboard: { disabled: true },
      plugins: defineJuniorPlugins([sentryPlugin()]),
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeDb();
  });

  it("draws a release card from the viewer's own read", async () => {
    const { queries } = fakeSentry({ alice: [11] });
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");

    const { body, objects } = await readLiveCards(alice, [RELEASE_URL]);

    expect(objects).toEqual([
      {
        url: RELEASE_URL,
        object: {
          kind: "object",
          objectType: "release",
          plugin: "sentry",
          key: expect.stringMatching(/^release:sentry\/:[0-9a-f]{32}$/),
          label: "4.2.0 (9f1c2ab)",
          title: VERSION,
          url: RELEASE_URL,
          displayType: "Sentry release",
          facts: {
            type: "release",
            version: VERSION,
            // As Sentry lists them for Alice, who sees one of the two.
            projects: ["checkout", "payments"],
            newIssues: 4,
            // The rate of all 4,000 sessions, not of one project.
            crashFreeSessions: 98,
            deployCount: 2,
            lastDeploy: {
              environment: "production",
              finishedAt: "2026-11-13T18:20:00.000Z",
            },
            releasedAt: "2026-11-13T18:05:00.000Z",
          },
        },
      },
    ]);
    expect(body).not.toContain("dev@example.com");
    // Alice's own token reads the release on the region host. Junior's org
    // read token reads no release.
    expect(queries).toEqual([
      `Bearer alice-token us.sentry.io/api/0/organizations/sentry/releases/${encodeURIComponent(VERSION)}/?health=1`,
    ]);
  });

  it("reads the numbers of the one project that a link is filtered to", async () => {
    fakeSentry({ alice: [11, 12] });
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");
    const url = `https://sentry.io/organizations/sentry/explore/releases/${encodeURIComponent(VERSION)}/commits/?project=12`;

    const { objects } = await readLiveCards(alice, [url]);

    expect(objects.map(({ object }) => [object.key, object.facts])).toEqual([
      [
        expect.stringMatching(/^release:sentry\/12:[0-9a-f]{32}$/),
        expect.objectContaining({
          projects: ["payments"],
          newIssues: 1,
          crashFreeSessions: 95,
        }),
      ],
    ]);
  });

  it("draws a release with the longest version that Sentry allows", async () => {
    const version = `checkout@${"9".repeat(241)}`;
    fakeSentry({ alice: [11] }, version);
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");
    const url = `https://sentry.sentry.io/releases/${encodeURIComponent(version)}/`;

    const { objects } = await readLiveCards(alice, [url]);

    expect(objects.map(({ object }) => object.objectType)).toEqual(["release"]);
  });

  it("shows nothing of a release to a viewer who cannot see its projects", async () => {
    const { queries } = fakeSentry({ alice: [11], bob: [99] });
    const alice = testViewer("alice@example.com");
    const bob = testViewer("bob@example.com");
    await connectSentry(alice, "alice");
    await connectSentry(bob, "bob");

    // Alice's cached release must not reach Bob.
    expect((await readLiveCards(alice, [RELEASE_URL])).objects).toHaveLength(1);
    const { body, objects } = await readLiveCards(bob, [RELEASE_URL]);

    expect(objects).toEqual([]);
    for (const text of ["checkout@4.2.0", "payments", "production"]) {
      expect(body).not.toContain(text);
    }
    expect(queries.filter((query) => query.includes("bob-token"))).toHaveLength(
      1,
    );
  });

  it("shows no release to a viewer who has not connected Sentry", async () => {
    const { queries } = fakeSentry({ alice: [11], carol: [11] });
    await connectSentry(testViewer("alice@example.com"), "alice");

    const { objects } = await readLiveCards(testViewer("carol@example.com"), [
      RELEASE_URL,
    ]);

    expect(objects).toEqual([]);
    expect(queries).toEqual([]);
  });

  it("reads each viewer's release once a minute", async () => {
    const { queries } = fakeSentry({ alice: [11] });
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");

    await readLiveCards(alice, [RELEASE_URL]);
    const { objects } = await readLiveCards(alice, [RELEASE_URL]);

    expect(objects).toHaveLength(1);
    expect(queries).toHaveLength(1);
  });
});
