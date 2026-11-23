import { bindPluginTools } from "@sentry/junior-testing/plugin-tool";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vimeoPlugin } from "../src";

const OWNER = "111";
const FOLDER = `/users/${OWNER}/projects/222`;
const TUS = "https://us-files.tus.vimeo.com/files/abc";
const PICTURE_UPLOAD = "https://i.cloud.vimeo.com/video/333";
const SIZE = 20 * 1024 * 1024 + 123;
const options = { toolCallId: "call" };

function mediaFile(header: number[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 251;
  bytes.set(header);
  return bytes;
}

const video = mediaFile(
  [0, 0, 0, 0x20, ...new TextEncoder().encode("ftypisom")],
  SIZE,
);
const files: Record<string, Uint8Array> = {
  "/vercel/sandbox/out/clip.mp4": video,
  "/vercel/sandbox/out/poster.jpg": mediaFile([0xff, 0xd8, 0xff, 0xe0], 2048),
  "/vercel/sandbox/secret.txt": new TextEncoder().encode("AWS_SECRET=abc"),
};

const storedVideo = {
  uri: "/videos/987654",
  name: "Release notes",
  link: "https://vimeo.com/987654/a1b2c3d4e5",
  player_embed_url: "https://player.vimeo.com/video/987654?h=a1b2c3d4e5",
  privacy: { view: "unlisted", embed: "whitelist" },
  status: "transcoding",
  upload: { status: "complete" },
  transcode: { status: "in_progress" },
};

type ApiCall = { operation: string; method: string; url: URL; body: unknown };

const plugin = vimeoPlugin();
const listedOperations =
  plugin.manifest?.accounts?.serviceAccount?.operations ?? [];

/**
 * Fake Vimeo: the API through plugin egress, which stands in for the host
 * adding the service account's token, and tus and picture uploads through
 * global fetch.
 */
function fakeVimeo() {
  const state = {
    apiCalls: [] as ApiCall[],
    uploads: [] as Array<{ method: string; url: string; headers: Headers }>,
    received: new Uint8Array(SIZE),
    serverOffset: 0,
    dropSecondChunk: false,
    connected: true,
    failLookup: false,
  };

  async function egressFetch(input: {
    operation: string;
    provider: string;
    request: Request;
  }): Promise<Response> {
    expect(input.provider).toBe("vimeo");
    expect(listedOperations).toContain(input.operation);
    // Junior adds the token on the host. Plugin code never sets one.
    expect(input.request.headers.get("authorization")).toBeNull();
    if (!state.connected) {
      throw new Error("The vimeo service account is not connected.");
    }
    const url = new URL(input.request.url);
    const text = await input.request.text();
    const body = text ? JSON.parse(text) : undefined;
    const method = input.request.method;
    state.apiCalls.push({ operation: input.operation, method, url, body });
    return vimeoResponse(method, url, body);
  }

  function vimeoResponse(method: string, url: URL, body: unknown): Response {
    const route = `${method} ${url.pathname}`;
    if (route === `POST /users/${OWNER}/videos`) {
      return Response.json(
        { uri: "/videos/987654", upload: { upload_link: TUS } },
        { status: 201 },
      );
    }
    if (route === "POST /videos/987654/versions") {
      return Response.json({ upload: { upload_link: TUS } }, { status: 201 });
    }
    if (route === "POST /videos/987654/pictures") {
      return Response.json(
        { uri: "/videos/987654/pictures/333", link: PICTURE_UPLOAD },
        { status: 201 },
      );
    }
    if (route === "PATCH /videos/987654/pictures/333") {
      expect(body).toEqual({ active: true });
      return Response.json({
        uri: "/videos/987654/pictures/333",
        base_link: "https://i.vimeocdn.com/video/333",
      });
    }
    if (route === "GET /videos/987654") {
      return state.failLookup
        ? new Response("busy", { status: 503 })
        : Response.json(storedVideo);
    }
    if (route === "GET /videos/555") {
      return Response.json({
        uri: "/videos/555",
        privacy: { view: "disable", embed: "whitelist" },
        status: "available",
        transcode: { status: "complete" },
        duration: 72,
      });
    }
    if (route === `GET ${FOLDER}/videos`) {
      return Response.json({
        data: [storedVideo],
        paging: { next: `${FOLDER}/videos?page=2` },
      });
    }
    return Response.json(
      { error: "The requested video couldn't be found." },
      { status: 404 },
    );
  }

  function tusResponse(init: RequestInit): Response {
    const headers = new Headers(init.headers);
    expect(headers.get("Tus-Resumable")).toBe("1.0.0");
    if (init.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "Upload-Offset": String(state.serverOffset) },
      });
    }
    const offset = Number(headers.get("Upload-Offset"));
    const body = init.body as Uint8Array;
    expect(body.byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(offset).toBe(state.serverOffset);
    if (state.dropSecondChunk && offset > 0) {
      // Vimeo keeps half the chunk, then the connection drops.
      const half = Math.floor(body.byteLength / 2);
      state.received.set(body.subarray(0, half), offset);
      state.serverOffset += half;
      state.dropSecondChunk = false;
      throw new TypeError("fetch failed");
    }
    state.received.set(body, offset);
    state.serverOffset += body.byteLength;
    return new Response(null, {
      status: 204,
      headers: { "Upload-Offset": String(state.serverOffset) },
    });
  }

  const uploadFetch = vi.fn(
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      state.uploads.push({
        method: init.method ?? "GET",
        url,
        headers: new Headers(init.headers),
      });
      if (url === TUS) return tusResponse(init);
      if (url === PICTURE_UPLOAD && init.method === "PUT") {
        return new Response("", { status: 200 });
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    },
  );
  vi.stubGlobal("fetch", uploadFetch);

  const tools = bindPluginTools(plugin.hooks!.tools!(), {
    egress: { fetch: egressFetch },
    sandbox: {
      root: "/vercel/sandbox",
      readFile: async (path: string) => files[path] ?? null,
    },
  } as never);
  const run = (name: string, input: unknown) => {
    const tool = tools[name]!;
    return tool.execute(
      tool.prepareArguments!(input) as never,
      options as never,
    ) as Promise<Record<string, unknown>>;
  };
  return { state, tools, run };
}

describe("Vimeo tools", () => {
  beforeEach(() => {
    vi.stubEnv("VIMEO_FOLDER_URI", FOLDER);
    vi.stubEnv("VIMEO_EMBED_DOMAINS", "www.example.com, docs.example.com");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uploads a private video into the folder, then resumes a dropped chunk", async () => {
    const { state, run } = fakeVimeo();
    state.dropSecondChunk = true;
    const out = await run("upload", {
      path: "out/clip.mp4",
      title: "Release notes",
      view: "unlisted",
      embed_domains: ["www.example.com", "example.com"],
    });
    const create = state.apiCalls[0]!;
    expect(create.operation).toBe("vimeo.upload");
    expect(create.url.toString()).toBe(
      `https://api.vimeo.com/users/${OWNER}/videos?fields=uri,upload`,
    );
    expect(create.body).toEqual({
      name: "Release notes",
      folder_uri: FOLDER,
      upload: { approach: "tus", size: String(SIZE) },
      privacy: {
        view: "unlisted",
        embed: "whitelist",
        download: false,
        add: false,
        comments: "nobody",
      },
      embed_domains: ["www.example.com", "example.com"],
    });
    expect(state.uploads.some((call) => call.method === "HEAD")).toBe(true);
    expect(Buffer.compare(state.received, video)).toBe(0);
    expect(out).toMatchObject({
      video_id: "987654",
      hash: "a1b2c3d4e5",
      embed_url: "https://player.vimeo.com/video/987654?h=a1b2c3d4e5",
      folder_uri: FOLDER,
      ready: false,
    });
  });

  it("succeeds with a status error when only the lookup after the bytes fails", async () => {
    const { state, run } = fakeVimeo();
    state.failLookup = true;
    const out = await run("upload", { path: "out/clip.mp4", title: "t" });
    expect(out).toMatchObject({ video_id: "987654", ready: false });
    expect(String(out["status_error"])).toMatch(/do not upload again/);
    expect(Buffer.compare(state.received, video)).toBe(0);
  });

  it("defaults to an embed-only video on the install's embed domains", async () => {
    const { state, run } = fakeVimeo();
    await run("upload", { path: "/vercel/sandbox/out/clip.mp4", title: "t" });
    expect(state.apiCalls[0]!.body).toMatchObject({
      privacy: { view: "disable" },
      embed_domains: ["www.example.com", "docs.example.com"],
    });
  });

  it("rejects public videos, bad domains, bad folders, and non-video files", async () => {
    const { state, tools, run } = fakeVimeo();
    const upload = tools["upload"]!;
    for (const input of [
      { path: "x", title: "t", view: "anybody" },
      { path: "x", title: "t", embed_domains: ["https://evil.com/x"] },
      { path: "x", title: "t", folder_uri: "/me/videos" },
    ]) {
      expect(() => upload.prepareArguments!(input)).toThrow(/./);
    }
    await expect(
      run("upload", { path: "secret.txt", title: "t" }),
    ).rejects.toThrow(/not an MP4/);
    await expect(
      run("upload", { path: "nope.mp4", title: "t" }),
    ).rejects.toThrow(/does not exist/);
    vi.stubEnv("VIMEO_EMBED_DOMAINS", "");
    await expect(
      run("upload", { path: "out/clip.mp4", title: "t" }),
    ).rejects.toThrow(/No default embed domains/);
    vi.stubEnv("VIMEO_FOLDER_URI", "");
    await expect(
      run("upload", {
        path: "out/clip.mp4",
        title: "t",
        embed_domains: ["www.example.com"],
      }),
    ).rejects.toThrow(/No default Vimeo folder/);
    expect(state.apiCalls).toHaveLength(0);
  });

  it("replaces a file with a new version and keeps the video", async () => {
    const { state, run } = fakeVimeo();
    const out = await run("replaceFile", {
      video_id: "987654",
      path: "out/clip.mp4",
    });
    const version = state.apiCalls[0]!;
    expect(version.operation).toBe("vimeo.replace_file");
    expect(version.url.toString()).toBe(
      "https://api.vimeo.com/videos/987654/versions?fields=upload",
    );
    expect(version.body).toEqual({
      file_name: "clip.mp4",
      upload: { status: "in_progress", approach: "tus", size: String(SIZE) },
    });
    expect(Buffer.compare(state.received, video)).toBe(0);
    expect(out).toMatchObject({ video_id: "987654", hash: "a1b2c3d4e5" });
  });

  it("uploads a thumbnail and makes it active", async () => {
    const { state, run } = fakeVimeo();
    const out = await run("setThumbnail", {
      video_id: "987654",
      path: "out/poster.jpg",
    });
    const put = state.uploads.find((call) => call.url === PICTURE_UPLOAD)!;
    expect(put.headers.get("Content-Type")).toBe("image/jpeg");
    expect(state.apiCalls.map((call) => call.method)).toEqual([
      "POST",
      "PATCH",
    ]);
    expect(out).toMatchObject({
      picture_uri: "/videos/987654/pictures/333",
      thumbnail_url: "https://i.vimeocdn.com/video/333",
    });
    await expect(
      run("setThumbnail", { video_id: "987654", path: "secret.txt" }),
    ).rejects.toThrow(/not a JPEG or PNG/);
  });

  it("lists the default folder newest first and reports the next page", async () => {
    const { state, run } = fakeVimeo();
    const out = await run("listFolder", {});
    const list = state.apiCalls[0]!;
    expect(list.operation).toBe("vimeo.list_folder");
    expect(list.url.pathname).toBe(`${FOLDER}/videos`);
    expect(list.url.searchParams.get("per_page")).toBe("100");
    expect(list.url.searchParams.get("sort")).toBe("date");
    expect(list.url.searchParams.get("direction")).toBe("desc");
    expect(out).toMatchObject({
      videos: [{ name: "Release notes", video_id: "987654" }],
      next_page: 2,
    });
  });

  it("reports readiness and needs the service account", async () => {
    const { state, tools, run } = fakeVimeo();
    const out = await run("status", { video_id: "555" });
    expect(out).toMatchObject({
      ready: true,
      embed_url: "https://player.vimeo.com/video/555",
    });
    expect(out["hash"]).toBeUndefined();
    expect(state.apiCalls[0]!.operation).toBe("vimeo.status");
    await expect(run("status", { video_id: "404" })).rejects.toThrow(
      /HTTP 404/,
    );
    expect(() =>
      tools["status"]!.prepareArguments!({ video_id: "../me" }),
    ).toThrow(/numeric Vimeo video ID/);
    state.connected = false;
    await expect(run("status", { video_id: "555" })).rejects.toThrow(
      /service account is not connected/,
    );
  });

  it("uses only the service account, with one operation per tool", () => {
    const manifest = plugin.manifest!;
    expect(manifest.accounts?.userOAuth).toBe(false);
    expect(manifest.credentials?.authTokenEnv).toBeUndefined();
    expect(manifest.oauth).toMatchObject({
      authorizeEndpoint: "https://api.vimeo.com/oauth/authorize",
      tokenEndpoint: "https://api.vimeo.com/oauth/access_token",
      scope: "public private upload edit",
      tokenAuthMethod: "basic",
    });
    expect(listedOperations).toHaveLength(
      Object.keys(plugin.hooks!.tools!()).length,
    );
  });
});
