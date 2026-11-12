import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readGoogleConfig } from "../src/config";
import { saveGoogleAccount } from "../src/store";
import { runVerifySearch, SEARCH_FIXTURE_CASES } from "../src/verify-search";
import {
  ACCOUNT_EMAIL,
  API_SCOPES,
  createGoogleDb,
  stubGoogleEnv,
} from "./fixture";

const MARKER = "jrsearchcheck";
const REQUESTER = "alice@example.com";

const companyFile = (name: string) => ({
  id: name,
  mimeType: "application/vnd.google-apps.document",
  name: `${MARKER} ${name}`,
  owners: [{ emailAddress: "owner@example.com" }],
});

/**
 * A fake Drive that answers the named and findable searches with the given
 * files.
 */
function fakeDrive(input: {
  findable: object[];
  named: object[];
  unsupportedStatus?: number;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: string | URL | Request) => {
      const url = new URL(request instanceof Request ? request.url : request);
      if (url.hostname === "oauth2.googleapis.com") {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      if (url.pathname !== "/drive/v3/files") {
        const name = url.pathname.split("/").pop()!;
        return Response.json({
          capabilities: { canEdit: !name.startsWith("view-only") },
          name: `${MARKER} ${name}`,
        });
      }
      const q = url.searchParams.get("q")!;
      if (q.includes("juniorUnsupportedTerm")) {
        return Response.json({}, { status: input.unsupportedStatus ?? 400 });
      }
      return Response.json({
        files: q.includes("in readers") ? input.named : input.findable,
      });
    }),
  );
}

describe("verify-search", () => {
  let fixture: Awaited<ReturnType<typeof createGoogleDb>>;
  let fixtures: string;

  beforeEach(async () => {
    stubGoogleEnv();
    fixture = await createGoogleDb();
    await saveGoogleAccount(fixture.db(), {
      accountEmail: ACCOUNT_EMAIL,
      connectedAtMs: 0,
      connectedBy: "cli:test",
      refreshToken: "refresh-token",
      scope: API_SCOPES,
    });
    fixtures = join(await mkdtemp(join(tmpdir(), "verify-search-")), "f.json");
    await writeFile(
      fixtures,
      JSON.stringify({
        files: Object.fromEntries(
          Object.keys(SEARCH_FIXTURE_CASES).map((name) => [name, name]),
        ),
        marker: MARKER,
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await fixture.close();
  });

  async function verify() {
    const output: string[] = [];
    const code = await runVerifySearch(
      {
        db: fixture.db(),
        io: {
          writeError: async (text: string) => void output.push(text),
          writeOutput: async (text: string) => void output.push(text),
        },
      } as never,
      readGoogleConfig()!,
      { fixtures, requester: REQUESTER },
    );
    return { code, output: output.join("") };
  }

  it("passes when the owner guard drops external and shared-drive files", async () => {
    fakeDrive({
      findable: [
        companyFile("domain-findable"),
        companyFile("anyone-findable"),
        companyFile("view-only-findable"),
        {
          ...companyFile("external-domain-findable"),
          owners: [{ emailAddress: "someone@other.com" }],
        },
        { ...companyFile("shared-drive"), driveId: "drive", owners: undefined },
      ],
      named: [companyFile("shared-with-requester")],
    });
    const { code, output } = await verify();
    expect(output).toContain(
      "external-domain-findable: expected=hidden result=ok",
    );
    expect(output).toContain("shared-drive: expected=hidden result=ok");
    expect(code).toBe(0);
  });

  it("fails when Google returns a link-only file, or ignores an unsupported term", async () => {
    fakeDrive({
      findable: [
        companyFile("domain-findable"),
        companyFile("domain-with-link"),
      ],
      named: [],
    });
    const leaked = await verify();
    expect(leaked.output).toContain(
      "domain-with-link: expected=hidden result=LEAK",
    );
    expect(leaked.code).toBe(1);

    fakeDrive({ findable: [], named: [], unsupportedStatus: 200 });
    const ignored = await verify();
    expect(ignored.output).toContain("unsupported term");
    expect(ignored.code).toBe(1);
  });
});
