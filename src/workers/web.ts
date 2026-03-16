import Fastify from "fastify";
import { z } from "zod";
import { lookup } from "node:dns/promises";
import { handleMemorySkill } from "../worker-memory.js";
import { getPersona, watchPersonas } from "../persona-loader.js";
import { buildA2AResponse, checkRequestSize } from "../worker-harness.js";
import { safeStringify } from "../safe-json.js";
import { callPeer } from "../peer.js";
import { sanitizeUserInput } from "../prompt-sanitizer.js";

const WebSchemas = {
  fetch_url: z.looseObject({ url: z.url(), format: z.enum(["text", "json"]).optional().default("text") }),
  call_api: z.looseObject({ url: z.url(), method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional().default("GET"), headers: z.record(z.string(), z.string()).optional().default({}), body: z.unknown().optional() }),
  scrape_page: z.looseObject({
    /** URL to fetch and scrape */
    url: z.string().url(),
    /** Max links to extract from the page (default 20) */
    maxLinks: z.number().int().positive().optional().default(20),
    /** Heuristically extract only the main content area (article/main), stripping nav/header/footer (default true) */
    mainOnly: z.boolean().optional().default(true),
  }),
  search_web: z.looseObject({
    /** Search query string */
    query: z.string().min(1).refine(s => s.trim().length > 0, "query must not be blank"),
    /** Maximum number of results to return (default 10, max 20) */
    maxResults: z.number().int().min(1).max(20).optional().default(10),
  }),
  summarize_url: z.looseObject({
    /** URL to fetch, scrape, and summarize */
    url: z.string().url(),
    /** Optional question to steer the AI summary (e.g. "What are the key risks?") */
    question: z.string().optional(),
  }),
  check_url: z.looseObject({
    /** URL to check */
    url: z.string().url(),
    /** Follow redirects and return the chain (default true) */
    followRedirects: z.boolean().optional().default(true),
    /** Timeout in ms (default 10000, max 30000) */
    timeoutMs: z.number().int().min(500).max(30_000).optional().default(10_000),
  }),
};

/** Max words sent to the AI to avoid context overflow (~6000 words ≈ ~8000 tokens). */
const SUMMARIZE_MAX_WORDS = 6000;

/** Block RFC-1918, loopback, APIPA, and cloud-metadata hostnames at the hostname level. */
function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "localhost" ||
    h === "0.0.0.0" ||
    /^0\./.test(h) ||              // 0.0.0.0/8
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||  // APIPA + AWS/GCP metadata
    h === "::1" ||
    /^fc[0-9a-f]{2}:/i.test(h) || // fc00::/7 IPv6 ULA
    /^fd[0-9a-f]{2}:/i.test(h) || // fd00::/8 IPv6 ULA
    /^fe80:/i.test(h)              // link-local IPv6
  );
}

async function blockPrivateUrl(url: string): Promise<string | null> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return `Blocked: only http and https protocols are allowed (got ${parsed.protocol})`;
    }
    if (isPrivateHostname(parsed.hostname)) {
      return `Blocked: private/internal URLs are not allowed (${parsed.hostname})`;
    }
    // DNS pre-resolution: resolve all IPs to close the TOCTOU window between
    // hostname validation and fetch(). Fail-closed: DNS errors block the request.
    let addresses: { address: string }[];
    try {
      addresses = await lookup(parsed.hostname, { all: true });
    } catch {
      return `Blocked: DNS resolution failed for ${parsed.hostname}`;
    }
    for (const { address } of addresses) {
      if (isPrivateHostname(address)) {
        return `Blocked: ${parsed.hostname} resolves to private/internal address (${address})`;
      }
    }
    return null;
  } catch {
    return "Blocked: invalid URL";
  }
}

const PORT = 8082;
const NAME = "web-agent";

// Configurable timeouts (env vars set by orchestrator, or sensible defaults)
const FETCH_TIMEOUT_MS = parseInt(process.env.A2A_FETCH_TIMEOUT ?? "30000", 10);
const MAX_RESPONSE_BYTES = parseInt(process.env.A2A_MAX_RESPONSE_BYTES ?? String(10 * 1024 * 1024), 10); // 10MB
const RATE_LIMIT_RPM = parseInt(process.env.A2A_WEB_RATE_LIMIT ?? "0", 10); // 0 = unlimited

// Simple token-bucket rate limiter (per-minute)
const rateBucket = { tokens: RATE_LIMIT_RPM, lastRefill: Date.now() };
function checkRateLimit(): boolean {
  if (RATE_LIMIT_RPM <= 0) return true; // unlimited
  const now = Date.now();
  const elapsed = now - rateBucket.lastRefill;
  if (elapsed >= 60_000) {
    rateBucket.tokens = RATE_LIMIT_RPM;
    rateBucket.lastRefill = now;
  }
  if (rateBucket.tokens <= 0) return false;
  rateBucket.tokens--;
  return true;
}

/** Read response body with a hard byte limit. Returns null if limit exceeded. */
async function readBodyWithLimit(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let chunks: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        reader.cancel();
        return null;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    // Flush decoder
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

// ── HTML Scraper ─────────────────────────────────────────────────

/**
 * Strip HTML to clean readable text. No external deps — regex-based.
 * Steps:
 *   1. Extract title and meta description
 *   2. Isolate main content region (article/main/role=main/body) when mainOnly=true
 *   3. Remove whole noise blocks: script, style, nav, header, footer, aside, noscript
 *   4. Convert block-level closing tags to newlines for readability
 *   5. Decode basic HTML entities
 *   6. Strip remaining tags
 *   7. Collapse whitespace to max 2 consecutive blank lines
 *   8. Extract hrefs from anchor tags
 */
function scrapeHtml(html: string, mainOnly: boolean, maxLinks: number): {
  title: string;
  description: string;
  text: string;
  wordCount: number;
  links: Array<{ text: string; href: string }>;
} {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = decodeEntities(titleMatch?.[1] ?? "").trim();

  // Extract meta description
  const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  const description = decodeEntities(metaMatch?.[1] ?? "").trim();

  // Extract links from the full HTML before any stripping
  const links: Array<{ text: string; href: string }> = [];
  const linkRe = /<a[^>]+href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let lm: RegExpExecArray | null;
  while ((lm = linkRe.exec(html)) !== null && links.length < maxLinks) {
    const href = lm[1].trim();
    const linkText = decodeEntities(lm[2].replace(/<[^>]+>/g, "").trim());
    if (href && linkText) links.push({ text: linkText.slice(0, 100), href });
  }

  // Isolate main content region when mainOnly=true
  let content = html;
  if (mainOnly) {
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
      ?? html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
      ?? html.match(/<[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/[^>]+>/i)
      ?? html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (mainMatch) content = mainMatch[1];
  }

  // Remove whole noise blocks
  content = content.replace(/<(script|style|nav|header|footer|aside|noscript)(\s[^>]*)?>[\s\S]*?<\/\1>/gi, " ");

  // Block-level elements become newlines for paragraph structure
  content = content.replace(/<\/(p|div|li|h[1-6]|section|blockquote|tr|td|th)>/gi, "\n");
  content = content.replace(/<br\s*\/?>/gi, "\n");

  // Decode entities, strip remaining tags
  content = decodeEntities(content);
  content = content.replace(/<[^>]+>/g, "");

  // Normalize whitespace — collapse blank lines to max 2
  content = content
    .split("\n")
    .map(l => l.replace(/\t/g, " ").replace(/ {2,}/g, " ").trim())
    .filter((l, i, arr) => l !== "" || (arr[i - 1] !== "" && arr[i - 2] !== ""))
    .join("\n")
    .trim();

  const wordCount = content.split(/\s+/).filter(Boolean).length;
  return { title, description, text: content, wordCount, links };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

const AGENT_CARD = {
  name: NAME,
  description: "Web/HTTP agent — fetch URLs, scrape pages, call APIs, persistent memory",
  url: `http://localhost:${PORT}`,
  version: "1.0.0",
  capabilities: { streaming: false },
  skills: [
    { id: "fetch_url", name: "Fetch URL", description: "Fetch raw content from a URL (text or JSON)" },
    { id: "call_api", name: "Call API", description: "Make an HTTP request to an external API" },
    { id: "scrape_page", name: "Scrape Page", description: "Fetch a web page and extract clean readable text, title, description, and links. Strips HTML, scripts, nav, and boilerplate. Output ready for ask_claude." },
    { id: "search_web", name: "Search Web", description: "Search the web using DuckDuckGo and return structured results (title, url, snippet) for a query. No API key required." },
    { id: "summarize_url", name: "Summarize URL", description: "Fetch a web page, scrape its text, and return an AI-written summary. Pass an optional question to focus the summary on a specific aspect." },
    { id: "check_url", name: "Check URL", description: "Check if a URL is reachable using a HEAD request. Returns status code, response time (ms), content-type, and redirect chain. Useful for link validation and health checks. Does not download the response body." },
    { id: "remember", name: "Remember", description: "Store a key-value pair in persistent memory" },
    { id: "recall", name: "Recall", description: "Retrieve a value from persistent memory (or all memories)" },
  ],
};

async function handleSkill(skillId: string, args: Record<string, unknown>, text: string): Promise<string> {
  const memResult = handleMemorySkill(NAME, skillId, args);
  if (memResult !== null) return memResult;
  if (!checkRateLimit()) return "Rate limit exceeded — try again in a moment";
  switch (skillId) {
    case "fetch_url": {
      const { url, format } = WebSchemas.fetch_url.parse({ url: args.url ?? text, ...args });
      const block = await blockPrivateUrl(url);
      if (block) return block;
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return `HTTP ${res.status}: ${res.statusText}`;
      // Early reject if content-length header is set and exceeds limit
      const contentLength = parseInt(res.headers.get("content-length") ?? "0", 10);
      if (contentLength > MAX_RESPONSE_BYTES) return `Response too large: ${contentLength} bytes (max ${MAX_RESPONSE_BYTES})`;
      // Stream body with byte limit to guard against missing/spoofed content-length
      const body = await readBodyWithLimit(res, MAX_RESPONSE_BYTES);
      if (body === null) return `Response too large: exceeded ${MAX_RESPONSE_BYTES} byte limit during streaming`;
      return format === "json"
        ? safeStringify(JSON.parse(body), 2)
        : body;
    }
    case "call_api": {
      const { url, method, headers, body } = WebSchemas.call_api.parse({ url: args.url ?? text, ...args });
      const blockMsg = await blockPrivateUrl(url);
      if (blockMsg) return blockMsg;
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        body: body ? safeStringify(body) : undefined,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const responseBody = await readBodyWithLimit(res, MAX_RESPONSE_BYTES);
      if (responseBody === null) return `HTTP ${res.status}\nResponse too large: exceeded ${MAX_RESPONSE_BYTES} byte limit`;
      return `HTTP ${res.status}\n${responseBody}`;
    }
    case "scrape_page": {
      const { url, maxLinks, mainOnly } = WebSchemas.scrape_page.parse({ url: args.url ?? text, ...args });
      const block = await blockPrivateUrl(url);
      if (block) return block;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "Accept": "text/html,application/xhtml+xml", "User-Agent": "Mozilla/5.0 (compatible; A2A-Web-Agent/1.0)" },
      });
      if (!res.ok) return `HTTP ${res.status}: ${res.statusText}`;
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("text/html") && !ct.includes("application/xhtml")) {
        return `scrape_page expects HTML content (got ${ct}); use fetch_url for other content types`;
      }
      const contentLength = parseInt(res.headers.get("content-length") ?? "0", 10);
      if (contentLength > MAX_RESPONSE_BYTES) return `Response too large: ${contentLength} bytes (max ${MAX_RESPONSE_BYTES})`;
      const html = await readBodyWithLimit(res, MAX_RESPONSE_BYTES);
      if (html === null) return `Response too large: exceeded ${MAX_RESPONSE_BYTES} byte limit during streaming`;
      const scraped = scrapeHtml(html, mainOnly, maxLinks);
      return safeStringify({ url, ...scraped }, 2);
    }
    case "search_web": {
      const { query, maxResults } = WebSchemas.search_web.parse({ query: args.query ?? text, ...args });
      const trimmedQuery = query.trim();
      const encodedQuery = encodeURIComponent(trimmedQuery);
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;
      const ssrfBlock = await blockPrivateUrl(searchUrl);
      if (ssrfBlock) return ssrfBlock;
      const res = await fetch(searchUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          "Accept": "text/html,application/xhtml+xml",
          "User-Agent": "Mozilla/5.0 (compatible; A2A-Web-Agent/1.0)",
        },
      });
      if (!res.ok) return `HTTP ${res.status}: ${res.statusText}`;
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("text/html") && !ct.includes("application/xhtml")) {
        process.stderr.write(`[${NAME}] search_web: unexpected content-type from DuckDuckGo: "${ct}" for query="${trimmedQuery}"\n`);
        return `search_web: DuckDuckGo returned unexpected content type (${ct}); this may indicate rate limiting`;
      }
      const contentLength = parseInt(res.headers.get("content-length") ?? "0", 10);
      if (contentLength > MAX_RESPONSE_BYTES) return `Response too large: ${contentLength} bytes (max ${MAX_RESPONSE_BYTES})`;
      const html = await readBodyWithLimit(res, MAX_RESPONSE_BYTES);
      if (html === null) return `Response too large: exceeded ${MAX_RESPONSE_BYTES} byte limit during streaming`;

      const results: Array<{ title: string; url: string; snippet: string }> = [];
      const resultBlockRe = /<div[^>]+class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
      for (const m of html.matchAll(resultBlockRe)) {
        if (results.length >= maxResults) break;
        const chunk = m[1] ?? "";
        const titleMatch = chunk.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
        const snippetMatch = chunk.match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
          ?? chunk.match(/<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        if (!titleMatch || !titleMatch[1] || !titleMatch[2]) continue;
        const rawUrl = decodeEntities(titleMatch[1].trim());
        const title = decodeEntities(titleMatch[2].replace(/<[^>]+>/g, "").trim());
        const snippet = snippetMatch && snippetMatch[1]
          ? decodeEntities(snippetMatch[1].replace(/<[^>]+>/g, "").trim())
          : "";
        let url = rawUrl;
        try {
          const parsed = new URL(rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl);
          const uddg = parsed.searchParams.get("uddg");
          if (uddg) url = uddg;
        } catch (parseErr) {
          process.stderr.write(`[${NAME}] search_web: URL parse failed for "${rawUrl.slice(0, 100)}", keeping raw href (${String(parseErr)})\n`);
        }
        const resultSsrf = await blockPrivateUrl(url);
        if (resultSsrf) continue;
        if (url && title) results.push({ title, url, snippet });
      }

      if (results.length === 0) {
        const likelyParserFailure = !html.includes("result__a");
        if (likelyParserFailure) {
          process.stderr.write(`[${NAME}] search_web: HTML parser appears broken — "result__a" not found in ${html.length}-byte response for query="${trimmedQuery}"; DuckDuckGo HTML structure may have changed\n`);
          return safeStringify({ query: trimmedQuery, results: [], resultCount: 0, note: "HTML parser may be broken — DuckDuckGo page structure may have changed" }, 2);
        }
        process.stderr.write(`[${NAME}] search_web: no results from DuckDuckGo for query="${trimmedQuery}"\n`);
        return safeStringify({ query: trimmedQuery, results: [], resultCount: 0, note: "No results found" }, 2);
      }

      return safeStringify({ query: trimmedQuery, results: results.slice(0, maxResults), resultCount: results.length }, 2);
    }

    case "summarize_url": {
      const { url, question } = WebSchemas.summarize_url.parse({ url: args.url ?? text, ...args });
      const block = await blockPrivateUrl(url);
      if (block) return block;
      let res: Response;
      try {
        res = await fetch(url, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { "Accept": "text/html,application/xhtml+xml", "User-Agent": "Mozilla/5.0 (compatible; A2A-Web-Agent/1.0)" },
        });
      } catch (err) {
        process.stderr.write(`[${NAME}] summarize_url: fetch failed for ${url}: ${err}\n`);
        return `summarize_url: could not fetch ${url} — ${err instanceof Error ? err.message : String(err)}`;
      }
      if (!res.ok) return `HTTP ${res.status}: ${res.statusText}`;
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("text/html") && !ct.includes("application/xhtml")) {
        return `summarize_url expects HTML content (got ${ct}); use fetch_url for other content types`;
      }
      const contentLength = parseInt(res.headers.get("content-length") ?? "0", 10);
      if (contentLength > MAX_RESPONSE_BYTES) return `Response too large: ${contentLength} bytes (max ${MAX_RESPONSE_BYTES})`;
      const html = await readBodyWithLimit(res, MAX_RESPONSE_BYTES);
      if (html === null) return `Response too large: exceeded ${MAX_RESPONSE_BYTES} byte limit during streaming`;
      const scraped = scrapeHtml(html, true, 0);

      if (scraped.wordCount === 0) {
        process.stderr.write(`[${NAME}] summarize_url: scrapeHtml returned empty text for ${url}\n`);
        return `summarize_url: no readable text found at ${url} — the page may be JavaScript-rendered or require authentication. Try scrape_page to inspect the raw content.`;
      }

      const words = scraped.text.split(/\s+/);
      const truncated = words.length > SUMMARIZE_MAX_WORDS
        ? words.slice(0, SUMMARIZE_MAX_WORDS).join(" ") + "\n\n[…content truncated…]"
        : scraped.text;

      const questionLine = question
        ? `Focus question: ${sanitizeUserInput(question, "question")}\n\n`
        : "";
      const prompt = `You are a research assistant. Summarize the following web page concisely and accurately.\n\nURL: ${sanitizeUserInput(url, "url")}\nTitle: ${sanitizeUserInput(scraped.title, "title")}\n\n${questionLine}Page content:\n${sanitizeUserInput(truncated, "page_content")}`;

      let summary: string;
      try {
        summary = await callPeer("ask_claude", { prompt }, prompt, 60_000);
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[${NAME}] summarize_url: callPeer ask_claude failed: ${cause}\n`);
        return `summarize_url: AI summary unavailable — the AI worker could not be reached (${cause}). Try again in a moment or use scrape_page to get the raw text.`;
      }

      return safeStringify({ url, title: scraped.title, wordCount: scraped.wordCount, summary }, 2);
    }
    case "check_url": {
      let parsed: ReturnType<typeof WebSchemas.check_url.parse>;
      try {
        parsed = WebSchemas.check_url.parse({ url: args.url ?? text, ...args });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[${NAME}] check_url: Zod parse error: ${msg}\n`);
        return `check_url: invalid arguments — ${msg}`;
      }
      const { url, followRedirects, timeoutMs } = parsed;

      // SSRF guard — same protection as all other URL-fetching skills
      const blockReason = await blockPrivateUrl(url);
      if (blockReason) {
        process.stderr.write(`[${NAME}] check_url: SSRF blocked: ${url} — ${blockReason}\n`);
        return `check_url: ${blockReason}`;
      }

      const redirectChain: Array<{ url: string; status: number }> = [];
      let currentUrl = url;
      const startMs = Date.now();
      const MAX_REDIRECTS = 10;

      try {
        // Follow redirects manually to capture the chain
        while (true) {
          // Consume one rate limit token per HTTP request — redirect chains count individually
          if (!checkRateLimit()) {
            process.stderr.write(`[${NAME}] check_url: rate limit hit for ${currentUrl}\n`);
            return safeStringify({ url, reachable: false, error: "rate limit exceeded — try again in a minute", responseTimeMs: Date.now() - startMs, redirectChain }, 2);
          }

          const controller = new AbortController();
          let timer: ReturnType<typeof setTimeout> | undefined;

          let res: Response;
          try {
            timer = setTimeout(() => controller.abort(), timeoutMs);
            res = await fetch(currentUrl, {
              method: "HEAD",
              redirect: "manual",  // handle redirects ourselves to track the chain
              signal: controller.signal,
              headers: { "User-Agent": "Mozilla/5.0 (compatible; a2a-mcp-bridge/1.0)" },
            });
          } catch (fetchErr) {
            const isAbort = fetchErr instanceof Error && fetchErr.name === "AbortError";
            const cause = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
            if (isAbort) {
              process.stderr.write(`[${NAME}] check_url: HEAD timed out after ${timeoutMs}ms for ${currentUrl}\n`);
              return safeStringify({ url, reachable: false, error: `timed out after ${timeoutMs}ms`, responseTimeMs: Date.now() - startMs, redirectChain }, 2);
            }
            process.stderr.write(`[${NAME}] check_url: network error for ${currentUrl}: ${cause}\n`);
            return safeStringify({ url, reachable: false, error: cause, responseTimeMs: Date.now() - startMs, redirectChain }, 2);
          } finally {
            clearTimeout(timer);  // always runs — prevents timer leak even on early return
          }

          const status = res.status;
          const isRedirect = status >= 300 && status < 400;

          if (isRedirect && followRedirects) {
            const location = res.headers.get("location");
            redirectChain.push({ url: currentUrl, status });

            if (!location) {
              // Redirect with no Location header — can't follow
              process.stderr.write(`[${NAME}] check_url: redirect ${status} with no Location header at ${currentUrl}\n`);
              return safeStringify({
                url,
                finalUrl: currentUrl,
                reachable: false,
                statusCode: status,
                error: `redirect ${status} returned no Location header`,
                responseTimeMs: Date.now() - startMs,
                redirectChain,
              }, 2);
            }

            if (redirectChain.length >= MAX_REDIRECTS) {
              process.stderr.write(`[${NAME}] check_url: redirect loop or excessive redirects (>${MAX_REDIRECTS}) for ${url}\n`);
              return safeStringify({
                url,
                finalUrl: currentUrl,
                reachable: false,
                statusCode: status,
                error: `too many redirects (>${MAX_REDIRECTS})`,
                responseTimeMs: Date.now() - startMs,
                redirectChain,
              }, 2);
            }

            // Resolve relative redirect URLs
            let nextUrl: string;
            try {
              nextUrl = new URL(location, currentUrl).href;
            } catch {
              process.stderr.write(`[${NAME}] check_url: malformed Location header "${location}" at ${currentUrl}\n`);
              return safeStringify({
                url,
                finalUrl: currentUrl,
                reachable: false,
                statusCode: status,
                error: `malformed Location header: ${location}`,
                responseTimeMs: Date.now() - startMs,
                redirectChain,
              }, 2);
            }

            // SSRF guard on redirect target
            const redirectBlock = await blockPrivateUrl(nextUrl);
            if (redirectBlock) {
              process.stderr.write(`[${NAME}] check_url: SSRF blocked redirect target: ${nextUrl} — ${redirectBlock}\n`);
              return safeStringify({
                url,
                finalUrl: currentUrl,
                reachable: false,
                error: `redirect target blocked: ${redirectBlock}`,
                responseTimeMs: Date.now() - startMs,
                redirectChain,
              }, 2);
            }

            currentUrl = nextUrl;
            continue;
          }

          // Final response (non-redirect, or followRedirects=false)
          const contentType = res.headers.get("content-type") ?? undefined;
          const responseTimeMs = Date.now() - startMs;
          const reachable = status < 400;

          if (!reachable) {
            process.stderr.write(`[${NAME}] check_url: ${url} returned ${status} (finalUrl=${currentUrl})\n`);
          }

          return safeStringify({
            url,
            finalUrl: currentUrl !== url ? currentUrl : undefined,
            reachable,
            statusCode: status,
            contentType,
            responseTimeMs,
            redirectCount: redirectChain.length > 0 ? redirectChain.length : undefined,
            redirectChain: redirectChain.length > 0 ? redirectChain : undefined,
          }, 2);
        }
      } catch (err) {
        // Unexpected error outside the fetch loop
        const cause = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[${NAME}] check_url: unexpected error for ${url}: ${cause}\n`);
        try {
          return safeStringify({ url, reachable: false, error: cause, responseTimeMs: Date.now() - startMs, redirectChain }, 2);
        } catch {
          return `check_url: unexpected error — ${cause}`;
        }
      }
    }
    default:
      return `Unknown skill: ${skillId}`;
  }
}

const app = Fastify({ logger: false });

app.get("/.well-known/agent.json", async () => AGENT_CARD);

app.get("/healthz", async () => ({
  status: "ok",
  agent: NAME,
  uptime: process.uptime(),
  skills: AGENT_CARD.skills.map(s => s.id),
}));

app.post<{ Body: Record<string, any> }>("/", async (request, reply) => {
  const data = request.body;
  if (data?.method !== "tasks/send") {
    reply.code(404);
    return { jsonrpc: "2.0", error: { code: -32601, message: "Method not found" } };
  }

  const sizeErr = checkRequestSize(data);
  if (sizeErr) { reply.code(413); return { jsonrpc: "2.0", error: { code: -32000, message: sizeErr } }; }

  const { skillId, args, message, id: taskId } = data.params ?? {};
  const text: string = message?.parts?.[0]?.text ?? "";
  const sid = skillId ?? "fetch_url";
  let resultText: string;
  try {
    resultText = await handleSkill(sid, args ?? { url: text }, text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[${NAME}] unhandled error in skill "${sid}": ${msg}\n`);
    resultText = `Error: ${msg}`;
  }

  return buildA2AResponse(data.id, taskId, resultText);
});

getPersona(NAME);
watchPersonas();

app.listen({ port: PORT, host: "localhost" }).then(() => {
  process.stderr.write(`[${NAME}] listening on http://localhost:${PORT}\n`);
});
