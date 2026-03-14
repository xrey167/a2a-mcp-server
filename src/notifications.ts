// src/notifications.ts
// Outbound notification dispatcher — delivers alerts via Slack, Telegram, and Email.
// Subscribes to event bus topics and routes matching events to configured channels.

import { subscribe, type AgentEvent } from "./event-bus.js";
import Database from "bun:sqlite";
import { join, dirname } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";

// ── Types ────────────────────────────────────────────────────────

export interface SlackConfig {
  webhookUrl: string;
  /** Channel override (optional, uses webhook default) */
  channel?: string;
  /** Username override */
  username?: string;
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  /** Parse mode: "HTML" | "Markdown" | "MarkdownV2" */
  parseMode?: string;
}

export interface EmailConfig {
  /** SMTP server URL (e.g. "smtp://user:pass@smtp.example.com:587") */
  smtpUrl: string;
  from: string;
  to: string;
  /** Subject prefix */
  subjectPrefix?: string;
}

export interface NotificationChannels {
  slack?: SlackConfig;
  telegram?: TelegramConfig;
  email?: EmailConfig;
}

export interface NotificationLogEntry {
  id: number;
  timestamp: string;
  channel: string;
  topic: string;
  success: boolean;
  error?: string;
  eventId: string;
}

// ── Database ────────────────────────────────────────────────────

let db: Database | null = null;

function getDb(): Database {
  if (db) return db;
  const dbPath = join(process.env.HOME ?? homedir(), ".a2a-mcp", "notifications.db");
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  db = new Database(dbPath);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA synchronous=NORMAL");
  db.run(`
    CREATE TABLE IF NOT EXISTS notification_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      channel TEXT NOT NULL,
      topic TEXT NOT NULL,
      success INTEGER NOT NULL DEFAULT 1,
      error TEXT,
      event_id TEXT NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_notif_timestamp ON notification_log(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_notif_channel ON notification_log(channel)`);
  return db;
}

// ── State ────────────────────────────────────────────────────────

let channels: NotificationChannels = {};
const FETCH_TIMEOUT = 10_000;

// ── Public API ───────────────────────────────────────────────────

/** Configure notification channels. */
export function configureNotifications(config: NotificationChannels): void {
  channels = { ...config };
  const active = Object.keys(channels).filter(k => channels[k as keyof NotificationChannels]);
  process.stderr.write(`[notifications] configured channels: ${active.join(", ") || "none"}\n`);
}

/** Get current channel configuration (secrets redacted). */
export function getNotificationConfig(): Record<string, { enabled: boolean; configured: boolean }> {
  return {
    slack: { enabled: !!channels.slack, configured: !!channels.slack?.webhookUrl },
    telegram: { enabled: !!channels.telegram, configured: !!channels.telegram?.botToken },
    email: { enabled: !!channels.email, configured: !!channels.email?.smtpUrl },
  };
}

/** Send a notification to all configured channels. */
export async function notify(
  message: string,
  opts?: { title?: string; severity?: string; channels?: string[]; eventId?: string; topic?: string },
): Promise<{ sent: string[]; failed: string[] }> {
  const sent: string[] = [];
  const failed: string[] = [];
  const targetChannels = opts?.channels ?? Object.keys(channels);

  const promises: Promise<void>[] = [];

  if (targetChannels.includes("slack") && channels.slack) {
    promises.push(
      sendSlack(channels.slack, message, opts?.title, opts?.severity)
        .then(() => { sent.push("slack"); logNotification("slack", opts?.topic ?? "", true, opts?.eventId ?? ""); })
        .catch(err => { failed.push("slack"); logNotification("slack", opts?.topic ?? "", false, opts?.eventId ?? "", err.message); }),
    );
  }

  if (targetChannels.includes("telegram") && channels.telegram) {
    promises.push(
      sendTelegram(channels.telegram, message, opts?.title)
        .then(() => { sent.push("telegram"); logNotification("telegram", opts?.topic ?? "", true, opts?.eventId ?? ""); })
        .catch(err => { failed.push("telegram"); logNotification("telegram", opts?.topic ?? "", false, opts?.eventId ?? "", err.message); }),
    );
  }

  if (targetChannels.includes("email") && channels.email) {
    promises.push(
      sendEmail(channels.email, message, opts?.title, opts?.severity)
        .then(() => { sent.push("email"); logNotification("email", opts?.topic ?? "", true, opts?.eventId ?? ""); })
        .catch(err => { failed.push("email"); logNotification("email", opts?.topic ?? "", false, opts?.eventId ?? "", err.message); }),
    );
  }

  await Promise.allSettled(promises);
  return { sent, failed };
}

/** Subscribe to event bus topics and auto-notify on matching events. */
export function subscribeToAlerts(patterns: string[]): string[] {
  const subIds: string[] = [];

  for (const pattern of patterns) {
    const subId = subscribe(pattern, async (event: AgentEvent) => {
      const severity = extractSeverity(event);
      const title = extractTitle(event);
      const message = formatEventMessage(event);

      await notify(message, {
        title,
        severity,
        eventId: event.id,
        topic: event.topic,
      });
    }, { name: `notification-${pattern}` });

    subIds.push(subId);
    process.stderr.write(`[notifications] subscribed to: ${pattern}\n`);
  }

  return subIds;
}

/** Get notification history. */
export function getNotificationHistory(limit = 50): NotificationLogEntry[] {
  const d = getDb();
  return d.query<{
    id: number; timestamp: string; channel: string; topic: string;
    success: number; error: string | null; event_id: string;
  }, [number]>(
    `SELECT * FROM notification_log ORDER BY id DESC LIMIT ?`,
  ).all(limit).map(r => ({
    id: r.id,
    timestamp: r.timestamp,
    channel: r.channel,
    topic: r.topic,
    success: Boolean(r.success),
    error: r.error ?? undefined,
    eventId: r.event_id,
  }));
}

/** Get notification stats. */
export function getNotificationStats(): {
  totalSent: number;
  totalFailed: number;
  byChannel: Record<string, { sent: number; failed: number }>;
} {
  const d = getDb();
  const rows = d.query<{ channel: string; success: number; count: number }, []>(
    `SELECT channel, success, COUNT(*) as count FROM notification_log GROUP BY channel, success`,
  ).all();

  const byChannel: Record<string, { sent: number; failed: number }> = {};
  let totalSent = 0;
  let totalFailed = 0;

  for (const row of rows) {
    if (!byChannel[row.channel]) byChannel[row.channel] = { sent: 0, failed: 0 };
    if (row.success) {
      byChannel[row.channel].sent += row.count;
      totalSent += row.count;
    } else {
      byChannel[row.channel].failed += row.count;
      totalFailed += row.count;
    }
  }

  return { totalSent, totalFailed, byChannel };
}

/** Close database. */
export function closeNotificationsDb(): void {
  if (db) { db.close(); db = null; }
}

// ── Channel Adapters ─────────────────────────────────────────────

async function sendSlack(config: SlackConfig, message: string, title?: string, severity?: string): Promise<void> {
  const color = severity === "critical" ? "#FF0000" : severity === "high" ? "#FF8C00" : severity === "medium" ? "#FFD700" : "#36A64F";

  const payload = {
    ...(config.channel ? { channel: config.channel } : {}),
    ...(config.username ? { username: config.username } : {}),
    attachments: [{
      color,
      title: title ?? "A2A Alert",
      text: message,
      ts: Math.floor(Date.now() / 1000),
    }],
  };

  const res = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  if (!res.ok) throw new Error(`Slack webhook failed: HTTP ${res.status}`);
}

async function sendTelegram(config: TelegramConfig, message: string, title?: string): Promise<void> {
  const text = title ? `*${escapeMarkdown(title)}*\n\n${escapeMarkdown(message)}` : escapeMarkdown(message);

  const res = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: config.chatId,
      text,
      parse_mode: config.parseMode ?? "MarkdownV2",
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram API failed: HTTP ${res.status} ${body}`);
  }
}

async function sendEmail(config: EmailConfig, message: string, title?: string, severity?: string): Promise<void> {
  // Basic SMTP via fetch to a mail API endpoint.
  // For production, integrate with SendGrid/SES/Mailgun or use nodemailer.
  // This implementation supports HTTP-based mail APIs.
  const subject = `${config.subjectPrefix ?? "[A2A Alert]"} ${severity ? `[${severity.toUpperCase()}]` : ""} ${title ?? "Notification"}`;

  // Try environment-based mail API first
  const mailApiUrl = process.env.A2A_MAIL_API_URL;
  const mailApiKey = process.env.A2A_MAIL_API_KEY;

  if (mailApiUrl && mailApiKey) {
    const res = await fetch(mailApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${mailApiKey}`,
      },
      body: JSON.stringify({
        from: config.from,
        to: config.to,
        subject,
        text: message,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

    if (!res.ok) throw new Error(`Mail API failed: HTTP ${res.status}`);
    return;
  }

  process.stderr.write(`[notifications] email: no A2A_MAIL_API_URL configured, skipping. Subject: ${subject}\n`);
  throw new Error("Email not configured: set A2A_MAIL_API_URL and A2A_MAIL_API_KEY");
}

// ── Helpers ──────────────────────────────────────────────────────

function escapeMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function extractSeverity(event: AgentEvent): string {
  const data = event.data as Record<string, unknown> | undefined;
  if (data?.severity && typeof data.severity === "string") return data.severity;
  if (data?.threatLevel && typeof data.threatLevel === "string") return data.threatLevel;
  if (event.topic.includes("critical")) return "critical";
  if (event.topic.includes("high")) return "high";
  return "medium";
}

function extractTitle(event: AgentEvent): string {
  const data = event.data as Record<string, unknown> | undefined;
  if (data?.title && typeof data.title === "string") return data.title;
  if (data?.jobName && typeof data.jobName === "string") return `Scheduled: ${data.jobName}`;
  return event.topic.split(".").slice(-2).join(" ").replace(/_/g, " ");
}

function formatEventMessage(event: AgentEvent): string {
  const data = event.data as Record<string, unknown> | undefined;
  const parts: string[] = [];

  parts.push(`Topic: ${event.topic}`);
  parts.push(`Source: ${event.source}`);
  parts.push(`Time: ${event.timestamp}`);

  if (data) {
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        parts.push(`${key}: ${value}`);
      }
    }
  }

  return parts.join("\n");
}

function logNotification(channel: string, topic: string, success: boolean, eventId: string, error?: string): void {
  try {
    const d = getDb();
    d.run(
      `INSERT INTO notification_log (channel, topic, success, error, event_id) VALUES (?, ?, ?, ?, ?)`,
      [channel, topic, success ? 1 : 0, error ?? null, eventId],
    );
    // Prune old logs (keep last 5000)
    d.run(`DELETE FROM notification_log WHERE id NOT IN (SELECT id FROM notification_log ORDER BY id DESC LIMIT 5000)`);
  } catch (err) {
    process.stderr.write(`[notifications] failed to log: ${err}\n`);
  }
}
