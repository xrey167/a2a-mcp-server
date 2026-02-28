// A2A protocol types aligned with google-a2a/a2a-js (Apache 2.0 subset)

export interface TextPart {
  kind: "text";
  text: string;
  metadata?: Record<string, unknown>;
}

export type Part = TextPart;

export interface Message {
  role: "user" | "agent";
  parts: Part[];
}

export type TaskState =
  | "submitted"
  | "working"
  | "completed"
  | "canceled"
  | "failed"
  | "input-required"
  | "unknown";

export interface TaskStatus {
  state: TaskState;
  message?: Message;
}

export interface Artifact {
  parts: Part[];
  artifactId?: string;
  name?: string;
}

export interface Task {
  id: string;
  status: TaskStatus;
  artifacts?: Artifact[];
  contextId?: string; // maps to our sessionId
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
}

export interface AgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: { streaming: boolean };
  skills: AgentSkill[];
}
