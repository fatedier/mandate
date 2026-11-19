// Shared constants used by both the skill tool and the SkillRegistry's
// manifest renderer. Kept in one place so a rename here propagates to both
// sides automatically — preventing drift where one file calls the tool
// "skill" and the other calls it something else.

export const SKILL_TOOL_NAME = "skill";
export const AVAILABLE_SKILLS_TAG = "available-skills";
