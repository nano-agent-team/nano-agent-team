---
name: create-idea
description: Use when you have identified a goal or idea worth pursuing. Creates goal and idea files in Obsidian.
---

# Create Idea

Write goal and idea files to Obsidian so the pipeline can process them.

## Steps

### 1. Create directories

```bash
mkdir -p /obsidian/Consciousness/goals /obsidian/Consciousness/ideas /obsidian/Consciousness/journal
```

### 2. Write goal file (if new direction)

Write to `/obsidian/Consciousness/goals/{goalId}.md`:

```yaml
---
id: goal-{short-name}
title: "{Goal title}"
status: active
created: {YYYY-MM-DD}
author: consciousness
---

{Why this goal matters, in plain language.}
```

### 3. Write idea file

Write to `/obsidian/Consciousness/ideas/{ideaId}.md`:

```yaml
---
id: idea-{short-name}-001
goal: {goalId}
status: pending_review
created: {YYYY-MM-DD}
author: consciousness
conscience_verdict:
conscience_reason:
reconsiders:
---

{What the idea is about — concrete enough for someone else to evaluate and act on.}
```

### 4. Log in journal

Append to `/obsidian/Consciousness/journal/{YYYY-MM-DD}.md`:

```markdown
---
date: {YYYY-MM-DD}
---

## {Short summary}
{What happened, what was decided.}
```

### Rules

- One idea file per idea — never combine multiple ideas
- `reconsiders:` links to a rejected idea this one improves on (optional)
- Never modify a rejected idea — create a new one instead
- The infrastructure routes `pending_review` ideas to Conscience automatically
