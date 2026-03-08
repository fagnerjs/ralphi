---
name: prd
description: "Draft a Product Requirements Document (PRD) for a new capability. Use when planning a feature, kicking off a project, or when asked for a PRD, feature spec, or requirements document. Triggers on: create a prd, write a prd for, plan this feature, requirements for, spec this out."
user-invocable: true
---

# PRD Writer

Produce Product Requirements Documents that are specific, implementation-ready, and easy for humans or agents to follow.

---

## Mission

Your responsibilities are:

1. Take the user's feature idea or project brief
2. Ask 3-5 important clarifying questions with lettered answer choices
3. Turn the clarified input into a structured PRD
4. Save the result to `tasks/prd-[feature-name].md`

**Do not implement the feature.** The only deliverable is the PRD.

---

## Clarify Before Writing

Ask follow-up questions only when the initial request leaves meaningful gaps. Prioritize questions that clarify:

- **Outcome:** what improvement or result the feature should create
- **Core workflow:** what the user must actually be able to do
- **Scope limits:** what is intentionally excluded from this effort
- **Success definition:** what must be true for the work to count as done

### Question Format

Use a format like this:

```
1. Which outcome matters most for this feature?
   A. Faster onboarding
   B. Better retention
   C. Lower support volume
   D. Other: [please specify]

2. Who should this serve first?
   A. New users only
   B. Existing users only
   C. All users
   D. Internal admins only

3. How broad should the first release be?
   A. Smallest useful version
   B. Full first release
   C. Backend/API only
   D. UI only
```

This allows the user to respond quickly with something like `1B, 2C, 3A`. Keep the answer choices indented beneath each question.

---

## PRD Layout

Create the PRD with these sections.

### 1. Overview
Summarize the feature, the problem it addresses, and why the work matters.

### 2. Goals
List concrete outcomes the feature is expected to achieve.

### 3. User Stories
Each story should include:
- **Title:** brief descriptive label
- **Description:** `As a [user], I want [capability] so that [benefit]`
- **Acceptance Criteria:** a checklist of observable, verifiable outcomes

Keep each story small enough to fit into one focused implementation session.

**Story format:**
```markdown
### US-001: [Title]
**Description:** As a [user], I want [capability] so that [benefit].

**Acceptance Criteria:**
- [ ] Specific observable requirement
- [ ] Another observable requirement
- [ ] Typecheck/lint passes
- [ ] **[UI stories only]** Verify in browser using dev-browser skill
```

**Acceptance criteria rules:**
- Every criterion must be testable.
- Avoid vague wording like "works correctly" or "behaves well."
- Prefer explicit behavior such as "Shows a confirmation dialog before deletion."
- For any story that changes UI behavior, always include `Verify in browser using dev-browser skill`.

### 4. Functional Requirements
Write a numbered list of explicit system requirements, for example:
- `FR-1: The system must ...`
- `FR-2: When the user ..., the system must ...`

Make them precise, concrete, and easy to reference later.

### 5. Non-Goals (Out of Scope)
Document what this work does not include. This section is important for keeping scope under control.

### 6. Design Notes (Optional)
- UX expectations
- Links to mockups or references
- Existing patterns or components worth reusing

### 7. Technical Notes (Optional)
- Constraints
- Dependencies
- Integration points
- Performance expectations

### 8. Success Metrics
Explain how success will be measured once the feature ships.

### 9. Open Questions
Capture unresolved decisions, assumptions, or risks that still need answers.

---

## Writing Style

Assume the PRD may be read by a junior developer or another agent. Write accordingly:

- Be direct and unambiguous
- Avoid jargon when possible, or explain it when necessary
- Include enough detail to explain intent and core behavior
- Number requirements so they are easy to reference
- Use concrete examples when they remove ambiguity

---

## Output Rules

- **Format:** Markdown (`.md`)
- **Location:** `tasks/`
- **Filename:** `prd-[feature-name].md` in kebab-case

---

## Example PRD

```markdown
# PRD: Saved Filter Presets

## Overview

Allow users to save frequently used filter combinations so they can return to the same view without rebuilding it each time. This reduces repetitive work and makes large data sets easier to navigate.

## Goals

- Let users save a named filter preset from the current view
- Let users apply a preset in a single action
- Let users rename and delete saved presets
- Keep the first release simple and predictable

## User Stories

### US-001: Persist filter presets
**Description:** As a developer, I want saved presets stored persistently so users keep them between sessions.

**Acceptance Criteria:**
- [ ] Store preset name and filter values in persistent storage
- [ ] Associate presets with the correct user
- [ ] Provide a safe empty default when a user has no presets yet
- [ ] Typecheck passes

### US-002: Save the current filter state
**Description:** As a user, I want to save my current filters so I can reuse them later.

**Acceptance Criteria:**
- [ ] A "Save preset" action is available from the filtered view
- [ ] The user can enter a preset name before saving
- [ ] Saving confirms success without resetting the current view
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-003: Apply a saved preset
**Description:** As a user, I want to reapply a saved preset instantly so I can reach the view I need faster.

**Acceptance Criteria:**
- [ ] A preset picker lists saved presets by name
- [ ] Selecting a preset applies all stored filters
- [ ] An empty state appears when no presets exist
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-004: Manage saved presets
**Description:** As a user, I want to rename or delete presets so my saved views stay organized.

**Acceptance Criteria:**
- [ ] The user can rename an existing preset
- [ ] The user can delete a preset after confirmation
- [ ] Deleted presets disappear from the picker immediately
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

## Functional Requirements

- FR-1: The system must allow each user to save multiple named filter presets.
- FR-2: The system must persist the full set of filters associated with each preset.
- FR-3: The system must let users apply a preset from the main view.
- FR-4: The system must let users rename an existing preset.
- FR-5: The system must require confirmation before permanently deleting a preset.

## Non-Goals

- No sharing presets between users
- No automatic preset recommendations
- No import/export flow in the first release

## Technical Notes

- Reuse the existing filter state shape where practical
- Keep preset data scoped to the current user
- Preserve any existing URL/filter synchronization behavior

## Success Metrics

- Users can apply a saved preset in one action
- Rebuilding common filter combinations becomes unnecessary
- No noticeable slowdown when loading the preset list

## Open Questions

- Should there be a maximum number of presets per user?
- Should one preset be markable as the default?
```

---

## Final Check

Before saving the PRD:

- [ ] Asked lettered clarifying questions when needed
- [ ] Reflected the user's answers in the final document
- [ ] Kept user stories small and implementation-friendly
- [ ] Wrote numbered functional requirements
- [ ] Defined clear non-goals
- [ ] Saved to `tasks/prd-[feature-name].md`
