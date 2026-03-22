/**
 * Workspace-manager deterministic handler.
 *
 * Called when a ticket is dispatched to workspace-manager in the pipeline.
 * Creates a git worktree workspace for the ticket, then sets the ticket to "done"
 * so the scrum-master can route it to the next pipeline step (sd-architect).
 *
 * NOTE: The deterministic runner has NO after-work hook (unlike agent-runner).
 * This handler must explicitly set ticket status to "done" via MCP.
 */

import type { Handler, HandlerContext } from '../types.js';

async function callMcpTool(
  mcp: HandlerContext['mcp'],
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await mcp.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>)?.[0]?.text;
  if (result.isError) throw new Error(text ?? 'MCP tool error');
  return text ? JSON.parse(text) : null;
}

const handle: Handler = async (payload, ctx) => {
  const { mcp, log } = ctx;
  const p = payload as Record<string, unknown>;
  const ticketId = p.ticket_id as string | undefined;

  // Ignore alarm/poll messages (scrum-master bootstrap alarm fires on all deterministic agents)
  if (!ticketId || p.type === 'poll') {
    log.debug({ payload }, 'workspace-manager: ignoring non-task payload');
    return;
  }

  log.info({ ticketId }, 'workspace-manager: creating workspace');

  try {
    // 1. Create workspace
    const workspace = await callMcpTool(mcp, 'workspace_create', {
      repoType: 'nano-agent-team',
      ownerId: ticketId,
    }) as { workspaceId?: string; path?: string } | null;

    const wsId = workspace?.workspaceId ?? 'unknown';
    log.info({ ticketId, workspaceId: wsId }, 'workspace-manager: workspace created');

    // 2. Add comment with workspace info
    await callMcpTool(mcp, 'ticket_comment', {
      ticket_id: ticketId,
      body: `Workspace ready: \`${wsId}\` — branch: \`feat/${ticketId}\``,
    });

    // 3. Set ticket to done (scrum-master will route to sd-architect via pipeline config)
    await callMcpTool(mcp, 'ticket_update', {
      ticket_id: ticketId,
      status: 'done',
    });

    log.info({ ticketId, workspaceId: wsId }, 'workspace-manager: done');
  } catch (err) {
    // Add diagnostic comment before propagating error
    // (orphan detection will pick up the in_progress ticket after GRACE_PERIOD_MS)
    try {
      await callMcpTool(mcp, 'ticket_comment', {
        ticket_id: ticketId,
        body: `Workspace creation failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } catch { /* ignore comment failure */ }

    log.error({ ticketId, err }, 'workspace-manager: workspace creation failed');
    throw err;
  }
};

export default handle;
