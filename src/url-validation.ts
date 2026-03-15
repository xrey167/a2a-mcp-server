// src/url-validation.ts
// SSRF prevention — validates URLs against allowed ports and remote URLs.

let allowedPorts = new Set<number>();
let allowedRemoteOrigins = new Set<string>();

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "[::ffff:7f00:1]"]);

/** Configure the allowed ports and remote URLs (called during server startup). */
export function configureAllowedUrls(ports: number[], remoteUrls: string[]): void {
  allowedPorts = new Set(ports);
  allowedRemoteOrigins = new Set();
  for (const url of remoteUrls) {
    try {
      allowedRemoteOrigins.add(new URL(url).origin);
    } catch (e) {
      const safeUrl = (() => { try { const u = new URL(url); return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`; } catch { return '<invalid>'; } })();
      process.stderr.write(`[url-validation] malformed allowedRemoteUrl in config "${safeUrl}": ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
}

/** Check if a URL is allowed (localhost on worker ports, or configured remote URLs). */
export function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

    // Local workers: localhost/loopback on allowed ports
    if (LOOPBACK_HOSTS.has(parsed.hostname)) {
      const port = parseInt(parsed.port || "80", 10);
      return allowedPorts.has(port);
    }

    // Remote workers: origin match against configured remoteWorkers
    return allowedRemoteOrigins.has(parsed.origin);
  } catch {
    return false;
  }
}
