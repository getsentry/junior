// The URL of the editor's chunk. The client build replaces this module with
// the URL that it gave the chunk (see tsdown.client.config.ts). Without that
// build there is no chunk, so the URL is unknown.
const editorChunkUrl: string | undefined = undefined;

export default editorChunkUrl;
