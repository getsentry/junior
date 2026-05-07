import { escapeXml as esc } from "@/chat/xml";
import { GET as diagnosticsGET } from "@/handlers/diagnostics";
import { GET as healthGET } from "@/handlers/health";

/** Serve an HTML diagnostics dashboard showing health, plugins, and skills. */
export async function GET(): Promise<Response> {
  let health: { ok: boolean; data?: Record<string, unknown>; error?: string };
  let discovery: {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: string;
  };

  try {
    const res = await healthGET();
    health = {
      ok: res.ok,
      data: (await res.json()) as Record<string, unknown>,
    };
  } catch (e: unknown) {
    health = { ok: false, error: String(e) };
  }

  try {
    const res = await diagnosticsGET();
    if (res.ok) {
      discovery = {
        ok: true,
        data: (await res.json()) as Record<string, unknown>,
      };
    } else {
      discovery = { ok: false, error: `${res.status} ${res.statusText}` };
    }
  } catch (e: unknown) {
    discovery = { ok: false, error: String(e) };
  }

  const d = discovery.ok ? discovery.data : null;

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Junior</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: "SF Mono", "Cascadia Code", "Fira Code", Menlo, monospace;
      background: #0d1117; color: #c9d1d9; padding: 2rem;
      font-size: 14px; line-height: 1.6;
    }
    h1 { color: #58a6ff; font-size: 1.1rem; margin-bottom: 0.25rem; }
    .subtitle { color: #8b949e; font-size: 0.85rem; margin-bottom: 1.5rem; }
    .section { max-width: 720px; margin-bottom: 1.25rem; }
    .section-title {
      color: #8b949e; font-size: 0.75rem; text-transform: uppercase;
      letter-spacing: 0.08em; margin-bottom: 0.5rem; padding-bottom: 0.25rem;
      border-bottom: 1px solid #21262d;
    }
    .status-row { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.35rem; }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .dot-ok { background: #2dd4bf; }
    .dot-err { background: #f87171; }
    .label { color: #8b949e; }
    .value { color: #e6edf3; }
    .detail-row { display: flex; gap: 0.5rem; margin-bottom: 0.25rem; font-size: 0.85rem; }
    .detail-key { color: #8b949e; min-width: 7rem; }
    .detail-val { color: #c9d1d9; }
    .skill-grid { display: flex; flex-wrap: wrap; gap: 0.4rem; }
    .skill-tag {
      background: #161b22; border: 1px solid #30363d; border-radius: 4px;
      padding: 0.2rem 0.5rem; font-size: 0.8rem; color: #c9d1d9;
    }
    .skill-provider { color: #8b949e; font-size: 0.7rem; margin-left: 0.15rem; }
    .provider-list, .package-list { display: flex; flex-wrap: wrap; gap: 0.4rem; }
    .provider-tag {
      background: #1b2332; border: 1px solid #1f3a5f; border-radius: 4px;
      padding: 0.2rem 0.5rem; font-size: 0.8rem; color: #58a6ff;
    }
    .package-tag {
      background: #1a1e2a; border: 1px solid #2d3548; border-radius: 4px;
      padding: 0.2rem 0.5rem; font-size: 0.78rem; color: #a5b4cf;
    }
    .endpoint-list { list-style: none; }
    .endpoint-list li { margin-bottom: 0.2rem; font-size: 0.85rem; }
    .method {
      display: inline-block; font-size: 0.7rem; font-weight: 600;
      padding: 0.1rem 0.35rem; border-radius: 3px; margin-right: 0.4rem;
      min-width: 2.5rem; text-align: center;
    }
    .method-get { background: #1b3a2d; color: #2dd4bf; }
    .method-post { background: #3b2e1a; color: #f0b952; }
    .endpoint-link { color: #c9d1d9; text-decoration: none; }
    .endpoint-link:hover { color: #58a6ff; text-decoration: underline; }
    .error-msg { color: #f87171; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>&gt; junior</h1>`;

  if (d?.descriptionText) {
    html += `\n  <div class="subtitle">${esc(String(d.descriptionText))}</div>`;
  }

  // Status section
  html += `\n  <div class="section">
    <div class="section-title">Status</div>
    <div class="status-row">
      <span class="dot ${health.ok ? "dot-ok" : "dot-err"}"></span>
      <span class="value">${health.ok ? "Healthy" : "Unreachable"}</span>`;
  if (health.ok && health.data?.timestamp) {
    html += `\n      <span class="label">&middot; ${esc(new Date(health.data.timestamp as string).toLocaleTimeString())}</span>`;
  }
  html += `\n    </div>`;
  if (d) {
    html += `\n    <div class="detail-row"><span class="detail-key">service</span><span class="detail-val">${esc(String(health.data?.service ?? "junior"))}</span></div>`;
    html += `\n    <div class="detail-row"><span class="detail-key">cwd</span><span class="detail-val">${esc(String(d.cwd))}</span></div>`;
    html += `\n    <div class="detail-row"><span class="detail-key">home</span><span class="detail-val">${esc(String(d.homeDir))}</span></div>`;
  }
  html += `\n  </div>`;

  // Endpoints section
  const endpoints = [
    { method: "GET", path: "/health" },
    { method: "GET", path: "/api/info" },
    { method: "GET", path: "/api/oauth/callback/mcp/:provider" },
    { method: "GET", path: "/api/oauth/callback/:provider" },
    { method: "POST", path: "/api/webhooks/:platform" },
  ];
  html += `\n  <div class="section">
    <div class="section-title">Endpoints</div>
    <ul class="endpoint-list">`;
  for (const ep of endpoints) {
    const cls = ep.method === "GET" ? "method-get" : "method-post";
    const link = ep.path.includes(":")
      ? `<span>${esc(ep.path)}</span>`
      : `<a class="endpoint-link" href="${esc(ep.path)}" target="_blank">${esc(ep.path)}</a>`;
    html += `\n      <li><span class="method ${cls}">${esc(ep.method)}</span>${link}</li>`;
  }
  html += `\n    </ul>\n  </div>`;

  if (d) {
    const providers = d.providers as string[] | undefined;
    const packagedContent = d.packagedContent as
      | { packageNames?: string[] }
      | undefined;
    const skills = d.skills as
      | Array<{ name: string; pluginProvider?: string }>
      | undefined;

    if (providers?.length) {
      html += `\n  <div class="section">
    <div class="section-title">Plugins <span class="label">(${providers.length})</span></div>
    <div class="provider-list">`;
      for (const p of providers) {
        html += `\n      <span class="provider-tag">${esc(p)}</span>`;
      }
      html += `\n    </div>`;
      if (packagedContent?.packageNames?.length) {
        html += `\n    <div style="margin-top:0.5rem"><div class="package-list">`;
        for (const pkg of packagedContent.packageNames) {
          html += `\n      <span class="package-tag">${esc(pkg)}</span>`;
        }
        html += `\n    </div></div>`;
      }
      html += `\n  </div>`;
    }

    if (skills?.length) {
      html += `\n  <div class="section">
    <div class="section-title">Skills <span class="label">(${skills.length})</span></div>
    <div class="skill-grid">`;
      for (const s of skills) {
        html += `\n      <span class="skill-tag">${esc(s.name)}`;
        if (s.pluginProvider) {
          html += ` <span class="skill-provider">${esc(s.pluginProvider)}</span>`;
        }
        html += `</span>`;
      }
      html += `\n    </div>\n  </div>`;
    }
  } else if (!discovery.ok) {
    html += `\n  <div class="section">
    <div class="section-title">Discovery</div>
    <span class="error-msg">unavailable &middot; ${esc(discovery.error ?? "unknown")}</span>
  </div>`;
  }

  html += `\n</body>\n</html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
