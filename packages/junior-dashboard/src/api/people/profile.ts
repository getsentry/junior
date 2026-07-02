import { readPeopleProfile } from "@sentry/junior/api/people/profile";

/** Serve the dashboard person profile endpoint from the SQL-backed people API. */
export async function peopleProfileResponse(email: string): Promise<Response> {
  if (!email.trim()) {
    return Response.json({ error: "Email is required" }, { status: 400 });
  }

  try {
    return Response.json(await readPeopleProfile(email));
  } catch (error) {
    console.error("Failed to load person profile", error);
    return Response.json(
      { error: "Failed to load person profile" },
      { status: 500 },
    );
  }
}
