/**
 * Shared utility functions for worker agents.
 *
 * Extracted from duplicated implementations across signal, monitor, climate,
 * infra, market, and news workers.
 */

/** Round a number to a fixed number of decimal places. */
export function round(n: number, decimals = 4): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/**
 * Haversine formula — great-circle distance in km between two lat/lon points.
 */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Block requests to private/internal network addresses (SSRF prevention).
 * Throws on localhost, loopback, RFC-1918 private, link-local, and 0.0.0.0/8.
 */
export function validateUrlNotInternal(urlStr: string): void {
  const parsed = new URL(urlStr);
  const hostname = parsed.hostname.toLowerCase();

  // Block localhost variants
  if (hostname === "localhost" || hostname === "[::1]" || hostname === "0.0.0.0") {
    throw new Error(`SSRF blocked: private/internal address "${hostname}"`);
  }

  // Block private/internal IP ranges
  const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipMatch) {
    const [, a, b] = ipMatch.map(Number);
    if (
      a === 127 ||                          // 127.x.x.x loopback
      a === 10 ||                            // 10.x.x.x private
      (a === 172 && b >= 16 && b <= 31) ||   // 172.16-31.x.x private
      (a === 192 && b === 168) ||            // 192.168.x.x private
      (a === 169 && b === 254) ||            // 169.254.x.x link-local / cloud metadata
      a === 0                                // 0.0.0.0/8
    ) {
      throw new Error(`SSRF blocked: private/internal address "${hostname}"`);
    }
  }
}
