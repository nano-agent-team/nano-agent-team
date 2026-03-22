import type { NatsConnection } from 'nats';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export interface HandlerContext {
  agentId: string;
  nc: NatsConnection;
  mcp: Client;
  db: Database.Database;  // Read-only connection
  log: Logger;
}

export type Handler = (payload: unknown, ctx: HandlerContext) => Promise<void>;
