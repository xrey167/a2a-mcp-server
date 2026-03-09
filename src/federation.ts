// src/federation.ts
// A2A Federation — discover and connect to external A2A agents.
// Supports well-known URL discovery, periodic health checks,
// and skill routing across federated agents.

import { discoverAgent, fetchWithTimeout } from "./a2a.js";
import type { AgentCard } from "./types.js";

export interface FederatedAgent {
  url: string;
  card: AgentCard;
  healthy: boolean;
  lastSeen: number;
  latencyMs: number;
  apiKey?: string;
}

export interface FederationConfig {
  /** URLs to discover (with /.well-known/agent.json) */
  peers: string[];
  /** Health check interval in ms (default: 30s) */
  healthIntervalMs?: number;
  /** Discovery timeout in ms (default: 5s) */
  discoveryTimeoutMs?: number;
}

const DEFAULT_HEALTH_INTERVAL = 30_000;
const DEFAULT_DISCOVERY_TIMEOUT = 5_000;

export class FederationManager {
  private agents = new Map<string, FederatedAgent>();
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private config: FederationConfig;

  constructor(config: FederationConfig) {
    this.config = config;
  }

  /**
   * Discover all configured peers and start health polling.
   */
  async start(): Promise<void> {
    // Discover all peers in parallel
    const results = await Promise.allSettled(
      this.config.peers.map(url => this.discoverPeer(url))
    );

    let discovered = 0;
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) discovered++;
    }
    process.stderr.write(`[federation] discovered ${discovered}/${this.config.peers.length} peers\n`);

    // Start periodic health checks
    const interval = this.config.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL;
    this.healthTimer = setInterval(() => this.healthCheck(), interval);
  }

  /**
   * Stop health polling.
   */
  stop(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  /**
   * Discover a single peer by URL.
   */
  async discoverPeer(url: string, apiKey?: string): Promise<FederatedAgent | null> {
    const timeout = this.config.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT;
    const start = Date.now();
    try {
      const card = await discoverAgent(url);
      const latencyMs = Date.now() - start;
      const agent: FederatedAgent = {
        url: url.replace(/\/$/, ""),
        card,
        healthy: true,
        lastSeen: Date.now(),
        latencyMs,
        apiKey,
      };
      this.agents.set(agent.url, agent);
      process.stderr.write(`[federation] discovered ${card.name} at ${url} (${latencyMs}ms, ${card.skills?.length ?? 0} skills)\n`);
      return agent;
    } catch (err) {
      process.stderr.write(`[federation] failed to discover ${url}: ${err}\n`);
      return null;
    }
  }

  /**
   * Remove a peer.
   */
  removePeer(url: string): boolean {
    return this.agents.delete(url.replace(/\/$/, ""));
  }

  /**
   * Add a peer dynamically (not from initial config).
   */
  async addPeer(url: string, apiKey?: string): Promise<FederatedAgent | null> {
    const agent = await this.discoverPeer(url, apiKey);
    if (agent && !this.config.peers.includes(url)) {
      this.config.peers.push(url);
    }
    return agent;
  }

  /**
   * Health check all known agents.
   */
  private async healthCheck(): Promise<void> {
    const checks = Array.from(this.agents.values()).map(async (agent) => {
      const start = Date.now();
      try {
        const res = await fetchWithTimeout(`${agent.url}/healthz`, {}, 3000);
        if (res.ok) {
          agent.healthy = true;
          agent.lastSeen = Date.now();
          agent.latencyMs = Date.now() - start;
        } else {
          agent.healthy = false;
        }
      } catch {
        agent.healthy = false;
      }
    });
    await Promise.allSettled(checks);
  }

  /**
   * Get all discovered agents.
   */
  getAgents(): FederatedAgent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get only healthy agents.
   */
  getHealthyAgents(): FederatedAgent[] {
    return this.getAgents().filter(a => a.healthy);
  }

  /**
   * Find agents that have a specific skill.
   */
  findBySkill(skillId: string): FederatedAgent[] {
    return this.getHealthyAgents().filter(a =>
      a.card.skills?.some(s => s.id === skillId)
    );
  }

  /**
   * Find agents matching a query (searches name, description, skill names/descriptions).
   */
  search(query: string): FederatedAgent[] {
    const q = query.toLowerCase();
    return this.getHealthyAgents().filter(a => {
      if (a.card.name?.toLowerCase().includes(q)) return true;
      if (a.card.description?.toLowerCase().includes(q)) return true;
      return a.card.skills?.some(s =>
        s.id?.toLowerCase().includes(q) ||
        s.name?.toLowerCase().includes(q) ||
        s.description?.toLowerCase().includes(q)
      );
    });
  }

  /**
   * Get all skills across all healthy federated agents.
   */
  getAllSkills(): Array<{ skillId: string; skillName: string; agentUrl: string; agentName: string }> {
    const skills: Array<{ skillId: string; skillName: string; agentUrl: string; agentName: string }> = [];
    for (const agent of this.getHealthyAgents()) {
      for (const skill of agent.card.skills ?? []) {
        skills.push({
          skillId: skill.id,
          skillName: skill.name ?? skill.id,
          agentUrl: agent.url,
          agentName: agent.card.name ?? agent.url,
        });
      }
    }
    return skills;
  }

  /**
   * Summary for dashboard/monitoring.
   */
  getSummary(): {
    total: number;
    healthy: number;
    unhealthy: number;
    totalSkills: number;
    agents: Array<{ url: string; name: string; healthy: boolean; skills: number; latencyMs: number }>;
  } {
    const agents = this.getAgents();
    return {
      total: agents.length,
      healthy: agents.filter(a => a.healthy).length,
      unhealthy: agents.filter(a => !a.healthy).length,
      totalSkills: this.getAllSkills().length,
      agents: agents.map(a => ({
        url: a.url,
        name: a.card.name ?? a.url,
        healthy: a.healthy,
        skills: a.card.skills?.length ?? 0,
        latencyMs: a.latencyMs,
      })),
    };
  }
}
