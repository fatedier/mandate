## Worker initial context

This baseline describes durable scope and capability context for this worker
thread. It is injected when the active prompt context starts and again after
compression removes the previous baseline.

## Project identity

- name: {{projectName}}
- workingDir: {{projectWorkingDir}}
- tmuxSessionName: {{projectTmuxSessionName}}
- git: {{projectGitDescription}}

## Worker identity

- name: {{workerName}}
- id: {{workerId}}
- tmuxWindowName: {{workerTmuxWindowName}}
- mode: {{workerMode}}
- branch: {{workerBranch}}
- baseRef: {{workerBaseRef}}
- worktreePath: {{workerWorktreePath}}

{{agentPreferencesSection}}

{{availableSkillsSection}}

## Your plan

{{planSection}}

{{memorySection}}
