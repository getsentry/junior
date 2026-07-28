import { useQuery } from "@tanstack/react-query";
import { Boxes } from "lucide-react";
import { Navigate, useParams } from "react-router";
import {
  pluginUserPageContentSchema,
  type PluginUserPageLink,
} from "@sentry/junior-plugin-api";

import { LoadingView } from "../../components/LoadingView";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { fetchDashboardJson } from "../../http";
import { dashboardContainerClass } from "../../styles";

/** Build the dashboard route for a plugin-owned user page. */
export function pluginUserPagePath(pluginName: string, pageId: string): string {
  return `/settings/plugins/${encodeURIComponent(pluginName)}/${encodeURIComponent(pageId)}`;
}

/** Render a plugin-owned user page from its bounded list response. */
export function PluginUserPage(props: { pages: PluginUserPageLink[] }) {
  const { pageId, pluginName } = useParams();
  const page = props.pages.find(
    (item) => item.pluginName === pluginName && item.id === pageId,
  );
  const query = useQuery({
    enabled: Boolean(page),
    queryKey: ["dashboard", "plugin-user-page", pluginName, pageId],
    queryFn: () =>
      fetchDashboardJson(
        pluginUserPageContentSchema,
        `/api/user-pages/${encodeURIComponent(pluginName!)}/${encodeURIComponent(pageId!)}`,
      ),
    retry: false,
  });

  if (!page) return <Navigate replace to="/" />;
  if (!query.data && !query.error) {
    return <LoadingView label={`Loading ${page.label}`} />;
  }

  return (
    <div className={`${dashboardContainerClass} px-4 py-8 md:px-8`}>
      <section className="mx-auto grid w-full max-w-3xl gap-6">
        <PageHeader
          description={page.description}
          eyebrow={page.pluginDisplayName}
          title={page.label}
        />
        {query.error ? (
          <Card padding="md">
            <p className="m-0 text-sm text-rose-300">
              Could not load {page.label.toLowerCase()}. Try again.
            </p>
          </Card>
        ) : query.data!.records.length === 0 ? (
          <Card padding="md">
            <div className="flex items-center gap-4">
              <div className="grid size-10 shrink-0 place-items-center rounded border border-white/[0.07] bg-white/[0.025] text-dashboard-text-muted">
                <Boxes aria-hidden="true" size={17} />
              </div>
              <p className="m-0 text-sm text-dashboard-text-muted">
                {query.data!.emptyText ?? `No ${page.label.toLowerCase()}.`}
              </p>
            </div>
          </Card>
        ) : (
          <div className="grid gap-3">
            {query.data!.records.map((record) => (
              <Card key={record.id} padding="md">
                <h2 className="m-0 font-display text-base font-medium text-dashboard-text">
                  {record.title}
                </h2>
                {record.description ? (
                  <p className="mt-2 mb-0 text-sm text-dashboard-text-muted">
                    {record.description}
                  </p>
                ) : null}
                {record.metadata?.length ? (
                  <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
                    {record.metadata.map((item) => (
                      <div key={item.label}>
                        <dt className="font-mono text-[0.58rem] uppercase tracking-[0.12em] text-dashboard-text-muted">
                          {item.label}
                        </dt>
                        <dd className="mt-1 ml-0 font-mono text-[0.68rem] text-dashboard-text-muted">
                          {item.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
