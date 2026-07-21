import * as fs from "node:fs";

const templateCache = new Map<string, string>();
const TOKEN_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

function loadPromptTemplate(filePath: string): string {
  let template = templateCache.get(filePath);
  if (template === undefined) {
    template = fs.readFileSync(filePath, "utf8");
    templateCache.set(filePath, template);
  }
  return template;
}

export function renderPromptFile(filePath: string, vars: Record<string, unknown> = {}): string {
  return renderPromptTemplate(loadPromptTemplate(filePath), vars);
}

function renderPromptTemplate(template: string, vars: Record<string, unknown> = {}): string {
  return template.replace(TOKEN_RE, (_match, key: string) => {
    if (!Object.hasOwn(vars, key)) {
      throw new Error(`Missing prompt template variable: ${key}`);
    }
    const value = vars[key];
    return value == null ? "" : String(value);
  });
}

export function clearPromptTemplateCache() {
  templateCache.clear();
}
