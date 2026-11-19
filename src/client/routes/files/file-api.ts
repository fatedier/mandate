import { apiPath } from "@/lib/api-base";
import { API_PATHS, type FileDto, type FileErrorCode } from "@shared/api-contracts";
import { errorText } from "@shared/error-text";

/** A file the server would not or could not give: its code (the server's,
 *  or "network" when no answer came) and what it said. */
export class FileFetchError extends Error {
  constructor(message: string, readonly code: FileErrorCode | "network") {
    super(message);
  }
}

export async function fetchFile(path: string, opts: { part?: "start" | "end"; line?: number } = {}): Promise<FileDto> {
  let res: Response;
  try {
    res = await fetch(apiPath(API_PATHS.file(path, opts)));
  } catch (err) {
    throw new FileFetchError(errorText(err), "network");
  }
  const body = await res.json().catch(() => null) as (Partial<FileDto> & { error?: string; code?: FileErrorCode }) | null;
  if (!res.ok || !body) throw new FileFetchError(body?.error ?? `HTTP ${res.status}`, body?.code ?? "network");
  return body as FileDto;
}

/** The file's bytes as an attachment, for a browser to save under its name. */
export function fileDownloadUrl(path: string): string {
  return apiPath(API_PATHS.fileDownload(path));
}

/** A copy of the file put in the Downloads folder by the server, for the
 *  desktop app, whose webview downloads nothing. Throws when it was not. */
export async function saveFileToDownloads(path: string): Promise<void> {
  const res = await fetch(apiPath(API_PATHS.fileSave), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
  if (!res.ok) throw new Error(`could not save the file (HTTP ${res.status})`);
}

/** An image's or a PDF's bytes, from the server. `read`: which reading of
 *  the file shows it; a new one asks for the bytes again (the file may have
 *  changed while its tab was hidden). The server ignores it. */
export function fileRawUrl(path: string, read?: number): string {
  return apiPath(API_PATHS.fileRaw(path) + (read === undefined ? "" : `&read=${read}`));
}
