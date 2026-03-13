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
    const { } = opts;

    // ── POST /api/chat/simple-chat ────────────────────────────────────────────
    app.post('/api/chat/simple-chat', async (req, res) => {
      const { message, sessionId } = req.body ?? {};
      if (!message) return res.status(400).json({ error: '"message" required' });

      const sid = sessionId ?? 'default';
      const replySubject = `chat.reply.${sid}.${Date.now()}`;

      try {
        const sub = nc.subscribe(replySubject, { max: 1, timeout: 30_000 });

        await nc.publish(
          'agent.simple-chat.inbox',
          codec.encode(JSON.stringify({ text: message, sessionId: sid, replySubject })),
        );

        for await (const msg of sub) {
          const data = JSON.parse(codec.decode(msg.data));
          // data is a ReplyPayload: { agentId, result, error?, ts }
          const reply = typeof data?.result === 'string' ? data.result : JSON.stringify(data);
          res.json({ reply });
          break;
        }
      } catch (err) {
        res.status(503).json({ error: 'Simple chat agent not responding', detail: String(err) });
      }
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
