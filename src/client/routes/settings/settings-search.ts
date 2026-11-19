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
  { section: "general", group: "Personal agent", label: "Personal agent's name", anchor: "personal-agent-name", keywords: "name rename assistant voice via sidebar global your" },
  { section: "general", group: "Appearance", label: "Theme", anchor: "theme", keywords: "dark light color scheme appearance" },
  { section: "general", group: "Appearance", label: "Interface zoom", anchor: "interface-zoom", keywords: "scale size bigger smaller text display percent", desktopOnly: true },
  { section: "general", group: "Agents", label: "Delegation preferences", anchor: "agent-preferences", keywords: "planning implementation review who handles" },
  { section: "general", group: "Agents", label: "Context compression threshold", anchor: "context-compression", keywords: "tokens budget summarize history manager workers" },
  { section: "general", group: "Agents", label: "Compact idle threads", anchor: "idle-compaction", keywords: "idle compaction prompt cache expires quiet minutes before smallest context tokens summarize" },
  { section: "general", group: "Agents", label: "Review tool calls", anchor: "tool-call-review", keywords: "tool-call review approval approve hold back risky command terminal write second look model safety your rules allow ask first permission own words" },
  { section: "general", group: "Agents", label: "Agent logging", anchor: "agent-logging", keywords: "debug prompts requests metadata full" },
  { section: "general", group: "Web Access", label: "Listen address", anchor: "web-host", keywords: "host bind ip network 127.0.0.1 lan", desktopOnly: true },
  { section: "general", group: "Web Access", label: "Port", anchor: "web-port", keywords: "server address", desktopOnly: true },
  { section: "general", group: "Storage", label: "Database", anchor: "storage-cleanup", keywords: "cleanup vacuum disk size shrink chat history retention" },
  { section: "general", group: "Storage", label: "Chat history limit", anchor: "chat-history-limit", keywords: "retention size ceiling cap gb shorten truncate tool outputs old conversations" },

  // Notifications
  { section: "notifications", group: "Notifications", label: "Channels", anchor: "notifications-channels", keywords: "push phone alert notify telegram desktop browser" },
  { section: "notifications", group: "Notifications", label: "Telegram", keywords: "bot phone push notify" },
  { section: "notifications", group: "Notifications", label: "Open links at", anchor: "notifications-link-base", keywords: "address url link phone tunnel" },
  // Providers
  // Each of these exists once per provider, so a hit lands on the provider
  // list (flashed) rather than guessing which provider's field was meant.
  { section: "providers", group: "Providers", label: "Add provider", anchor: "providers", keywords: "new openai anthropic codex kilo compatible" },
  { section: "providers", group: "Providers", label: "API key", anchor: "providers", keywords: "secret token credentials" },
  { section: "providers", group: "Providers", label: "Base URL", anchor: "providers", keywords: "endpoint host proxy" },
  { section: "providers", group: "Providers", label: "Enabled models", anchor: "providers", keywords: "model id catalog reasoning image input" },
  { section: "providers", group: "Providers", label: "Service tier", anchor: "providers", keywords: "codex priority flex" },
  { section: "providers", group: "Providers", label: "Billing", anchor: "providers", keywords: "pay per use subscription plan free cost spend charges" },
  { section: "providers", group: "Providers", label: "Price", anchor: "providers", keywords: "model price cost per million tokens price as your price automatic" },
  { section: "providers", group: "Providers", label: "Cache lifetime", anchor: "providers", keywords: "model prompt cache minutes ttl expires idle compaction" },
  { section: "providers", group: "Prices", label: "Update prices automatically", anchor: "prices", keywords: "price data refresh download litellm models.dev openrouter cost" },
  { section: "providers", group: "Providers", label: "Codex sign-in", anchor: "providers", keywords: "oauth login logout account" },

  // Routing
  { section: "routing", group: "Default route", label: "Model", anchor: "route-default", keywords: "default llm which model" },
  { section: "routing", group: "Default route", label: "Reasoning effort", anchor: "route-default", keywords: "thinking low medium high xhigh" },
  { section: "routing", group: "Default route", label: "Fallbacks", anchor: "route-default", keywords: "backup retry secondary model" },
  { section: "routing", group: "Personal agent", label: "Personal agent route", anchor: "route-personal", keywords: "override own per-agent global model reasoning effort fallback" },
  { section: "routing", group: "Managers", label: "Manager route", anchor: "route-manager", keywords: "override own per-agent thread model reasoning effort fallback" },
  { section: "routing", group: "Workers", label: "Worker route", anchor: "route-worker", keywords: "override own per-agent model reasoning effort fallback" },
  { section: "routing", group: "Subagents", label: "Subagent route", anchor: "route-subagent", keywords: "override own subagent background task job model reasoning effort fallback" },
  { section: "routing", group: "Page updates", label: "Page updates route", anchor: "route-page", keywords: "override own page subagent your personal agent page update model reasoning effort fallback" },
  { section: "routing", group: "Dream", label: "Dream route", anchor: "route-dream", keywords: "override own memory maintenance merge prune brief model reasoning effort fallback" },
  { section: "routing", group: "Skill review", label: "Skill review route", anchor: "route-skillReview", keywords: "override own learned skills review write skill finished work model reasoning effort fallback" },
  { section: "routing", group: "Memory extraction", label: "Memory extraction route", anchor: "route-extraction", keywords: "override own memory extract remember preference knowledge model reasoning effort fallback" },
  { section: "routing", group: "Decisions", label: "Decisions route", anchor: "route-decisions", keywords: "judgement judge decide decision model quick on off fallback" },
  { section: "routing", group: "Manager request check", label: "Manager request check route", anchor: "route-managerRequestCheck", keywords: "override own request done finished handoff thread notice judge decision model fallback" },
  { section: "routing", group: "Manager stop check", label: "Manager stop check route", anchor: "route-managerStopCheck", keywords: "override own thread stopped reply decision result blue judge decision model fallback on off" },
  { section: "routing", group: "Memory repeat check", label: "Memory repeat check route", anchor: "route-memoryRepeatCheck", keywords: "override own memory repeat duplicate stored extraction judge decision model fallback on off" },
  { section: "routing", group: "Tool-call review: screen", label: "Tool-call review: screen route", anchor: "route-toolReviewScreen", keywords: "override own tool-call review screen approval command flag second look decision model fallback" },
  { section: "routing", group: "Tool-call review: second look", label: "Tool-call review: second look route", anchor: "route-toolReviewSecondLook", keywords: "override own tool-call review second look approval hold back reason chat model fallback" },

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

  // Skills
  { section: "skills", group: "Skills", label: "Installed skills", keywords: "registry rescan builtin user override" },

  // Web search
  { section: "web-search", group: "Web search", label: "Search with", anchor: "web-search-use", keywords: "internet web tavily exa searxng backend" },
  { section: "web-search", group: "Web search", label: "Check search", anchor: "web-search-check", keywords: "test" }
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
