import { jsonResponse } from "@sentry/junior/api";
import { apiErrorSchema } from "@sentry/junior/api/schema";

/** Answer a mock API request with the API's error body. */
export function errorResponse(
  error: string,
  status: 400 | 401 | 403 | 404 | 409,
): Response {
  return jsonResponse(apiErrorSchema, { error }, { status });
}
