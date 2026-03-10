// src/url-validation.ts
// SSRF prevention — validates URLs against allowed ports and remote URLs.

let allowedPorts = new Set<number>();
let allowedRemoteUrls = new Set<string>();

/** Configure the allowed ports and remote URLs (called during server startup). */
export function configureAllowedUrls(ports: number[], remoteUrls: string[]): void {
  allowedPorts = new Set(ports);
  allowedRemoteUrls = new Set(remoteUrls);
}

/** Check if a URL is allowed (localhost on worker ports, or configured remote URLs). */
export function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

    // Local workers: localhost on allowed ports
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      const port = parseInt(parsed.port || "80", 10);
      return allowedPorts.has(port);
    }

    // Remote workers: exact URL match against configured remoteWorkers
    const origin = parsed.origin;
    for (const allowed of allowedRemoteUrls) {
      try {
        if (new URL(allowed).origin === origin) return true;
      } catch {}
    }

    return false;
  } catch {
    return false;
  }
}
