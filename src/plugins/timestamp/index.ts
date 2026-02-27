import type { Skill } from "../../skills.js";

export const skills: Skill[] = [
  {
    id: "get_timestamp",
    name: "Get Timestamp",
    description: "Return current ISO timestamp and unix epoch",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const now = new Date();
      return JSON.stringify({ iso: now.toISOString(), epoch: Math.floor(now.getTime() / 1000) });
    },
  },
];
