import {
  dockerRequest,
  type DockerRequest,
} from "@/core/tool-execution-environment/docker/api";

/** Send one request and parse its JSON body. */
export async function dockerJson<T>(input: DockerRequest): Promise<T> {
  const body = await dockerRequest(input);
  return (body.length > 0 ? JSON.parse(body.toString("utf8")) : {}) as T;
}
