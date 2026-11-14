import { getDashboardAgentName } from "../../agentName";
import { CopyButton } from "../../components/CopyButton";
import { AnchorHeading } from "../../components/layout/AnchorHeading";
import { dashboardInlineLinkClass } from "../../styles";
import { SettingsSection } from "./SettingsPageLayout";
import { OutboundLink } from "../../components/OutboundLink";

const MCP_DOCS_URL = "https://junior.sentry.dev/operate/mcp-server/";

/** Name the MCP server entry after the agent, for example `junior`. */
function mcpServerName(): string {
  return (
    getDashboardAgentName()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "junior"
  );
}

function ConfigBlock(props: { anchor: string; label: string; value: string }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <AnchorHeading
          anchor={props.anchor}
          className="m-0 text-sm font-semibold"
          title={props.label}
        />
        <CopyButton getText={() => props.value} label={`Copy ${props.label}`} />
      </div>
      <pre className="mt-2 mb-0 whitespace-pre-wrap break-words rounded-md border border-dashboard-border-emphasis bg-dashboard-ink p-3 font-mono text-xs text-dashboard-text">
        {props.value}
      </pre>
    </div>
  );
}

/** Show the MCP server URL and client config for this deployment. */
export function McpSettings() {
  // The dashboard redirects to its canonical origin, which also serves MCP.
  const url = new URL("/api/mcp", window.location.origin).toString();
  const name = mcpServerName();
  const jsonConfig = JSON.stringify(
    { mcpServers: { [name]: { type: "http", url } } },
    null,
    2,
  );

  return (
    <SettingsSection
      anchor="mcp"
      description={
        <>
          Connect Claude Code or another MCP client to list your{" "}
          {getDashboardAgentName()} conversations. The client signs in through
          this dashboard. Personal API tokens do not work here.
        </>
      }
      title="MCP"
    >
      <div className="grid gap-5">
        <ConfigBlock anchor="server-url" label="Server URL" value={url} />
        <ConfigBlock
          anchor="claude-code"
          label="Claude Code"
          value={`claude mcp add --transport http ${name} ${url}`}
        />
        <ConfigBlock
          anchor="json-config"
          label="JSON config"
          value={jsonConfig}
        />
      </div>

      <p className="m-0 text-sm text-dashboard-text-muted">
        The client must support OAuth with Client ID Metadata Documents.{" "}
        <OutboundLink className={dashboardInlineLinkClass} href={MCP_DOCS_URL}>
          Read the MCP server docs
        </OutboundLink>
        .
      </p>
    </SettingsSection>
  );
}
