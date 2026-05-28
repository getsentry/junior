const GITHUB_API_HOST = "api.github.com";

interface EvalIssue {
  body: string;
  comments: number;
  created_at: string;
  html_url: string;
  id: number;
  node_id: string;
  number: number;
  state: "open" | "closed";
  title: string;
  updated_at: string;
  url: string;
  user: Record<string, unknown>;
}

let nextIssueNumber = 101;
const issues = new Map<string, EvalIssue>();
const textEncoder = new TextEncoder();

/** Reset mutable GitHub HTTP fixture state between test scenarios. */
export function resetTestGitHubHttpFixtures(): void {
  nextIssueNumber = 101;
  issues.clear();
}

function base64(input: string): string {
  const bytes = textEncoder.encode(input);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64Url(input: string): string {
  return base64(input)
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function json(value: unknown, init?: ResponseInit): Response {
  return Response.json(value, {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

function text(value: string, init?: ResponseInit): Response {
  return new Response(value, {
    ...init,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

function repoFromPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/repos\/([^/]+)\/([^/]+)(?:\/|$)/);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function issueUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/issues/${number}`;
}

function userPayload(login: string): Record<string, unknown> {
  return {
    login,
    id: 10_001,
    node_id: `U_${base64Url(login)}`,
    avatar_url: "https://avatars.githubusercontent.com/u/10001?v=4",
    url: `https://api.github.com/users/${login}`,
    html_url: `https://github.com/${login}`,
    type: "User",
    site_admin: false,
  };
}

function organizationPayload(login: string): Record<string, unknown> {
  return {
    ...userPayload(login),
    type: "Organization",
  };
}

function defaultIssue(repo: string, number: number): EvalIssue {
  const timestamp = "2026-05-27T00:00:00Z";
  return {
    id: 20_000 + number,
    node_id: `I_eval_${number}`,
    number,
    title: "Eval issue",
    body: "",
    state: "open",
    url: `https://api.github.com/repos/${repo}/issues/${number}`,
    html_url: issueUrl(repo, number),
    user: userPayload("junior-eval"),
    comments: 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function issueKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

async function requestJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function repoPayload(repo: string): Record<string, unknown> {
  const [owner, name] = repo.split("/");
  const ownerLogin = owner ?? "getsentry";
  const htmlUrl = `https://github.com/${repo}`;
  const apiUrl = `https://api.github.com/repos/${repo}`;
  return {
    id: 1_000,
    node_id: `R_${base64Url(repo)}`,
    name,
    full_name: repo,
    nameWithOwner: repo,
    private: false,
    owner: organizationPayload(ownerLogin),
    html_url: htmlUrl,
    description: "Junior eval repository fixture",
    fork: false,
    url: apiUrl,
    trees_url: `${apiUrl}/git/trees{/sha}`,
    contents_url: `${apiUrl}/contents/{+path}`,
    issues_url: `${apiUrl}/issues{/number}`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-05-27T00:00:00Z",
    pushed_at: "2026-05-27T00:00:00Z",
    git_url: `git://github.com/${repo}.git`,
    ssh_url: `git@github.com:${repo}.git`,
    clone_url: `${htmlUrl}.git`,
    svn_url: htmlUrl,
    homepage: null,
    size: 42,
    stargazers_count: 0,
    watchers_count: 0,
    language: "TypeScript",
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: 0,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: "public",
    forks: 0,
    open_issues: 0,
    watchers: 0,
    default_branch: "main",
    defaultBranchRef: { name: "main" },
    permissions: {
      admin: false,
      maintain: false,
      push: true,
      triage: true,
      pull: true,
    },
    organization: organizationPayload(ownerLogin),
    network_count: 0,
    subscribers_count: 0,
  };
}

function issuePayload(repo: string, issue: EvalIssue): Record<string, unknown> {
  return {
    ...issue,
    repository_url: `https://api.github.com/repos/${repo}`,
    labels_url: `https://api.github.com/repos/${repo}/issues/${issue.number}/labels{/name}`,
    comments_url: `https://api.github.com/repos/${repo}/issues/${issue.number}/comments`,
    events_url: `https://api.github.com/repos/${repo}/issues/${issue.number}/events`,
    labels: [],
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    closed_at: null,
    author_association: "MEMBER",
    active_lock_reason: null,
    draft: false,
    reactions: {
      url: `https://api.github.com/repos/${repo}/issues/${issue.number}/reactions`,
      total_count: 0,
      "+1": 0,
      "-1": 0,
      laugh: 0,
      hooray: 0,
      confused: 0,
      heart: 0,
      rocket: 0,
      eyes: 0,
    },
    timeline_url: `https://api.github.com/repos/${repo}/issues/${issue.number}/timeline`,
    performed_via_github_app: null,
    state_reason: null,
  };
}

function treePayload(): Record<string, unknown> {
  return {
    sha: "eval-main",
    truncated: false,
    tree: [],
  };
}

function contentPayload(pathname: string): Response | undefined {
  const match = pathname.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/);
  if (!match) return undefined;
  return json({ message: "Not Found" }, { status: 404 });
}

async function graphqlResponse(request: Request): Promise<Response> {
  const body = await requestJson(request);
  const query = String(body.query ?? "");
  const variables =
    body.variables && typeof body.variables === "object"
      ? (body.variables as Record<string, unknown>)
      : {};
  const repo =
    typeof variables.owner === "string" && typeof variables.name === "string"
      ? `${variables.owner}/${variables.name}`
      : "getsentry/junior";

  if (/createIssue/i.test(query)) {
    const input =
      variables.input && typeof variables.input === "object"
        ? (variables.input as Record<string, unknown>)
        : {};
    const number = nextIssueNumber++;
    const issue = {
      ...defaultIssue(repo, number),
      title: String(input.title ?? "Eval issue"),
      body: String(input.body ?? ""),
    };
    issues.set(issueKey(repo, number), issue);
    return json({
      data: {
        createIssue: {
          issue: {
            id: `I_eval_${number}`,
            number,
            title: issue.title,
            body: issue.body,
            url: issue.html_url,
          },
        },
      },
    });
  }

  return json({
    data: {
      repository: {
        ...repoPayload(repo),
        id: "R_eval",
        hasIssuesEnabled: true,
        issues: { nodes: [] },
        pullRequest: null,
      },
      viewer: { login: "junior-eval" },
    },
  });
}

async function githubResponse(
  request: Request,
  upstreamUrl: URL,
): Promise<Response> {
  if (request.method === "POST" && upstreamUrl.pathname === "/graphql") {
    return await graphqlResponse(request);
  }

  if (request.method === "GET" && upstreamUrl.pathname === "/user") {
    return json(userPayload("junior-eval"));
  }

  if (request.method === "GET" && upstreamUrl.pathname === "/search/issues") {
    return json({ total_count: 0, incomplete_results: false, items: [] });
  }

  const repo = repoFromPath(upstreamUrl.pathname);
  if (!repo) {
    return text(
      `Missing eval GitHub egress fixture for ${request.method} ${upstreamUrl.pathname}\n`,
      { status: 501 },
    );
  }

  if (request.method === "GET" && upstreamUrl.pathname === `/repos/${repo}`) {
    return json(repoPayload(repo));
  }

  if (
    request.method === "GET" &&
    upstreamUrl.pathname.match(/^\/repos\/[^/]+\/[^/]+\/git\/trees\/[^/]+$/)
  ) {
    return json(treePayload());
  }

  const content = contentPayload(upstreamUrl.pathname);
  if (request.method === "GET" && content) {
    return content;
  }

  if (upstreamUrl.pathname === `/repos/${repo}/issues`) {
    if (request.method === "GET") {
      return json(
        [...issues.values()]
          .filter((issue) => issue.url.includes(`/repos/${repo}/issues/`))
          .map((issue) => issuePayload(repo, issue)),
      );
    }

    if (request.method === "POST") {
      const body = await requestJson(request);
      const number = nextIssueNumber++;
      const issue = {
        ...defaultIssue(repo, number),
        title: String(body.title ?? "Eval issue"),
        body: String(body.body ?? ""),
      };
      issues.set(issueKey(repo, number), issue);
      return json(issuePayload(repo, issue), { status: 201 });
    }
  }

  const issueMatch = upstreamUrl.pathname.match(
    /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/,
  );
  if (issueMatch) {
    const number = Number.parseInt(issueMatch[2] ?? "", 10);
    const key = issueKey(repo, Number.isFinite(number) ? number : 1);
    const issue = issues.get(key) ?? defaultIssue(repo, number);
    if (request.method === "GET") return json(issuePayload(repo, issue));
    if (request.method === "PATCH") {
      const timestamp = "2026-05-27T00:01:00Z";
      const body = await requestJson(request);
      const updated: EvalIssue = {
        ...issue,
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.body === "string" ? { body: body.body } : {}),
        ...(body.state === "closed" || body.state === "open"
          ? { state: body.state }
          : {}),
        updated_at: timestamp,
      };
      issues.set(key, updated);
      return json(issuePayload(repo, updated));
    }
  }

  if (
    request.method === "POST" &&
    upstreamUrl.pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/)
  ) {
    const number =
      Number.parseInt(upstreamUrl.pathname.split("/").at(-2) ?? "", 10) || 1;
    return json(
      {
        id: 1,
        node_id: "IC_eval_1",
        url: `https://api.github.com/repos/${repo}/issues/comments/1`,
        issue_url: `https://api.github.com/repos/${repo}/issues/${number}`,
        html_url: `${issueUrl(repo, number)}#issuecomment-1`,
        user: userPayload("junior-eval"),
        created_at: "2026-05-27T00:01:00Z",
        updated_at: "2026-05-27T00:01:00Z",
        body: String((await requestJson(request)).body ?? ""),
      },
      { status: 201 },
    );
  }

  return text(
    `Missing eval GitHub egress fixture for ${request.method} ${upstreamUrl.pathname}\n`,
    { status: 501 },
  );
}

/** Intercept GitHub API traffic for test scenarios without shell command stubs. */
export async function interceptTestGitHubHttp(input: {
  provider: string;
  request: Request;
  upstreamUrl: URL;
}): Promise<Response | undefined> {
  if (
    input.provider !== "github" ||
    input.upstreamUrl.hostname !== GITHUB_API_HOST
  ) {
    return undefined;
  }

  return await githubResponse(input.request, input.upstreamUrl);
}
