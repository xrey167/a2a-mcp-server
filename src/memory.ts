import { Database } from "bun:sqlite";
import { join } from "path";
import { homedir } from "os";
import { writeFileSync, mkdirSync } from "fs";

const VAULT = process.env.OBSIDIAN_VAULT ?? join(homedir(), "Documents/Obsidian/a2a-knowledge");
const MEMORY_DIR = join(VAULT, "_memory");

const db = new Database(join(homedir(), ".a2a-memory.db"));
db.run(`CREATE TABLE IF NOT EXISTS memory (
  agent TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  ts INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (agent, key)
)`);

function noteFile(agent: string, key: string) {
  const dir = join(MEMORY_DIR, agent);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${key}.md`);
}

export const memory = {
  set(agent: string, key: string, value: string) {
    db.run(`INSERT OR REPLACE INTO memory VALUES (?,?,?,unixepoch())`, [agent, key, value]);
    try { writeFileSync(noteFile(agent, key), `# ${key}\n\n${value}\n`); } catch {}
  },
  get(agent: string, key: string): string | null {
    return (db.query<{value:string},[string,string]>(
      `SELECT value FROM memory WHERE agent=? AND key=?`
    ).get(agent, key))?.value ?? null;
  },
  all(agent: string): Record<string, string> {
    const rows = db.query<{key:string;value:string},[string]>(
      `SELECT key,value FROM memory WHERE agent=? ORDER BY ts DESC`
    ).all(agent);
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  },
  forget(agent: string, key: string) {
    db.run(`DELETE FROM memory WHERE agent=? AND key=?`, [agent, key]);
  },
};
