/**
 * Command registry — add new commands by importing and registering them here.
 */

export interface Command {
  description: string;
  run: (args: string[], flags: Record<string, string | boolean>) => Promise<void>;
}

export const commands: Record<string, Command> = {
  // Commands will be generated based on the project spec
};
