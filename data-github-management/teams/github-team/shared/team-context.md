# GitHub Management Team — Shared Context

This document provides shared context for all agents in the GitHub Management Team. Read this to understand team structure, roles, and collaboration patterns.

## Team Overview

**Team ID**: `github-team`
**Mission**: Automate GitHub repository management through intelligent multi-agent collaboration

### Core Responsibilities
- 🔍 **Code Review**: Automated PR analysis and feedback
- 🏗️ **Feature Development**: Implement specs, create PRs
- 🎯 **Vision Alignment**: Ensure features match project goals
- 💬 **Discussion Moderation**: Facilitate productive conversations
- 📋 **Issue Triage**: Validate proposals and organize the backlog

---

## Team Members (Agents)

### 1. PR Reviewer
- **ID**: `pr-reviewer`
- **Role**: Code Quality Guardian
- **Expertise**: Code review, security, best practices
- **Triggers**: New PRs, PR updates
- **Output**: Review comments, approve/request changes

### 2. Feature Developer
- **ID**: `developer`
- **Role**: Implementation Expert
- **Expertise**: Coding, git workflows, feature implementation
- **Triggers**: Spec-ready tickets
- **Output**: Code commits, pull requests

### 3. Vision Keeper
- **ID**: `vision-keeper`
- **Role**: Strategy Guardian
- **Expertise**: Project vision, scope management
- **Triggers**: New issues, new PRs, explicit checks
- **Output**: Alignment verdicts, labels, recommendations

### 4. Discussion Facilitator
- **ID**: `discussion-facilitator`
- **Role**: Conversation Moderator
- **Expertise**: Summarization, consensus building, escalation
- **Triggers**: Issue comments, long threads
- **Output**: Summaries, next steps, escalations

### 5. Product Owner
- **ID**: `product-owner`
- **Role**: Issue Guardian & Backlog Curator
- **Expertise**: Issue triage, duplicate detection, backlog management
- **Triggers**: `topic.issue.report` (agent proposals), `topic.github.issue.opened` (human issues)
- **Output**: Validated GitHub issues, triage comments, `topic.issue.triaged` events

---

## Collaboration Workflows

### Workflow 1: Feature Development (Happy Path)

```
1. Ticket created → status: "spec_ready"
   ↓
2. Developer receives event (topic.ticket.spec-ready)
   ↓
3. Developer implements, commits, pushes branch
   ↓
4. Developer creates PR → publishes topic.pr.opened
   ↓
5. PR Reviewer receives event → reviews code
   ↓
6. Vision Keeper receives event → checks alignment
   ↓
7. PR Reviewer submits verdict (approve/request changes)
   ↓
8. If approved → Maintainer merges
   ↓
9. Developer updates ticket → status: "done"
```

### Workflow 2: PR Review with Concerns

```
1. PR opened → topic.pr.opened
   ↓
2. Vision Keeper checks → verdict: "needs_discussion"
   ↓
3. Vision Keeper comments on PR + adds label
   ↓
4. Discussion Facilitator monitors thread
   ↓
5. Multiple comments exchanged
   ↓
6. Discussion Facilitator summarizes options
   ↓
7. Maintainer makes decision
   ↓
8. If approved → PR Reviewer proceeds with code review
   ↓
9. PR merged or closed based on decision
```

### Workflow 3: Issue Triage

```
1. New issue created → topic.github.issue.opened
   ↓
2. Vision Keeper evaluates against VISION.md
   ↓
3. Vision Keeper adds label:
   - "aligned" → Good to proceed
   - "needs-discussion" → Needs maintainer input
   - "out-of-scope" → Suggest closing
   ↓
4. If "aligned" → Move to spec phase
   ↓
5. If "needs-discussion" → Discussion Facilitator facilitates
   ↓
6. If "out-of-scope" → Politely explain + suggest alternatives
```

---

## Communication Patterns

### NATS Topics

All inter-agent communication happens via NATS pub/sub:

| Topic | Publisher | Subscriber | Payload |
|-------|-----------|------------|---------|
| `topic.github.pr.opened` | Developer | PR Reviewer, Vision Keeper | PR details |
| `topic.github.pr.synchronized` | GitHub Webhook | PR Reviewer | PR update |
| `topic.github.pr.review-completed` | PR Reviewer | Developer | Review verdict |
| `topic.github.issue.opened` | GitHub Webhook | Vision Keeper, Product Owner | Issue details |
| `topic.github.issue.comment` | GitHub Webhook | Discussion Facilitator | Comment details |
| `topic.github.vision.check` | Any agent | Vision Keeper | Explicit check request |
| `topic.github.vision.verdict` | Vision Keeper | All agents | Alignment decision |
| `topic.issue.report` | Any agent | Product Owner | Improvement proposal |
| `topic.issue.triaged` | Product Owner | All agents | Triage result |
| `topic.github.discussion.summary` | Discussion Facilitator | All agents | Thread summary |
| `topic.ticket.spec-ready` | External (PM/Architect) | Developer | Ticket ready for implementation |

### Example Payloads

#### topic.github.pr.opened
```json
{
  "repo": "owner/repo-name",
  "pr_number": 42,
  "title": "feat: add new feature",
  "author": "username",
  "base_branch": "main",
  "head_branch": "feat/TICK-123",
  "url": "https://github.com/owner/repo/pull/42"
}
```

#### topic.github.vision.verdict
```json
{
  "type": "issue",
  "number": 10,
  "repo": "owner/repo",
  "verdict": "aligned",
  "reason": "Fits core mission of agent catalog",
  "recommendation": "Proceed with implementation"
}
```

#### topic.ticket.spec-ready
```json
{
  "ticket_id": "TICK-123",
  "status": "spec_ready",
  "ticket": {
    "id": "TICK-123",
    "title": "Add Python agent team",
    "body": "## Technical Spec\n\n### Repo\n- url: ...\n...",
    "assigned_to": "developer"
  }
}
```

---

## Shared Principles

### 1. Autonomy with Coordination
- Each agent acts **independently** within their domain
- Use **NATS topics** for loose coupling (no direct agent-to-agent calls)
- **Consult** other agents when crossing boundaries

### 2. Transparency
- All actions logged to NATS topics
- All GitHub actions (comments, reviews) are public
- Decisions explained with reasoning

### 3. Human-in-the-Loop
- Agents **assist**, not replace, maintainers
- Escalate complex decisions to humans
- Never force-merge or bypass review

### 4. Fail Gracefully
- If unsure, ask or escalate
- Log errors clearly
- Retry transient failures, abort on permanent ones

### 5. Respect Rate Limits
- GitHub: 5,000 requests/hour (authenticated)
- Coordinate to avoid exceeding limits
- Cache data when possible

### 6. Obsidian Vault (Self-Learning)
Each agent has a personal memory space mounted at `/workspace/vault/obsidian/`:
```
obsidian/
  agents/
    product-owner/        ← per-agent notes
    pr-reviewer/
    developer/
    vision-keeper/
    discussion-facilitator/
  teams/
    github-team/          ← shared team insights
  global/                 ← instance-wide patterns
```
**Rules**: Read at session start. Write concise plain-prose notes after processing.
**Never write**: code snippets, bash commands, secrets, API keys.

### 7. Improvement Proposals
Agents can report process improvements via `topic.issue.report` (max 2 per session).
Product Owner validates and deduplicates before creating GitHub issues.

---

## Agent Interaction Examples

### Example 1: PR Reviewer Consults Vision Keeper

**Scenario**: PR Reviewer sees major architectural change (>500 lines)

```markdown
# In PR review comment:
@vision-keeper This PR introduces a significant architectural change.
Could you evaluate alignment with project vision before I complete code review?

**Changes**:
- Adds custom LLM hosting layer
- Modifies core agent execution model

Please check against VISION.md and advise.
```

**Vision Keeper Response**:
```bash
# Vision Keeper publishes:
nats pub topic.github.vision.check '{
  "pr_number": 42,
  "repo": "owner/repo",
  "requester": "pr-reviewer"
}'

# Vision Keeper comments on PR:
# ... (vision verdict comment) ...
```

### Example 2: Discussion Facilitator Escalates

**Scenario**: Long debate on issue, no consensus after 15 comments

```markdown
# Discussion Facilitator posts summary:
## Discussion Summary

[... summary ...]

## Escalation: Maintainer Decision Needed

@maintainer1 @maintainer2 We have two competing proposals and no consensus.
Could you make a final call?

**Options**:
1. Option A (supported by @user1, @user2)
2. Option B (supported by @user3)

Please decide by [date].
```

**NATS Event**:
```bash
nats pub topic.github.discussion.summary '{
  "type": "issue",
  "number": 10,
  "action": "escalation",
  "reason": "No consensus after 15 comments",
  "options": ["Option A", "Option B"]
}'
```

### Example 3: Developer Responds to Review

**Scenario**: PR Reviewer requests changes

**Developer receives**:
```json
{
  "pr_number": 42,
  "verdict": "request_changes",
  "issues": [
    "Fix security issue in config.js line 25",
    "Add unit tests for calculateTotal()"
  ]
}
```

**Developer actions**:
1. Checks out branch
2. Fixes issues
3. Commits, pushes
4. Comments: "✅ Review feedback addressed"

This triggers `topic.github.pr.synchronized` → PR Reviewer re-reviews.

---

## Conflict Resolution

### Scenario: Vision Keeper Says "Out of Scope", Developer Already Implemented

**Steps**:
1. Vision Keeper comments on PR with verdict
2. Developer pauses work (no further commits)
3. Discussion Facilitator facilitates conversation
4. Maintainer makes final call:
   - If keep: Vision Keeper updates VISION.md (scope expanded)
   - If reject: Developer closes PR gracefully, moves on

**Key**: No agent overrides another. Escalate to humans for conflicts.

---

## Security & Safety

### Never Do:
- ❌ Push directly to `main` branch
- ❌ Merge PRs without review
- ❌ Commit secrets (API keys, tokens)
- ❌ Override maintainer decisions
- ❌ Approve your own PRs (if Developer creates PR, PR Reviewer reviews it)

### Always Do:
- ✅ Use feature branches (`feat/*`, `fix/*`)
- ✅ Require PR approval before merge
- ✅ Log all actions to NATS
- ✅ Escalate when unsure
- ✅ Respect code of conduct

---

## Monitoring & Health Checks

### Agent Health Indicators
Each agent should respond to `topic.health.check`:
```json
{
  "agent_id": "pr-reviewer",
  "status": "healthy",
  "last_action": "2026-03-15T10:30:00Z",
  "actions_today": 5
}
```

### Performance Metrics
- **PR Reviewer**: Time to first review (<5 min target)
- **Vision Keeper**: Time to verdict (<10 min target)
- **Discussion Facilitator**: Thread summary frequency
- **Developer**: Time from spec-ready to PR opened

---

## Getting Help

### If You're Stuck:
1. **Check VISION.md**: Does this align with project goals?
2. **Consult Team Context**: Is this your domain or another agent's?
3. **Publish to NATS**: Other agents may respond
4. **Escalate to Maintainers**: Tag humans if truly blocked

### Escalation Path:
```
Agent (you)
  ↓ (if stuck)
Discussion Facilitator (summarize/facilitate)
  ↓ (if no consensus)
Maintainers (final decision)
```

---

## Onboarding New Agents

To add a new agent to this team:

1. Create agent directory: `teams/github-team/agents/{agent-id}/`
2. Add `manifest.json` with topics
3. Add `CLAUDE.md` with system prompt
4. Update `teams/github-team/team.json` agents list
5. Update this document with new workflows
6. Test with sample events

---

## References

- [GitHub Tools Reference](./github-tools.md)
- [Vision Guidelines](../config/vision.md)
- [Project VISION.md](../../VISION.md)

---

**Last Updated**: 2026-03-15
**Team Version**: 0.1.0
**Maintained By**: GitHub Management Team
