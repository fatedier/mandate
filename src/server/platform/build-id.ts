/** Stamped into a compiled binary by scripts/build-binary.ts. */
declare const MANDATE_BUILD_ID: string | undefined;

/** A run from source has no stamp: each process counts as a build of its own. */
const SOURCE_RUN = `source-${crypto.randomUUID()}`;

/**
 * Which build of the server this is: a compiled binary's stamp (a hash of
 * the sources it was built from), else one of its own for this process.
 * What is worked out by code and kept in the database (the Activity slices)
 * is checked again under a new build.
 */
export function buildId(): string {
  return typeof MANDATE_BUILD_ID === "string" ? MANDATE_BUILD_ID : SOURCE_RUN;
}
