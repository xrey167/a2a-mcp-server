/**
 * {{name}} — AI agent with tool-calling capabilities.
 *
 * Uses Claude's tool_use to autonomously select and invoke tools
 * in a loop until the task is complete.
 */

import Anthropic from "@anthropic-ai/sdk";
import { tools, toolMap } from "./tools/index.js";

const client = new Anthropic();

const SYSTEM_PROMPT = `You are {{name}}, a helpful AI agent.
{{description}}

You have access to tools. Use them when they would help answer the user's question.
Be concise and accurate. If a tool fails, explain the error and try an alternative approach.`;

const MAX_TURNS = 10;

export async function runAgent(userMessage: string): Promise<string> {
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: tools.map((t) => t.spec),
      messages,
    });

    // Collect text parts for final output
    const textParts: string[] = [];
    const toolUseBlocks: Anthropic.Messages.ToolUseBlock[] = [];

    for (const block of response.content) {
      if (block.type === "text") textParts.push(block.text);
      if (block.type === "tool_use") toolUseBlocks.push(block);
    }

    // If no tool calls, we're done
    if (toolUseBlocks.length === 0) {
      return textParts.join("\n");
    }

    // Add assistant message with all content blocks
    messages.push({ role: "assistant", content: response.content });

    // Execute each tool and collect results
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const toolUse of toolUseBlocks) {
      const tool = toolMap.get(toolUse.name);
      if (!tool) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Error: Unknown tool "${toolUse.name}"`,
          is_error: true,
        });
        continue;
      }

      try {
        const result = await tool.execute(toolUse.input as Record<string, unknown>);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result,
        });
      } catch (err) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });

    // If the model signaled stop, return what we have
    if (response.stop_reason === "end_turn") {
      return textParts.join("\n");
    }
  }

  return "Agent reached maximum turns without completing the task.";
}

// CLI mode: run directly with `bun src/agent.ts "your question"`
if (import.meta.main) {
  const question = process.argv[2];
  if (!question) {
    process.stderr.write("Usage: bun src/agent.ts \"your question\"\n");
    process.exit(1);
  }
  const answer = await runAgent(question);
  process.stdout.write(answer + "\n");
}
