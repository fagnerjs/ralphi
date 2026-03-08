---
name: ralph
description: "Transform an existing PRD into the `prd.json` structure used by Ralph. Use when a feature spec already exists and needs to be turned into Ralph's JSON execution format. Triggers on: convert this prd, turn this into ralph format, create prd.json from this, ralph json."
user-invocable: true
---

# Ralph JSON Converter

Turn an existing PRD into the `prd.json` document Ralph uses to drive autonomous execution.

---

## Goal

Take a PRD in Markdown or plain text and produce `prd.json` inside the Ralph workspace.

---

## Required Output Shape

Use this structure:

```json
{
  "project": "[Project Name]",
  "branchName": "ralph/[feature-name-kebab-case]",
  "description": "[Short feature summary based on the PRD]",
  "userStories": [
    {
      "id": "US-001",
      "title": "[Story title]",
      "description": "As a [user], I want [capability] so that [benefit]",
      "acceptanceCriteria": [
        "Criterion 1",
        "Criterion 2",
        "Typecheck passes"
      ],
      "priority": 1,
      "passes": false,
      "notes": ""
    }
  ]
}
```

---

## Most Important Rule: Keep Stories Small

Every story must fit within a single Ralph iteration.

Ralph starts each iteration with a fresh Amp session. If a story spans too much code or too many concerns, the model is likely to lose context and leave the work incomplete.

### Good story sizes
- Add one database field plus its migration
- Add one focused backend behavior
- Add one UI element to an existing screen
- Add one filter or control to an existing list

### Stories that are too large
Break down items like these:
- "Build the whole dashboard"
- "Add authentication"
- "Refactor the API"

Instead, split them into smaller steps such as schema work, backend logic, UI pieces, and follow-up interactions.

**Practical rule:** if the change cannot be explained clearly in 2-3 sentences, split it further.

---

## Order Stories by Dependency

Ralph executes stories according to priority. Earlier work must unlock later work, not depend on it.

### Preferred order
1. Database or schema changes
2. Backend or server-side behavior
3. UI work that depends on the backend
4. Summary, reporting, or aggregation views

### Avoid this pattern
1. UI story that assumes missing backend or schema support
2. Supporting backend/schema story that should have come first

---

## Acceptance Criteria Must Be Checkable

Write criteria Ralph can verify directly.

### Strong acceptance criteria
- "Add `status` column to tasks table with default `pending`"
- "Status filter shows All, Active, and Completed"
- "Delete action opens a confirmation dialog"
- "Typecheck passes"
- "Tests pass"

### Weak acceptance criteria
- "Works correctly"
- "Easy to use"
- "Looks good"
- "Handles edge cases well"

### Always include
Every story must end with:

```
"Typecheck passes"
```

### Include when the story has testable logic
Add:

```
"Tests pass"
```

### Include when the story changes UI
Add:

```
"Verify in browser using dev-browser skill"
```

UI changes are not considered complete until visually checked with the browser skill.

---

## Conversion Rules

Follow these rules every time:

1. Each user story becomes one item in `userStories`
2. Story IDs are sequential: `US-001`, `US-002`, and so on
3. `priority` reflects dependency order first, then source order
4. Every story starts with `passes: false` and `notes: ""`
5. `branchName` is derived from the feature name in kebab-case and prefixed with `ralph/`
6. Add `Typecheck passes` to every story even if the source PRD omitted it

---

## How To Split Large PRDs

If the PRD describes a large feature, convert it into multiple focused stories.

**Example input idea:**
> "Add a notification system"

**Possible split:**
1. Create notifications table and persistence model
2. Add service for creating and delivering notifications
3. Add notification entry point in the header
4. Add notification panel or dropdown
5. Add mark-as-read behavior
6. Add notification settings screen

Each story should represent one coherent change Ralph can finish and verify in a single pass.

---

## Example

**Input PRD:**
```markdown
# Issue Priority Controls

Let users assign and view issue priority levels.

## Requirements
- Persist priority in storage
- Show priority badge in issue rows
- Allow changing priority from the issue details view
- Filter issues by priority
```

**Output `prd.json`:**
```json
{
  "project": "IssueTracker",
  "branchName": "ralph/issue-priority-controls",
  "description": "Issue Priority Controls - Add persistent priority levels with filtering and UI indicators",
  "userStories": [
    {
      "id": "US-001",
      "title": "Add priority field to issue storage",
      "description": "As a developer, I need issue priority stored persistently.",
      "acceptanceCriteria": [
        "Add priority field with values 'low' | 'medium' | 'high' and default 'medium'",
        "Migration runs successfully",
        "Typecheck passes"
      ],
      "priority": 1,
      "passes": false,
      "notes": ""
    },
    {
      "id": "US-002",
      "title": "Show priority badge in issue rows",
      "description": "As a user, I want to see issue priority at a glance.",
      "acceptanceCriteria": [
        "Each issue row shows a visible priority badge",
        "Badge colors clearly distinguish low, medium, and high priority",
        "Typecheck passes",
        "Verify in browser using dev-browser skill"
      ],
      "priority": 2,
      "passes": false,
      "notes": ""
    },
    {
      "id": "US-003",
      "title": "Change priority from issue details",
      "description": "As a user, I want to update issue priority from the details screen.",
      "acceptanceCriteria": [
        "Issue details screen includes a priority control",
        "Saving a new priority persists immediately",
        "Updated priority is reflected in the UI without a full reload",
        "Typecheck passes",
        "Verify in browser using dev-browser skill"
      ],
      "priority": 3,
      "passes": false,
      "notes": ""
    },
    {
      "id": "US-004",
      "title": "Filter issues by priority",
      "description": "As a user, I want to narrow the list by priority level.",
      "acceptanceCriteria": [
        "Priority filter includes All, Low, Medium, and High options",
        "Selected filter changes the visible issue list correctly",
        "Typecheck passes",
        "Verify in browser using dev-browser skill"
      ],
      "priority": 4,
      "passes": false,
      "notes": ""
    }
  ]
}
```

---

## Archive Existing Runs First

Before replacing an existing `prd.json`, check whether it belongs to a different feature.

1. Read the current `prd.json` if it exists
2. Compare its `branchName` with the new branch name
3. If the branch name is different and `progress.txt` contains more than its initial header:
   - Create `archive/YYYY-MM-DD-feature-name/`
   - Copy the current `prd.json` and `progress.txt` into that archive folder
   - Reset `progress.txt` with a fresh header

`ralphi.sh` already handles this automatically during normal runs. This step matters when the JSON is being updated manually between runs.

---

## Final Checklist

Before saving `prd.json`, confirm that:

- [ ] A previous run was archived when required
- [ ] Every story is small enough for one Ralph iteration
- [ ] Stories are ordered by dependency
- [ ] Every story includes `Typecheck passes`
- [ ] UI stories include `Verify in browser using dev-browser skill`
- [ ] Acceptance criteria are observable and specific
- [ ] No story depends on a later story
