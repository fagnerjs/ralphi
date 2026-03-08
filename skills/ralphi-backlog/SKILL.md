---
name: ralphi-backlog
description: "Create or refresh backlog.json for a Ralphi PRD run, keep item and step status in sync with prd.json acceptance criteria, and emit Ralphi backlog progress markers during implementation."
user-invocable: true
---

# Ralphi Backlog

Use this skill when `backlog.json` is missing, stale, or needs to be updated while working a PRD.

## Backlog Contract

`backlog.json` must stay machine-readable and compact:

```json
{
  "version": 1,
  "sourcePrd": "...",
  "branchName": "...",
  "activeItemId": "BT-001",
  "activeStepId": "ST-001-01",
  "items": [
    {
      "id": "BT-001",
      "storyId": "US-001",
      "title": "Story title",
      "description": "Short summary",
      "status": "pending",
      "notes": "",
      "updatedAt": "2026-03-07T00:00:00.000Z",
      "steps": [
        {
          "id": "ST-001-01",
          "title": "Acceptance criterion text",
          "status": "pending"
        }
      ]
    }
  ]
}
```

## Workflow

1. Read `prd.json` first when it exists.
2. Create one backlog item per user story.
3. Create one step per acceptance criterion.
4. Preserve completed status and notes when refreshing existing backlog data.
5. Keep `activeItemId` and `activeStepId` pointed at the current work item.

## Status Rules

- Use `pending`, `in_progress`, `done`, `blocked`, or `disabled`.
- Mark the backlog item `done` only when the related story is complete in `prd.json`.
- Mark individual steps `done` as they are verified.
- If a step cannot be finished in the current run, leave it `pending` or `blocked` and explain why in `notes`.
- If a user disables an item, preserve `disabled` and skip it when choosing the next task.

## Progress Markers

Whenever you switch to a backlog item or complete a step, print a single marker line:

```text
<ralphi-backlog item="BT-001" step="ST-001-01" status="in_progress">
<ralphi-backlog item="BT-001" step="ST-001-03" status="done">
```

These markers drive the live dashboard. Keep them exact and on their own line.
