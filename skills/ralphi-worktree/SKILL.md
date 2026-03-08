---
name: ralphi-worktree
description: "Guide for working inside a Ralphi-managed git worktree, keeping code changes isolated per PRD while updating shared orchestration state safely."
user-invocable: true
---

# Ralphi Worktree

Use this skill when Ralphi has provisioned a dedicated worktree and branch for the current PRD.

## Ground Rules

1. Treat the current worktree as the only place for product code changes.
2. Treat `runDir`, `prd.json`, `progress.txt`, and `backlog.json` as shared orchestration state that may live outside the worktree.
3. Never edit files in sibling worktrees or in the main checkout unless the prompt explicitly names a shared state file.

## Git Hygiene

- Inspect the current branch before making assumptions.
- Do not revert unrelated user changes.
- Prefer small commits worth one PRD backlog item at a time.
- If the repository state appears inconsistent with the assigned branch or worktree, report it clearly instead of guessing.

## Verification

- Run checks from inside the assigned worktree.
- If a dependency or generated artifact is missing, explain the blocker in `progress.txt`.
- Keep the branch isolated to the PRD you are executing.

## Shared-State Reminder

Ralphi reads status from the shared state files, not from memory. Whenever you finish a meaningful step:

1. Update `backlog.json`.
2. Update `prd.json`.
3. Append a timestamped note to `progress.txt`.
