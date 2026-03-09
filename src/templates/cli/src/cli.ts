#!/usr/bin/env bun
/**
 * {{name}} — {{description}}
 *
 * Usage:
 *   bun src/cli.ts <command> [options]
 *   bun src/cli.ts --help
 */

import { parseArgs } from "./args.js";
import { commands } from "./commands/index.js";

const { command, args, flags } = parseArgs(process.argv.slice(2));

if (flags.help || !command) {
  console.log(`
{{name}} — {{description}}

Usage:
  {{name}} <command> [options]

Commands:
${Object.entries(commands)
  .map(([name, cmd]) => `  ${name.padEnd(16)} ${cmd.description}`)
  .join("\n")}

Options:
  --help           Show this help message
  --version        Show version number
  --verbose, -v    Enable verbose output
  --json           Output as JSON
`);
  process.exit(0);
}

if (flags.version) {
  console.log("0.1.0");
  process.exit(0);
}

const handler = commands[command];
if (!handler) {
  console.error(`Unknown command: ${command}`);
  console.error(`Run '{{name}} --help' for available commands`);
  process.exit(1);
}

try {
  await handler.run(args, flags);
} catch (err) {
  if (flags.verbose) {
    console.error(err);
  } else {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
}
