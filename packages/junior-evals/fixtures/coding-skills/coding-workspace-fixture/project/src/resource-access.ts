export type Resource = {
  id: string;
  organizationId: string;
  projectId: string;
};

/** Return the resource owned by the given organization and project. */
export function getResource(
  resources: readonly Resource[],
  organizationId: string,
  projectId: string,
  resourceId: string,
): Resource | undefined {
  return resources.find((resource) => resource.id === resourceId);
}
