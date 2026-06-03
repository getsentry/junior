import app from "../../../server.ts";

export const POST = (request: Request) => app.fetch(request);
