/** A file an agent linked, as the page shows it (GET /api/files). */
export type FileKind = "markdown" | "image" | "html" | "pdf" | "text" | "other";

/** Which part of a large text file is shown: its start, its end, or the
 *  part around a line in neither. */
export type FilePart = "start" | "end" | "around";

export interface FileDto {
  /** The path as asked for, made absolute; its name and folder. */
  path: string;
  name: string;
  folder: string;
  size: number;
  modifiedAt: string;
  kind: FileKind;
  /** Markdown, HTML and text only: the whole file, or a part of it when it is
   *  over TEXT_PART_BYTES. */
  text?: string;
  part?: FilePart;
  /** The number of the part's first line. */
  firstLine?: number;
}

export type FileErrorCode = "invalid" | "outside" | "missing" | "folder" | "too_large";

export interface FileError {
  error: string;
  code: FileErrorCode;
}

/** Text over this shows a part of this size: the page draws every line. */
export const TEXT_PART_BYTES = 2 * 1024 * 1024;
/** An image over this is not served. */
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** What a shared image or text may weigh (POST /api/share-files). */
export const SHARE_FILE_MAX_BYTES = 20 * 1024 * 1024;

/** Where a shared image or text, or a copy of a file, was saved. */
export interface SharedFileSaved {
  path: string;
}
