import type { OwnedObjectAnnotation } from "@sentry/junior/api/schema";
import { AutomationCard } from "../components/AutomationCard";

/** Show the annotation snapshot saved with this Message, without provider fetches. */
export function ObjectCard({ card }: { card: OwnedObjectAnnotation }) {
  if (card.plugin === "junior" && card.objectType === "automation") {
    return (
      <AutomationCard
        card={{
          kind: "automation",
          id: card.key,
          title: card.title,
          url: card.url,
          instruction: card.description ?? "",
          trigger:
            card.fields?.find((field) => field.label === "When")?.value ?? "",
          warning:
            card.fields?.find((field) => field.label === "Needs attention")
              ?.value ?? null,
        }}
      />
    );
  }
  return (
    <section
      aria-label={card.title}
      className="my-1 max-w-lg rounded-lg border border-dashboard-border-emphasis bg-dashboard-surface-panel p-4 text-sm"
    >
      {card.url ? (
        <a
          href={card.url}
          target="_blank"
          rel="noreferrer"
          className="font-semibold text-dashboard-text hover:underline"
        >
          {card.title}
        </a>
      ) : (
        <strong>{card.title}</strong>
      )}
      <p className="mt-1 text-dashboard-text-muted">
        {card.label}
        {card.status ? ` · ${card.status}` : ""}
      </p>
      {card.fields?.length ? (
        <dl className="mt-2 space-y-1">
          {card.fields.map((field, index) => (
            <div key={index}>
              <dt className="inline text-dashboard-text-muted">
                {field.label}:{" "}
              </dt>
              <dd className="inline">{field.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}
