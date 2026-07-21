export const SETTINGS_SECTION_IDS = [
  "general",
  "providers",
  "routing",
  "memory",
  "voice",
  "skills"
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

type SettingsNavGroup = {
  label: string;
  items: ReadonlyArray<{ id: SettingsSectionId; label: string }>;
};

export const SETTINGS_NAV_GROUPS: readonly SettingsNavGroup[] = [
  { label: "Workspace", items: [{ id: "general", label: "General" }] },
  {
    label: "Models",
    items: [
      { id: "providers", label: "Providers" },
      { id: "routing", label: "Routing" }
    ]
  },
  {
    label: "Assistants",
    items: [
      { id: "memory", label: "Memory" },
      { id: "voice", label: "Voice" },
      { id: "skills", label: "Skills" }
    ]
  }
];

export function sectionFromParam(value: string | null): SettingsSectionId {
  return (SETTINGS_SECTION_IDS as readonly string[]).includes(value ?? "")
    ? (value as SettingsSectionId)
    : "general";
}

export function paramForSection(id: SettingsSectionId): string | null {
  return id === "general" ? null : id;
}
