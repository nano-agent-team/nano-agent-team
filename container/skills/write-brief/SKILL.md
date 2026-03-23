---
name: write-brief
description: Use when decomposing an approved idea into an actionable plan. Writes a brief to Obsidian plans/.
---

# Write Brief

Decompose an approved idea into a concrete action plan.

## Steps

### 1. Read the approved idea

Read the idea file from `/obsidian/Consciousness/ideas/{ideaId}.md`. Understand the goal, context, and what needs to happen.

### 2. Analyze what's needed

- Does it require new agents or teams? → `target: foreman`
- Does it require code changes or features? → `target: dev`
- Both? → `target: mixed`

### 3. Write plan file

Write to `/obsidian/Consciousness/plans/{planId}.md`:

```yaml
---
id: plan-{YYYYMMDD}-{short-name}
idea: {ideaId}
status: pending
created: {ISO timestamp}
target: foreman|dev|mixed
---

# {Plan title}

## Context
{Why this plan exists — link back to the idea and goal.}

## Requirements
- {Concrete requirement 1}
- {Concrete requirement 2}

## Acceptance Criteria
- [ ] {Criterion 1}
- [ ] {Criterion 2}

## Priority
{high|medium|low}

## Actions
1. {Action description} (target: foreman|dev)
2. {Action description} (target: foreman|dev)

## Dependencies
- {Any prerequisites or ordering constraints}
```

### 4. Update idea status

Edit the idea file — change `status: approved` to `status: in_progress`.

### Rules

- One plan per idea — never create duplicates
- Write FULL briefs — the consumer should act without asking questions
- The infrastructure routes `status: pending` plans to Foreman automatically
- Foreman handles infra actions, PM handles dev actions — you don't need to dispatch manually
