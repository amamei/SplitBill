// S1 + S6 smoke test against the live model of the active LLM_PROVIDER: Claude (needs Anthropic
// credentials: `ant auth login` or ANTHROPIC_API_KEY) or a local Ollama model (LLM_PROVIDER=ollama).
// Usage: npm -w server run smoke:s1
import { Session } from "../src/agent/session.js";
import { runTurn } from "../src/agent/runner.js";
import { CONTROL_EXAMPLE_TEXT } from "../src/domain/fixtures/control-example.js";
import { formatMinor } from "../src/domain/money.js";
import { config } from "../src/config.js";

process.env.LOG_LEVEL ??= "warn";
type Check = { check: string; ok: boolean; detail: string };
const checks: Check[] = [];
const expect = (check: string, ok: boolean, detail: string) => checks.push({ check, ok, detail });

const session = new Session("smoke-s1");
session.subscribe((event, data) => event === "error" && console.error("[smoke] error event", data));

function balances(): string[] {
  if (!session.billId) return [];
  return session.store.getSummary(session.billId).people.map((p) => `${p.name} ${formatMinor(p.balance, { sign: true })}`);
}

const s1 = await runTurn(session, CONTROL_EXAMPLE_TEXT);
expect("S1 turn finished without error", !s1.error, s1.error ?? `${s1.totalMs} ms`);
expect("S1 rendered the bill surface", session.surfaces.has("bill"), `surfaces: ${[...session.surfaces].join(", ") || "none"}`);
expect("S1 render valid within 3 repairs", s1.validationRepairs <= 3, `repairs: ${s1.validationRepairs}`);
const summary = session.billId ? session.store.getSummary(session.billId) : undefined;
expect(
  "S1 balances match TZ §6 (+385/+385/−405/−365)",
  JSON.stringify(balances()) === JSON.stringify(["Аня +385.00", "Боря +385.00", "Вика −405.00", "Гена −365.00"]),
  balances().join(", "),
);
expect("S1 settles in 3 transfers", summary?.transfers.length === 3, `transfers: ${summary?.transfers.length}`);

const s6 = await runTurn(session, "Гена тоже курил, одна доля");
expect("S6 turn finished without error", !s6.error, s6.error ?? `${s6.totalMs} ms`);
expect("S6 emitted updateDataModel ≥ 1", s6.messageCounts.updateDataModel >= 1, JSON.stringify(s6.messageCounts));
expect("S6 emitted no updateComponents (patch, not redraw)", s6.messageCounts.updateComponents === 0, JSON.stringify(s6.messageCounts));
expect(
  "S6 balances match TZ §6 (+465/+425/−365/−525)",
  JSON.stringify(balances()) === JSON.stringify(["Аня +465.00", "Боря +425.00", "Вика −365.00", "Гена −525.00"]),
  balances().join(", "),
);

console.info(`[smoke] provider: ${config.llm.provider}, model: ${config.model}`);
console.table(checks.map((c) => ({ result: c.ok ? "PASS" : "FAIL", check: c.check, detail: c.detail })));
console.info(JSON.stringify({ s1: s1, s6: s6 }, null, 1));
process.exit(checks.every((c) => c.ok) ? 0 : 1);
