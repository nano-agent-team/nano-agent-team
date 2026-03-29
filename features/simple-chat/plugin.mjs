/**
 * Simple Chat Feature Plugin
 *
 * Express route for chatting with the simple-chat agent via NATS request-reply.
 *
 * Routes:
 *   POST /api/chat/simple-chat  → NATS bridge: agent.simple-chat.inbox
 *   GET  /features/simple-chat/* → static frontend assets
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { StringCodec } from 'nats';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const codec = StringCodec();

export default {
  async register(app, nc, _manager, opts) {
    const { publishNats } = opts;

    // ── POST /api/chat/simple-chat ────────────────────────────────────────────
    // agentId in body overrides default; fallback: chat-agent (always present in BASE_AGENTS)
    app.post('/api/chat/simple-chat', async (req, res) => {
      const { message, sessionId, agentId: bodyAgentId } = req.body ?? {};
      if (!message) return res.status(400).json({ error: '"message" required' });

      const targetAgent = bodyAgentId ?? 'chat-agent';

      const sid = sessionId ?? 'default';
      const streamSubject = `chat.stream.${sid}.${Date.now()}`;

      // SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      const sse = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        res.flush?.();
      };

      try {
        const sub = nc.subscribe(streamSubject);
        res.on('close', () => sub.unsubscribe());
        const timeoutHandle = setTimeout(() => sub.unsubscribe(), 300_000);

        await publishNats(`agent.${targetAgent}.inbox`,
          JSON.stringify({ text: message, sessionId: sid, streamSubject }),
        );

        for await (const msg of sub) {
          const event = JSON.parse(codec.decode(msg.data));
          sse(event);
          if (event.type === 'done' || event.type === 'error') break;
        }

        clearTimeout(timeoutHandle);
      } catch (err) {
        sse({ type: 'error', error: `Agent ${targetAgent} not responding` });
      }
      res.end();
    });

    // ── Serve simple-chat frontend static assets ──────────────────────────────
    const frontendDist = path.join(__dirname, 'frontend-dist');
    if (fs.existsSync(frontendDist)) {
      const { default: express } = await import('express');
      app.use('/features/simple-chat', express.static(frontendDist));
      console.log('[simple-chat feature] Serving frontend from', frontendDist);
    } else {
      console.log('[simple-chat feature] Frontend not built — run: cd features/simple-chat/frontend && npm run build');
    }

    console.log('[simple-chat feature] Chat API registered (POST /api/chat/simple-chat)');
  },
};
