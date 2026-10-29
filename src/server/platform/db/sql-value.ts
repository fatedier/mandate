/** What a SQL parameter may be. Mirrors bun:sqlite's `SQLQueryBindings` so
 *  parameter arrays built up in code type-check against Bun's real types
 *  (the tests typecheck) as well as the server's minimal declaration. */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array;
