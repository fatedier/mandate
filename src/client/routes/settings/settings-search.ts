import type { SettingsSectionId } from "./settings-nav";

export type SettingsSearchEntry = {
  section: SettingsSectionId;
  label: string;
  /** Where it lives, for the result row's second line. */
  group: string;
  /** Terms someone would plausibly type that the label doesn't contain. */
  keywords?: string;
  /** SettingRow anchor to scroll to. Without one the result just opens the section. */
  anchor?: string;
  /** Present only in the desktop build. */
  desktopOnly?: boolean;
};

/**
 * Hand-maintained index of every reachable setting.
 *
 * It is static rather than collected from rendered rows because only the
 * active section is mounted — a render-time registry could only ever find
 * settings you had already navigated to, which is the opposite of what search
 * is for. The cost is that a renamed field needs its entry updated; the test
 * suite pins section ids and anchor uniqueness, and a stale entry degrades to
 * a missed hit rather than a broken screen.
 */
export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchEntry[] = [
  // General
  { section: "general", group: "Appearance", label: "Theme", anchor: "theme", keywords: "dark light color scheme appearance" },
  { section: "general", group: "Appearance", label: "Interface zoom", anchor: "interface-zoom", keywords: "scale size bigger smaller text display percent", desktopOnly: true },
  { section: "general", group: "Agents", label: "Delegation preferences", anchor: "agent-preferences", keywords: "planning implementation review who handles" },
  { section: "general", group: "Agents", label: "Context compression threshold", anchor: "context-compression", keywords: "tokens budget summarize history manager workers" },
  { section: "general", group: "Agents", label: "Agent logging", anchor: "agent-logging", keywords: "debug prompts requests metadata full" },
  { section: "general", group: "Web Access", label: "Listen address", anchor: "web-host", keywords: "host bind ip network 127.0.0.1 lan", desktopOnly: true },
  { section: "general", group: "Web Access", label: "Port", anchor: "web-port", keywords: "server address", desktopOnly: true },
  { section: "general", group: "Storage", label: "Database", anchor: "storage-cleanup", keywords: "cleanup vacuum disk size shrink chat history retention" },

  // Providers
  { section: "providers", group: "Providers", label: "Add provider", keywords: "new openai anthropic codex kilo compatible" },
  { section: "providers", group: "Providers", label: "API key", keywords: "secret token credentials" },
  { section: "providers", group: "Providers", label: "Base URL", keywords: "endpoint host proxy" },
  { section: "providers", group: "Providers", label: "Enabled models", keywords: "model id catalog reasoning image input" },
  { section: "providers", group: "Providers", label: "Service tier", keywords: "codex priority flex" },
  { section: "providers", group: "Providers", label: "Codex sign-in", keywords: "oauth login logout account" },

  // Routing
  { section: "routing", group: "Default route", label: "Model", anchor: "route-model", keywords: "default llm which model" },
  { section: "routing", group: "Default route", label: "Reasoning effort", anchor: "route-effort", keywords: "thinking low medium high xhigh" },
  { section: "routing", group: "Default route", label: "Fallbacks", anchor: "route-fallbacks", keywords: "backup retry secondary" },
  { section: "routing", group: "Manager", label: "Manager route", keywords: "override per-agent overview" },
  { section: "routing", group: "Workers", label: "Worker route", keywords: "override per-agent feature" },

  // Memory
  { section: "memory", group: "Embeddings", label: "Embedding model", anchor: "embedding-model", keywords: "recall vector search" },
  { section: "memory", group: "Dream maintenance", label: "Dream maintenance", anchor: "dream-enabled", keywords: "consolidation idle nightly prune" },
  // The run history itself lives on the Memory page now; this row is the way
  // back to it, so the terms someone would search for still land somewhere useful.
  { section: "memory", group: "Dream maintenance", label: "Maintenance schedule", anchor: "dream-run", keywords: "run now trigger manual history log runs applied rejected" },

  // Voice
  { section: "voice", group: "Realtime voice", label: "Voice provider", anchor: "voice-provider", keywords: "openai codex realtime" },
  { section: "voice", group: "Realtime voice", label: "Realtime model", anchor: "voice-model", keywords: "gpt-realtime" },
  { section: "voice", group: "Realtime voice", label: "Voice", anchor: "voice-voice", keywords: "marin timbre speaker" },
  { section: "voice", group: "Realtime voice", label: "Language", anchor: "voice-language", keywords: "locale spoken chinese english" },
  { section: "voice", group: "Realtime voice", label: "Realtime base URL", anchor: "voice-base-url", keywords: "endpoint azure" },
  { section: "voice", group: "Realtime voice", label: "Deployment", anchor: "voice-deployment", keywords: "azure" },
  { section: "voice", group: "Realtime voice", label: "Voice API key", anchor: "voice-api-key", keywords: "secret token" },
  { section: "voice", group: "Session", label: "Idle timeout", anchor: "voice-idle", keywords: "hang up disconnect minutes" },
  { section: "voice", group: "Session", label: "Max session length", anchor: "voice-max", keywords: "limit minutes" },
  { section: "voice", group: "Session", label: "Context messages", anchor: "voice-context", keywords: "history carried" },
  { section: "voice", group: "Input", label: "Default input mode", anchor: "voice-input-mode", keywords: "push to talk ptt voice activity vad" },

  // Skills
  { section: "skills", group: "Skills", label: "Installed skills", keywords: "registry rescan builtin user override" }
];

export type SettingsSearchResult = SettingsSearchEntry & { score: number };

/**
 * Rank entries against a query. Word-prefix beats substring, and a hit in the
 * label beats one in the keywords, so typing "port" puts the Port field above
 * everything that merely mentions ports in passing.
 */
export function searchSettings(
  query: string,
  opts: { desktop: boolean; index?: readonly SettingsSearchEntry[] } = { desktop: false }
): SettingsSearchResult[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const index = opts.index ?? SETTINGS_SEARCH_INDEX;

  const results: SettingsSearchResult[] = [];
  for (const entry of index) {
    if (entry.desktopOnly && !opts.desktop) continue;
    const label = entry.label.toLowerCase();
    const haystack = `${label} ${entry.group.toLowerCase()} ${entry.keywords ?? ""}`;

    let score = 0;
    let matchedAll = true;
    for (const term of terms) {
      if (label.startsWith(term)) score += 6;
      else if (new RegExp(`\\b${escapeRegExp(term)}`).test(label)) score += 4;
      else if (label.includes(term)) score += 3;
      else if (haystack.includes(term)) score += 1;
      else {
        matchedAll = false;
        break;
      }
    }
    if (matchedAll) results.push({ ...entry, score });
  }

  // Stable within a score: the index order is authored deliberately, so equal
  // matches keep the reading order of the settings themselves.
  return results
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => b.entry.score - a.entry.score || a.i - b.i)
    .map(({ entry }) => entry);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
