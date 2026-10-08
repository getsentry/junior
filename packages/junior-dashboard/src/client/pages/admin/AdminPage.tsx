import { Boxes, ChevronRight } from "lucide-react";
import { Link } from "react-router";
import type { PluginUserPageLink } from "@sentry/junior-plugin-api";

import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { dashboardContainerClass } from "../../styles";
import { pluginUserPagePath } from "../user/PluginUserPage";

/**
 * List admin-only plugin pages for a Junior admin.
 *
 * The server hides admin pages from other viewers and refuses to serve them,
 * so this page only arranges links.
 */
export function AdminPage(props: { pages: PluginUserPageLink[] }) {
  const adminPages = props.pages.filter((page) => page.navigation === "admin");
  return (
    <div className={`${dashboardContainerClass} px-4 py-8 md:px-8`}>
      <section className="mx-auto grid w-full max-w-3xl gap-6">
        <PageHeader
          description={
            <>
              Setup that only Junior admins can see. Change who is an admin with{" "}
              <code>junior admin grant &lt;email&gt;</code> and{" "}
              <code>junior admin revoke &lt;email&gt;</code>.
            </>
          }
          title="Admin"
        />
        {adminPages.length === 0 ? (
          <Card padding="md">
            <div className="flex items-center gap-4">
              <div className="grid size-10 shrink-0 place-items-center rounded border border-white/[0.07] bg-white/[0.025] text-dashboard-text-muted">
                <Boxes aria-hidden="true" size={17} />
              </div>
              <p className="m-0 text-sm text-dashboard-text-muted">
                No plugin has admin setup.
              </p>
            </div>
          </Card>
        ) : (
          <div className="grid gap-3">
            {adminPages.map((page) => (
              <Link
                className="no-underline"
                key={`${page.pluginName}:${page.id}`}
                to={pluginUserPagePath(page.pluginName, page.id)}
              >
                <Card padding="md">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-xs uppercase tracking-[0.12em] text-dashboard-text-muted">
                        {page.pluginDisplayName}
                      </div>
                      <h2 className="mt-1 mb-0 font-display text-base font-medium text-dashboard-text">
                        {page.label}
                      </h2>
                      <p className="mt-1 mb-0 text-sm text-dashboard-text-muted">
                        {page.description}
                      </p>
                    </div>
                    <ChevronRight
                      aria-hidden="true"
                      className="shrink-0 text-dashboard-text-muted"
                      size={16}
                    />
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
