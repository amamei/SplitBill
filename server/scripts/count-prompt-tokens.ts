// One-off: measure the system prompt in input tokens for the active LLM_PROVIDER.
// Dahl (default): a 1-token generation is sent and usage.prompt_tokens read (needs DAHL_API_KEY in .env).
// Claude: messages.countTokens (needs Anthropic credentials: `ant auth login` or ANTHROPIC_API_KEY).
// Ollama has no count_tokens endpoint, so a 1-token generation is sent and usage.input_tokens read.
// Usage: npm -w server run count:prompt
import { config, dahlApiKey } from "../src/config.js";
import { buildSystemPrompt, promptVersion } from "../src/agent/prompt.js";
import { createLlmClient } from "../src/agent/llm.js";

const llm = config.llm;
const system = buildSystemPrompt();
const messages = [{ role: "user" as const, content: "Привет" }];
let inputTokens: number;
let method: "countTokens" | "usage(max_tokens=1)";
if (llm.provider === "dahl") {
  const key = dahlApiKey();
  if (!key) {
    console.error("DAHL_API_KEY не задан: добавьте ключ в .env");
    process.exit(1);
  }
  method = "usage(max_tokens=1)";
  const res = await fetch(`${llm.baseURL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: llm.model, max_tokens: 1, stream: false, messages: [{ role: "system", content: system }, ...messages] }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await res.json().catch(() => ({}))) as { usage?: { prompt_tokens?: number } };
  if (!res.ok || typeof body.usage?.prompt_tokens !== "number") {
    console.error(`Dahl ответил ${res.status} без usage.prompt_tokens: ${JSON.stringify(body).slice(0, 300)}`);
    process.exit(1);
  }
  inputTokens = body.usage.prompt_tokens;
} else if (llm.provider === "anthropic") {
  method = "countTokens";
  inputTokens = (await createLlmClient(llm).messages.countTokens({ model: llm.model, system, messages })).input_tokens;
} else {
  method = "usage(max_tokens=1)";
  inputTokens = (await createLlmClient(llm).messages.create({ model: llm.model, max_tokens: 1, system, messages })).usage.input_tokens;
}
console.info(JSON.stringify({ provider: llm.provider, model: llm.model, method, promptVersion: promptVersion(), chars: system.length, inputTokens }));
