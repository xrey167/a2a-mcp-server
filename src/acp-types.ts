// ACP (Agent Client Protocol) type definitions
// Spec: https://agentclientprotocol.com
// Wire format: JSON-RPC 2.0 over NDJSON stdin/stdout

// ── JSON-RPC 2.0 base types ─────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ── Initialization ───────────────────────────────────────────────

export interface InitializeParams {
  protocolVersion: string;
  clientInfo: { name: string; version: string };
  capabilities?: ClientCapabilities;
}

export interface ClientCapabilities {
  promptCapabilities?: {
    text?: boolean;
    image?: boolean;
    audio?: boolean;
  };
  fs?: boolean;
  terminal?: boolean;
}

export interface InitializeResult {
  protocolVersion: string;
  agentInfo: { name: string; version: string };
  capabilities: AgentCapabilities;
}

export interface AgentCapabilities {
  promptCapabilities: {
    text: boolean;
    image: boolean;
    audio: boolean;
  };
  sessionManagement: {
    load: boolean;
  };
  modes: AgentMode[];
  slashCommands?: SlashCommand[];
}

export interface AgentMode {
  id: string;
  name: string;
  description?: string;
}

export interface SlashCommand {
  name: string;
  description: string;
}

// ── Sessions ─────────────────────────────────────────────────────

export interface SessionNewParams {
  mode?: string;
  configuration?: Record<string, unknown>;
}

export interface SessionNewResult {
  sessionId: string;
  modes: AgentMode[];
}

export interface SessionLoadParams {
  sessionId: string;
}

export interface SessionLoadResult {
  sessionId: string;
  modes: AgentMode[];
}

export interface SessionPromptParams {
  sessionId: string;
  prompt: ContentBlock[];
  _meta?: Record<string, unknown>;
}

export interface SessionPromptResult {
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "cancelled";
}

// ── Content blocks ───────────────────────────────────────────────

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ResourceLinkContent {
  type: "resource_link";
  uri: string;
  name?: string;
  mimeType?: string;
}

export type ContentBlock = TextContent | ImageContent | ResourceLinkContent;

// ── Session updates (agent → client notifications) ───────────────

export interface SessionUpdateParams {
  sessionId: string;
  updates: SessionUpdate[];
}

export type SessionUpdate =
  | AssistantMessageUpdate
  | ToolCallUpdate
  | ToolCallStatusUpdate;

export interface AssistantMessageUpdate {
  kind: "assistant_message";
  content: ContentBlock[];
}

export interface ToolCallUpdate {
  kind: "tool_call";
  toolCallId: string;
  title: string;
  operationKind?: "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";
  status: "pending" | "in_progress" | "completed" | "failed";
  content?: ContentBlock[];
  locations?: FileLocation[];
}

export interface ToolCallStatusUpdate {
  kind: "tool_call_update";
  toolCallId: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
  content?: ContentBlock[];
}

export interface FileLocation {
  path: string;
  line?: number;
}

// ── Permission requests (agent → client) ─────────────────────────

export interface RequestPermissionParams {
  sessionId: string;
  permissions: Permission[];
}

export interface Permission {
  title: string;
  description?: string;
}

export interface RequestPermissionResult {
  outcome: "allow_once" | "allow_always" | "reject_once" | "reject_always" | "cancelled";
}

// ── File system (agent → client) ─────────────────────────────────

export interface FsReadTextFileParams {
  sessionId: string;
  path: string;
}

export interface FsReadTextFileResult {
  content: string;
}

export interface FsWriteTextFileParams {
  sessionId: string;
  path: string;
  content: string;
}

export interface FsWriteTextFileResult {
  success: boolean;
}

// ── Terminal (agent → client) ────────────────────────────────────

export interface TerminalCreateParams {
  sessionId: string;
  command: string;
  args?: string[];
  cwd?: string;
}

export interface TerminalCreateResult {
  terminalId: string;
}

export interface TerminalOutputParams {
  terminalId: string;
}

export interface TerminalOutputResult {
  output: string;
  isComplete: boolean;
}

// ── Authentication ───────────────────────────────────────────────

export interface AuthenticateParams {
  methods: AuthMethod[];
}

export interface AuthMethod {
  type: "api_key" | "oauth";
  description?: string;
}

export interface AuthenticateResult {
  method: string;
  credentials: Record<string, string>;
}
