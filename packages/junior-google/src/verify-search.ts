/**
 * Live check for `searchGoogleFiles`, run as Junior's Google account.
 *
 * Google documents the Drive search terms that search relies on, but not how
 * they behave for every sharing setup. This check runs the real search
 * against fixture files with known sharing, and fails when search shows a
 * file that the requester must not find.
 */
import { readFile } from "node:fs/promises";
import type {
  PluginCliActionContext,
  PluginEgress,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  emailDomain,
  GOOGLE_DRIVE_SEARCH_ENV,
  type GoogleConfig,
} from "./config";
import { refreshGoogleAccessToken } from "./oauth";
import { getGoogleAccount, type GoogleDb } from "./store";
import { GOOGLE_FILE_TYPES } from "./tools/files";
import { searchFindableFiles } from "./tools/search-files";
import { googleApiRequest } from "./tools/shared";

/**
 * One fixture file per sharing case. A company account other than Junior's
 * and the requester's owns each file, except where the setup says otherwise.
 */
export const SEARCH_FIXTURE_CASES = {
  private: {
    setup: "Shared with Junior's account only.",
    shown: false,
  },
  "shared-with-requester": {
    setup: "Shared with Junior's account and with the requester by email.",
    shown: true,
  },
  "group-only": {
    setup:
      "Shared with Junior's account and with a group that the requester is in. Not shared with the requester by email.",
    shown: false,
  },
  "domain-with-link": {
    setup:
      "Shared with Junior's account. General access: anyone in the company with the link.",
    shown: false,
  },
  "domain-findable": {
    setup:
      "Shared with Junior's account. General access: anyone in the company can find and open it.",
    shown: true,
  },
  "anyone-with-link": {
    setup:
      "Shared with Junior's account. General access: anyone on the internet with the link.",
    shown: false,
  },
  "anyone-findable": {
    setup:
      "Shared with Junior's account. General access: public on the web, findable.",
    shown: true,
  },
  "external-domain-findable": {
    setup:
      "Owned by an account outside the allowed domains. Findable by anyone in that account's domain, and shared with Junior's account.",
    shown: false,
  },
  "shared-drive": {
    setup:
      "In a shared drive that Junior's account is a member of and the requester is not. General access: anyone in the company can find it.",
    shown: false,
  },
  "view-only": {
    setup:
      "Shared with Junior's account as a viewer only, and with nobody else.",
    shown: false,
  },
  "view-only-findable": {
    setup:
      "Shared with Junior's account as a viewer only. General access: anyone in the company can find it.",
    shown: true,
  },
} as const;

type FixtureCase = keyof typeof SEARCH_FIXTURE_CASES;

const fixturesSchema = z
  .object({
    /** A word that every fixture title contains, and no other file. */
    marker: z.string().regex(/^[A-Za-z0-9]{8,}$/),
    files: z
      .object(
        Object.fromEntries(
          Object.keys(SEARCH_FIXTURE_CASES).map((name) => [name, z.string()]),
        ) as Record<FixtureCase, z.ZodString>,
      )
      .strict(),
  })
  .strict();

const fileSchema = z.object({
  capabilities: z.object({ canEdit: z.boolean().optional() }).optional(),
  name: z.string(),
});

/** Call Google directly with Junior's access token, as host egress does. */
function directEgress(accessToken: string): PluginEgress {
  return {
    async fetch({ request }) {
      const authorized = new Request(request);
      authorized.headers.set("Authorization", `Bearer ${accessToken}`);
      return await fetch(authorized);
    },
  };
}

/**
 * Run the live search check. Returns the process exit code: 0 when no
 * fixture leaks, 1 otherwise.
 */
export async function runVerifySearch(
  ctx: PluginCliActionContext,
  config: GoogleConfig,
  options: { fixtures: string; requester: string },
): Promise<number> {
  const fail = async (message: string) => {
    await ctx.io.writeError(`${message}\n`);
    return 1;
  };
  const requester = options.requester.trim().toLowerCase();
  const domain = emailDomain(requester);
  if (!domain || !config.allowedDomains.includes(domain)) {
    return await fail(
      `--requester must be an email at ${config.allowedDomains.join(", ")}.`,
    );
  }
  const fixtures = fixturesSchema.safeParse(
    JSON.parse(await readFile(options.fixtures, "utf8")),
  );
  if (!fixtures.success) {
    return await fail(
      `${options.fixtures} must list a marker and one file id for each case: ${Object.keys(SEARCH_FIXTURE_CASES).join(", ")}.`,
    );
  }
  const { files, marker } = fixtures.data;

  const record = await getGoogleAccount(
    ctx.db as GoogleDb,
    config.accountEmail,
  );
  const token =
    record &&
    (await refreshGoogleAccessToken({
      config,
      refreshToken: record.refreshToken,
    }));
  if (!token) {
    return await fail(
      `${config.accountEmail} is not connected. Run \`junior google connect\`.`,
    );
  }
  const toolCtx = {
    allowedDomains: config.allowedDomains,
    egress: directEgress(token.accessToken),
  };

  // A fixture that Junior's account cannot open proves nothing.
  for (const [name, fileId] of Object.entries(files)) {
    const response = await googleApiRequest(toolCtx, {
      operation: "google.drive.file.get",
      path: `/drive/v3/files/${fileId}`,
      query: {
        fields: "capabilities(canEdit),name",
        supportsAllDrives: "true",
      },
    });
    const file = fileSchema.safeParse(response.body);
    if (response.status !== 200 || !file.success) {
      return await fail(
        `Fixture ${name}: ${config.accountEmail} cannot open ${fileId} (HTTP ${response.status}).`,
      );
    }
    if (!file.data.name.includes(marker)) {
      return await fail(`Fixture ${name}: the title must contain ${marker}.`);
    }
    if (name.startsWith("view-only") && file.data.capabilities?.canEdit) {
      return await fail(
        `Fixture ${name}: ${config.accountEmail} can edit it. Share it as a viewer only.`,
      );
    }
  }

  // Search is safe only if Google rejects a term it does not support.
  const unsupported = await googleApiRequest(toolCtx, {
    operation: "google.drive.files.list",
    path: "/drive/v3/files",
    query: {
      q: `fullText contains '${marker}' and juniorUnsupportedTerm = 'x'`,
    },
  });
  if (unsupported.status !== 400) {
    return await fail(
      `Google answered HTTP ${unsupported.status} to a query with an unsupported term, not 400. Search must stay off.`,
    );
  }

  const found = await searchFindableFiles(toolCtx, {
    maxResults: 50,
    query: marker,
    requester,
    types: GOOGLE_FILE_TYPES,
  });
  if (!found) {
    return await fail(
      "Google rejected the search query. Search must stay off.",
    );
  }
  const shownIds = new Set(found.files.map((file) => file.id));
  const lines: string[] = [];
  let leaks = 0;
  let foundExpected = 0;
  for (const [name, fileId] of Object.entries(files)) {
    const expected = SEARCH_FIXTURE_CASES[name as FixtureCase].shown;
    const shown = shownIds.has(fileId);
    if (shown && !expected) leaks += 1;
    if (shown && expected) foundExpected += 1;
    const result = shown === expected ? "ok" : shown ? "LEAK" : "not found";
    lines.push(
      `${name}: expected=${expected ? "shown" : "hidden"} result=${result}`,
    );
  }
  await ctx.io.writeOutput(`${lines.join("\n")}\n`);
  if (leaks > 0) {
    return await fail(`${leaks} fixture(s) leaked. Search must stay off.`);
  }
  // With no expected file found, the check cannot tell a filter that works
  // from a search that finds nothing.
  if (foundExpected === 0) {
    return await fail(
      "Search found none of the files it should show, so the check proves nothing. Make sure Drive has indexed the fixtures, then run it again.",
    );
  }
  await ctx.io.writeOutput(
    `No fixture leaked. You can set ${GOOGLE_DRIVE_SEARCH_ENV}=true.\n`,
  );
  return 0;
}
