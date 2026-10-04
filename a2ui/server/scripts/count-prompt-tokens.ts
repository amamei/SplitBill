// One-off: measure the system prompt in input tokens for the active LLM_PROVIDER.
// Claude: messages.countTokens (needs Anthropic credentials: `ant auth login` or ANTHROPIC_API_KEY).
// Ollama has no count_tokens endpoint, so a 1-token generation is sent and usage.input_tokens read.
// Usage: npm -w server run count:prompt
import { config } from "../src/config.js";
import { buildSystemPrompt, promptVersion } from "../src/agent/prompt.js";
import { createLlmClient } from "../src/agent/llm.js";

const client = createLlmClient(config.llm);
const system = buildSystemPrompt();
const messages = [{ role: "user" as const, content: "Привет" }];
let inputTokens: number;
let method: "countTokens" | "usage(max_tokens=1)";
if (config.llm.provider === "anthropic") {
  method = "countTokens";
  inputTokens = (await client.messages.countTokens({ model: config.model, system, messages })).input_tokens;
} else {
  method = "usage(max_tokens=1)";
  inputTokens = (await client.messages.create({ model: config.model, max_tokens: 1, system, messages })).usage.input_tokens;
}
console.info(JSON.stringify({ provider: config.llm.provider, model: config.model, method, promptVersion: promptVersion(), chars: system.length, inputTokens }));
