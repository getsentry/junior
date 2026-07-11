/** Serve the dashboard people list endpoint from the SQL-backed people API. */
export async function peopleListResponse(): Promise<Response> {
  try {
    const { readPeopleList } = await import("@sentry/junior/api/people/list");
    return Response.json(await readPeopleList());
  } catch (error) {
    console.error("Failed to load people list", error);
    return Response.json(
      { error: "Failed to load people list" },
      { status: 500 },
    );
  }
}
