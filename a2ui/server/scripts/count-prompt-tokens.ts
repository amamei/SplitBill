// One-off: measure the system prompt with messages.countTokens (needs Anthropic credentials:
// `ant auth login` or ANTHROPIC_API_KEY). Usage: npm -w server run count:prompt
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../src/config.js";
import { buildSystemPrompt, promptVersion } from "../src/agent/prompt.js";

const client = new Anthropic();
const system = buildSystemPrompt();
const result = await client.messages.countTokens({
  model: config.model,
  system,
  messages: [{ role: "user", content: "Привет" }],
});
console.info(JSON.stringify({ model: config.model, promptVersion: promptVersion(), chars: system.length, inputTokens: result.input_tokens }));
