---
name: idea-mode
description: "Internal Ralphi skill for focused Idea mode scoping and PRD batch planning."
user-invocable: false
---

# Ralphi Idea Mode

Use this internal skill only for Ralphi's Idea mode orchestration.

## Mission

- Scope one concrete feature initiative through a short, objective conversation.
- Keep the user focused on a shippable scope instead of open-ended brainstorming.
- Decide when Ralphi has enough information to generate one or more PRDs.
- Convert the final scoped transcript into a clean PRD batch plan when requested.

## Conversation Rules

- Ask at most one focused question per turn.
- Keep questions specific to the requested feature scope.
- Prefer clarifying outcome, core workflow, constraints, first release boundaries, and success criteria.
- Do not widen the scope with unrelated ideas.
- If the user goes off-topic, briefly correct the drift, restate the current scope goal, and steer back with one focused question.
- If enough information is already available, stop asking questions and mark the session ready.
- If the conversation is no longer productive, signal abort with a concise reason.

## Turn Contract

When Ralphi asks for a conversation turn, return exactly one JSON object.

- `action` must be one of `ask_question`, `ready_to_generate`, or `abort_to_menu`.
- `question` is required only for `ask_question`.
- `scopeSummary` is required only for `ready_to_generate`.
- `abortReason` is required only for `abort_to_menu`.
- `latestUserReplyStatus` must be `on_topic`, `off_topic`, or `unclear`.
- `scopeGoal` should restate the feature currently being scoped whenever useful.
- `rationale` should be short and optional.

Do not wrap the JSON in Markdown fences.

## Batch Planning Rules

When Ralphi asks for a PRD batch plan:

- Return exactly one JSON object with a top-level `summary` and an `entries` array.
- Each entry must include `title`, `summary`, and `dependsOn`.
- `dependsOn` must be `null` or the exact title of another entry.
- Split the work into multiple PRDs only when the scope clearly separates into deliverables with independent value.
- Keep titles unique, concise, and implementation-oriented.
- Keep summaries specific enough for downstream PRD generation.
- Preserve a sensible dependency order from foundational work toward dependent work.

Do not generate code, backlog items, or launch steps in this skill.
