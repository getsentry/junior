/**
 * Turn an Event type into a short label. Where it shows, the resource is
 * already named, so `pull_request.checks.failed` reads as "checks failed".
 */
export function eventLabel(eventType: string, resourceType: string): string {
  const parts = eventType.split(".");
  const rest =
    parts[0] === resourceType && parts.length > 1 ? parts.slice(1) : parts;
  return rest.join(" ").replaceAll("_", " ");
}
