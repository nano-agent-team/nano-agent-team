/**
 * Alarm Clock — generic timer service for agents.
 *
 * Any agent can set an alarm: "wake me up in N seconds with this payload."
 * When the alarm fires, a NATS message is published to the agent's task subject.
 *
 * Persists active alarms to DATA_DIR/alarms.json for restart survival.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { NatsConnection } from 'nats';

import { logger } from './logger.js';
import { publish } from './nats-client.js';

export interface Alarm {
  id: string;
  agentId: string;
  /** Seconds from creation until fire */
  delaySeconds: number;
  /** NATS subject to publish to (default: agent.{agentId}.task) */
  subject?: string;
  /** JSON payload to send when alarm fires */
  payload: Record<string, unknown>;
  /** ISO timestamp when alarm was created */
  createdAt: string;
  /** ISO timestamp when alarm will fire */
  firesAt: string;
}

interface PersistedState {
  alarms: Alarm[];
}

export class AlarmClock {
  private alarms = new Map<string, Alarm>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private persistPath: string;

  constructor(
    private readonly nc: NatsConnection,
    dataDir: string,
  ) {
    this.persistPath = path.join(dataDir, 'alarms.json');
    this.restore();
  }

  /**
   * Set an alarm. Returns the alarm ID.
   */
  set(agentId: string, delaySeconds: number, payload: Record<string, unknown>, subject?: string): Alarm {
    const id = `alarm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date();
    const firesAt = new Date(now.getTime() + delaySeconds * 1000);

    const alarm: Alarm = {
      id,
      agentId,
      delaySeconds,
      subject: subject ?? `agent.${agentId}.task`,
      payload,
      createdAt: now.toISOString(),
      firesAt: firesAt.toISOString(),
    };

    this.alarms.set(id, alarm);
    this.scheduleTimer(alarm);
    this.persist();

    logger.info({ alarmId: id, agentId, delaySeconds, firesAt: alarm.firesAt }, 'Alarm set');
    return alarm;
  }

  /**
   * Cancel an alarm by ID. Returns true if found and cancelled.
   */
  cancel(id: string): boolean {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    const existed = this.alarms.delete(id);
    if (existed) {
      this.persist();
      logger.info({ alarmId: id }, 'Alarm cancelled');
    }
    return existed;
  }

  /**
   * Cancel all alarms for a given agent.
   */
  cancelForAgent(agentId: string): number {
    let count = 0;
    for (const [id, alarm] of this.alarms) {
      if (alarm.agentId === agentId) {
        this.cancel(id);
        count++;
      }
    }
    return count;
  }

  /**
   * List all active alarms, optionally filtered by agentId.
   */
  list(agentId?: string): Alarm[] {
    const all = [...this.alarms.values()];
    if (agentId) return all.filter(a => a.agentId === agentId);
    return all;
  }

  /**
   * Shutdown — clear all timers (alarms stay persisted for next startup).
   */
  shutdown(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private scheduleTimer(alarm: Alarm): void {
    const now = Date.now();
    const fireTime = new Date(alarm.firesAt).getTime();
    const delay = Math.max(0, fireTime - now);

    const timer = setTimeout(() => this.fire(alarm), delay);
    this.timers.set(alarm.id, timer);
  }

  private async fire(alarm: Alarm): Promise<void> {
    this.timers.delete(alarm.id);
    this.alarms.delete(alarm.id);
    this.persist();

    const subject = alarm.subject ?? `agent.${alarm.agentId}.task`;
    try {
      await publish(this.nc, subject, JSON.stringify(alarm.payload));
      logger.info({ alarmId: alarm.id, agentId: alarm.agentId, subject }, 'Alarm fired');
    } catch (err) {
      logger.error({ err, alarmId: alarm.id, agentId: alarm.agentId }, 'Alarm fire failed');
    }

    // No auto-reschedule. Wakeup agent manages periodic scheduling externally.
  }

  private persist(): void {
    const state: PersistedState = { alarms: [...this.alarms.values()] };
    try {
      fs.writeFileSync(this.persistPath, JSON.stringify(state, null, 2));
    } catch (err) {
      logger.warn({ err }, 'AlarmClock: failed to persist state');
    }
  }

  private restore(): void {
    if (!fs.existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.persistPath, 'utf8')) as PersistedState;
      const now = Date.now();
      for (const alarm of raw.alarms) {
        const fireTime = new Date(alarm.firesAt).getTime();
        if (fireTime <= now) {
          // Alarm should have fired while we were down — fire immediately
          void this.fire(alarm);
        } else {
          this.alarms.set(alarm.id, alarm);
          this.scheduleTimer(alarm);
        }
      }
      logger.info({ count: this.alarms.size }, 'AlarmClock: restored alarms from disk');
    } catch (err) {
      logger.warn({ err }, 'AlarmClock: failed to restore state');
    }
  }
}
