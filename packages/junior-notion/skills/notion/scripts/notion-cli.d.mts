export interface FetchContentInput {
  id?: string;
  object?: "page" | "data_source";
  rowLimit?: number;
}

export interface NotionFetchTarget {
  id: string;
  object: "page" | "data_source";
  title: string;
  url: string;
  last_edited_time: string | null;
}

export interface NotionFetchPageContent {
  type: "page";
  markdown: string;
}

export interface NotionFetchDataSourceSchemaEntry {
  name: string;
  type: string;
}

export interface NotionFetchDataSourceRow {
  id: string;
  object: string;
  title: string;
  url: string;
  last_edited_time: string | null;
  properties: Record<string, unknown>;
}

export interface NotionFetchDataSourceContent {
  type: "data_source";
  schema: NotionFetchDataSourceSchemaEntry[];
  rows: NotionFetchDataSourceRow[];
}

export interface FetchContentResult {
  ok: true;
  target: NotionFetchTarget;
  content: NotionFetchPageContent | NotionFetchDataSourceContent | null;
  content_error?: string;
}

export function fetchContent(
  input?: FetchContentInput,
): Promise<FetchContentResult>;
