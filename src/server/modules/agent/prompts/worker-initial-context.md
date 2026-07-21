## Feature initial context

This baseline describes durable scope and capability context for this feature
thread. It is injected when the active prompt context starts and again after
compression removes the previous baseline.

## Project identity

- name: {{projectName}}
- workingDir: {{projectWorkingDir}}
- tmuxSessionName: {{projectTmuxSessionName}}
- git: {{projectGitDescription}}

## Feature identity

- name: {{featureName}}
- id: {{featureId}}
- tmuxWindowName: {{featureTmuxWindowName}}
- mode: {{featureMode}}
- branch: {{featureBranch}}
- baseRef: {{featureBaseRef}}
- worktreePath: {{featureWorktreePath}}

{{agentPreferencesSection}}

{{availableSkillsSection}}
