// The tests typecheck (tsconfig.tests.json) uses Bun's real types instead of
// the server's hand-written minimal declarations (server-env.d.ts is excluded
// there); this keeps the one declaration the sources still need.
declare module "*.md" {
  const content: string;
  export default content;
}
