import { readSpace, type Space } from "@/chat/spaces/store";
import { jsonResponse, throwApiError } from "../http";
import {
  spaceParamsSchema,
  spaceSchema,
  type SpaceReport,
} from "../schema/space";
import { validateRequest } from "../validation";

/** Validate the `:spaceId` route parameter. */
export const spaceParamsValidator = validateRequest(
  "param",
  spaceParamsSchema,
  "Invalid route parameters.",
);

/** Write one Space as the API reports it. */
export function spaceReport(space: Space): SpaceReport {
  return {
    ...space,
    createdAt: space.createdAt.toISOString(),
    updatedAt: space.updatedAt.toISOString(),
    archivedAt: space.archivedAt?.toISOString() ?? null,
  };
}

/**
 * Return the Space that the viewer reads, or a 404. A private Space is a 404
 * to a person who is not a member, so the error does not show it exists.
 */
export async function requireSpace(
  viewerUserId: string,
  spaceId: string,
): Promise<Space> {
  const space = await readSpace(viewerUserId, spaceId);
  if (!space) throwApiError(404, "Space was not found.");
  return space;
}

/**
 * Return the Space that the viewer changes. Anyone can read a public Space,
 * but only members change a Space.
 */
export async function requireMemberSpace(
  viewerUserId: string,
  spaceId: string,
): Promise<Space> {
  const space = await requireSpace(viewerUserId, spaceId);
  if (!space.viewerIsMember) {
    throwApiError(403, "Join the Space to change it.");
  }
  return space;
}

/** Respond with the Space as the viewer sees it now. */
export async function spaceResponse(
  viewerUserId: string,
  spaceId: string,
  init?: ResponseInit,
): Promise<Response> {
  return jsonResponse(
    spaceSchema,
    spaceReport(await requireSpace(viewerUserId, spaceId)),
    init,
  );
}
