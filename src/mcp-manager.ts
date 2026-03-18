/**
 * McpManager — Docker lifecycle for MCP server containers
 *
 * Each MCP server runs as an isolated Docker container.
 * Secrets from SecretStore are injected as env vars — agents never see them directly.
 *
 * Container naming: nano-mcp-{serverId}
 * Each server exposes HTTP MCP on its configured port (default: 3000).
 *
 * McpGateway uses getUrl(serverId) to resolve where to proxy tool calls.
 */

import Dockerode from 'dockerode';

import { DOCKER_NETWORK } from './config.js';
import { logger } from './logger.js';
import type { McpServerManifest } from './mcp-server-registry.js';
import type { SecretStore } from './secret-store.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type McpServerStatus = 'starting' | 'running' | 'stopped' | 'dead';

interface McpServerState {
  manifest: McpServerManifest;
  containerId?: string;
  status: McpServerStatus;
  /** URL the MCP Gateway uses to reach this server */
  url: string;
}

// ─── McpManager ───────────────────────────────────────────────────────────────

export class McpManager {
  private docker: Dockerode;
  private states = new Map<string, McpServerState>();

  constructor(private readonly secretStore: SecretStore) {
    this.docker = new Dockerode();
  }

  async start(manifest: McpServerManifest): Promise<void> {
    const { id, image, port = 3000, required_secrets } = manifest;
    const containerName = `nano-mcp-${id}`;

    this.states.set(id, {
      manifest,
      status: 'starting',
      url: this.resolveUrl(containerName, port),
    });

    logger.info({ id, image }, 'Starting MCP server container');

    try {
      await this.removeContainerIfExists(containerName);

      // Inject required secrets as env vars
      const missing = this.secretStore.getMissing(required_secrets);
      if (missing.length > 0) {
        logger.warn({ id, missing }, 'MCP server: required secrets not set — container may not function correctly');
      }

      const env = [
        `PORT=${port}`,
        ...this.secretStore.getEnvVars(required_secrets),
      ];

      const container = await this.docker.createContainer({
        Image: image,
        name: containerName,
        Env: env,
        HostConfig: {
          NetworkMode: DOCKER_NETWORK,
          RestartPolicy: { Name: 'no' },
        },
      });

      await container.start();

      const state = this.states.get(id)!;
      state.containerId = container.id;
      state.status = 'running';

      logger.info(
        { id, containerId: container.id.slice(0, 12), url: state.url },
        'MCP server container started',
      );
    } catch (err) {
      logger.error({ err, id }, 'Failed to start MCP server container');
      const state = this.states.get(id);
      if (state) state.status = 'dead';
    }
  }

  async stop(id: string): Promise<void> {
    const state = this.states.get(id);
    if (!state?.containerId) return;

    const containerName = `nano-mcp-${id}`;
    logger.info({ id, containerName }, 'Stopping MCP server container');

    try {
      const container = this.docker.getContainer(state.containerId);
      await container.stop({ t: 10 }).catch(() => {});
      await container.remove({ force: true }).catch(() => {});
      state.status = 'stopped';
      logger.info({ id }, 'MCP server container stopped');
    } catch (err) {
      logger.warn({ err, id }, 'Error stopping MCP server container');
    }
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.states.keys()].map((id) => this.stop(id)));
  }

  /**
   * Restart a running MCP server — used after a secret is updated via settings agent.
   * The new container picks up the updated secret from SecretStore.
   */
  async restart(id: string): Promise<void> {
    const state = this.states.get(id);
    if (!state) {
      logger.warn({ id }, 'McpManager.restart: server not found');
      return;
    }
    await this.stop(id);
    await this.start(state.manifest);
  }

  /**
   * Returns the HTTP URL of a running MCP server container.
   * Returns undefined if the server is not running.
   */
  getUrl(id: string): string | undefined {
    const state = this.states.get(id);
    if (state?.status === 'running') return state.url;
    return undefined;
  }

  getStates(): Array<{ id: string; status: McpServerStatus; url: string }> {
    return [...this.states.values()].map((s) => ({
      id: s.manifest.id,
      status: s.status,
      url: s.url,
    }));
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /**
   * Resolve URL the gateway uses to reach the MCP server.
   * - host network: localhost:{port}
   * - bridge network: container name resolves via Docker DNS
   */
  private resolveUrl(containerName: string, port: number): string {
    if (DOCKER_NETWORK === 'host') return `http://localhost:${port}`;
    return `http://${containerName}:${port}`;
  }

  private async removeContainerIfExists(containerName: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerName);
      const info = await container.inspect() as { State: { Running: boolean } };
      if (info.State.Running) await container.stop({ t: 10 });
      await container.remove({ force: true });
      logger.debug({ containerName }, 'Removed stale MCP server container');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('404') && !msg.includes('no such container')) {
        logger.warn({ err, containerName }, 'Unexpected error removing MCP server container');
      }
    }
  }
}
