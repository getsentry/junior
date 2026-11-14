// Issues that a `Junior: repro` label run of the sdk-repro skill reads. The
// host's GitHub tools and `gh` in the sandbox both read them, so each
// process that serves GitHub serves the same issues and logs its own writes.
// #10: no existing work. #11: no setup; a bot adds the label. #12: open PR
// #14 closes it. #13: a progress comment from a run that started 30 minutes
// ago.
const repo = "getsentry/sdk-repro-test-python";
const web = `https://github.com/${repo}`;
const api = `/repos/${repo}`;

// The App bot of the skill. The id is the one in `GITHUB_APP_BOT_EMAIL` of
// the evals, so `github_updateIssueComment` can edit its comments.
const bot = { id: 12345, login: "sentry-junior[bot]", type: "Bot" };
const maintainer = { id: 20001, login: "sdk-maintainer", type: "User" };
const reporter = { id: 20002, login: "sdk-user", type: "User" };

/** A write that reached the fake GitHub of the sdk-repro scenario. */
export interface GitHubSdkReproWrite {
  body: unknown;
  method: string;
  path: string;
}

let writes: GitHubSdkReproWrite[] = [];
let nextCommentId = 5001;
const postedComments = new Map<number, { body: string; issue: number }>();

/** Clear the writes and comments of the last scenario. */
export function resetTestGitHubSdkReproFixtures(): void {
  writes = [];
  nextCommentId = 5001;
  postedComments.clear();
}

/** Writes that this process served, oldest first. */
export function readTestGitHubSdkReproWrites(): GitHubSdkReproWrite[] {
  return [...writes];
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function issue(number: number) {
  return {
    assignees: [],
    body: '`sentry_sdk.set_tag("team", "")` drops the tag. Events have no `team` tag. Expected a tag with an empty value.\n\nsentry-sdk 2.40.0, Python 3.12.',
    comments: number === 13 ? 1 : 0,
    created_at: "2026-10-01T09:00:00Z",
    html_url: `${web}/issues/${number}`,
    labels: [{ name: "Junior: repro" }],
    number,
    repository_url: `https://api.github.com${api}`,
    state: "open",
    title: "set_tag drops tags with an empty value",
    updated_at: "2026-10-01T09:00:00Z",
    url: `https://api.github.com${api}/issues/${number}`,
    user: reporter,
  };
}

const pullRequest = {
  body: "Keep tags whose value is an empty string.\n\nresolves: #12",
  html_url: `${web}/pull/14`,
  number: 14,
  state: "open",
  title: "fix: Keep tags with an empty value",
  user: reporter,
};

function seededComments(number: number) {
  if (number !== 13) return [];
  const started = minutesAgo(30);
  return [
    {
      body: `<!-- sdk-repro -->\nJunior is working on this (requested by @${maintainer.login}), started ${started.slice(11, 16)} UTC.\n- [ ] Reproduced: \n- [ ] Fix and regression test\n- [ ] Draft PR`,
      created_at: started,
      html_url: `${web}/issues/13#issuecomment-4001`,
      id: 4001,
      updated_at: started,
      user: bot,
    },
  ];
}

// The seeded comments with their edits, then the comments that the run posted.
function comments(number: number) {
  const seeded = seededComments(number).map((entry) => {
    const edited = postedComments.get(entry.id);
    return edited ? { ...entry, body: edited.body } : entry;
  });
  const posted = [...postedComments]
    .filter(([id, entry]) => entry.issue === number && id !== 4001)
    .map(([id, entry]) => botComment(id, entry));
  return [...seeded, ...posted];
}

function timeline(number: number) {
  if (number !== 12) return [];
  return [
    {
      actor: reporter,
      created_at: "2026-10-05T10:00:00Z",
      event: "cross-referenced",
      source: {
        issue: {
          ...pullRequest,
          pull_request: {
            html_url: pullRequest.html_url,
            merged_at: null,
            url: `https://api.github.com${api}/pulls/14`,
          },
          repository: { full_name: repo, html_url: web },
        },
        type: "issue",
      },
      updated_at: "2026-10-05T10:00:00Z",
    },
  ];
}

function graphqlPullRequest() {
  return {
    author: { login: reporter.login },
    baseRefName: "main",
    body: pullRequest.body,
    closingIssuesReferences: {
      nodes: [
        {
          id: "I_sdk_repro_12",
          number: 12,
          repository: {
            id: "R_sdk_repro",
            name: "sdk-repro-test-python",
            owner: { id: "O_getsentry", login: "getsentry" },
          },
          url: `${web}/issues/12`,
        },
      ],
      pageInfo: { endCursor: null, hasNextPage: false },
    },
    headRefName: "fix/empty-tag-value",
    id: "PR_sdk_repro_14",
    isDraft: false,
    number: 14,
    state: "OPEN",
    title: pullRequest.title,
    url: pullRequest.html_url,
  };
}

function botComment(id: number, entry: { body: string; issue: number }) {
  const now = new Date().toISOString();
  return {
    body: entry.body,
    created_at: now,
    html_url: `${web}/issues/${entry.issue}#issuecomment-${id}`,
    id,
    issue_url: `https://api.github.com${api}/issues/${entry.issue}`,
    updated_at: now,
    user: bot,
  };
}

async function requestBody(request: Request): Promise<unknown> {
  const text = await request.clone().text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function bodyText(body: unknown): string {
  return body && typeof body === "object" && "body" in body
    ? String(body.body)
    : "";
}

/** Serve the sdk-repro scenario's issues, PR, people, and issue writes. */
export async function interceptTestGitHubSdkReproHttp(
  request: Request,
  url: URL,
): Promise<Response | undefined> {
  if (url.hostname !== "api.github.com") return undefined;
  const path = url.pathname;

  if (request.method === "POST" && path === "/graphql") {
    const body = (await request.clone().json()) as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    const text = `${body.query ?? ""} ${JSON.stringify(body.variables ?? {})}`;
    if (
      /\bmutation\b/.test(body.query ?? "") ||
      !/\bpullRequest\s*\(/.test(body.query ?? "") ||
      !text.includes("sdk-repro-test-python") ||
      !Object.values(body.variables ?? {}).includes(14)
    ) {
      return undefined;
    }
    return Response.json({
      data: { repository: { pullRequest: graphqlPullRequest() } },
    });
  }

  if (path.startsWith("/orgs/getsentry/members/")) {
    const login = decodeURIComponent(path.split("/").at(-1) ?? "");
    return login === maintainer.login
      ? new Response(null, { status: 204 })
      : Response.json({ message: "Not Found" }, { status: 404 });
  }

  if (!path.startsWith(`${api}/`)) return undefined;

  if (request.method !== "GET") {
    const body = await requestBody(request);
    writes.push({ body, method: request.method, path });
    const created = path.match(/\/issues\/(\d+)\/(comments|reactions)$/);
    if (request.method === "POST" && created?.[2] === "reactions") {
      const content = (body as { content?: unknown }).content;
      return Response.json(
        { content, id: 9000 + writes.length, user: bot },
        {
          status: 201,
        },
      );
    }
    if (request.method === "POST" && created?.[2] === "comments") {
      const id = nextCommentId++;
      const entry = { body: bodyText(body), issue: Number(created[1]) };
      postedComments.set(id, entry);
      return Response.json(botComment(id, entry), { status: 201 });
    }
    const edited = path.match(/\/issues\/comments\/(\d+)$/);
    if (request.method === "PATCH" && edited) {
      const id = Number(edited[1]);
      const issueNumber = id === 4001 ? 13 : postedComments.get(id)?.issue;
      if (issueNumber === undefined) {
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      const entry = { body: bodyText(body), issue: issueNumber };
      postedComments.set(id, entry);
      return Response.json(botComment(id, entry));
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  }

  const collaborator = path.match(/\/collaborators\/([^/]+)\/permission$/);
  if (collaborator) {
    const login = decodeURIComponent(collaborator[1] ?? "");
    const role = login === maintainer.login ? "write" : "read";
    return Response.json({
      permission: role,
      role_name: role,
      user: { login },
    });
  }

  const comment = path.match(/\/issues\/comments\/(\d+)$/);
  if (comment) {
    const id = Number(comment[1]);
    const entry = postedComments.has(id)
      ? comments(postedComments.get(id)!.issue).find((item) => item.id === id)
      : seededComments(13).find((item) => item.id === id);
    return entry
      ? Response.json(entry)
      : Response.json({ message: "Not Found" }, { status: 404 });
  }

  const read = path.match(
    /\/issues\/(1[0-3])(?:\/(comments|timeline|reactions))?$/,
  );
  if (read) {
    const number = Number(read[1]);
    if (read[2] === "comments") return Response.json(comments(number));
    if (read[2] === "timeline") return Response.json(timeline(number));
    if (read[2] === "reactions") return Response.json([]);
    return Response.json(issue(number));
  }

  if (path === `${api}/pulls/14` || path === `${api}/issues/14`) {
    return Response.json({
      ...pullRequest,
      draft: false,
      head: { ref: "fix/empty-tag-value" },
      base: { ref: "main" },
      merged: false,
    });
  }
  return undefined;
}
