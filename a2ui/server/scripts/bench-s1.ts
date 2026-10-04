// Repeats a scenario in fresh sessions against the live model and records TZ §7 numbers
// ("Надёжность", "Скорость и токены"). Usage:
//   npm -w server run bench:s1 -- --runs 10            (S1: bill from text)
//   npm -w server run bench:s1 -- --runs 5 --scenario s5 (S5: "покажи итог" after S1)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Session } from "../src/agent/session.js";
import { runTurn } from "../src/agent/runner.js";
import { validateComponents } from "../src/a2ui/validate.js";
import type { A2uiEnvelope } from "../src/a2ui/envelopes.js";
import { CONTROL_EXAMPLE_TEXT } from "../src/domain/fixtures/control-example.js";
import { config } from "../src/config.js";

process.env.LOG_LEVEL ??= "warn";
const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const runs = Number(arg("runs", "10"));
const scenario = arg("scenario", "s1") as "s1" | "s5";

interface RunResult {
  run: number;
  ok: boolean;
  validFirstTry: boolean;
  repairs: number;
  components: number;
  finalTreeValid: boolean;
  outputTokens: number;
  inputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  firstA2uiMs: number | null;
  totalMs: number;
  error?: string;
}

const results: RunResult[] = [];
for (let run = 1; run <= runs; run++) {
  const session = new Session(`bench-${scenario}-${run}`);
  const envelopes: A2uiEnvelope[] = [];
  if (scenario === "s5") await runTurn(session, CONTROL_EXAMPLE_TEXT);
  session.subscribe((event, data) => event === "a2ui" && envelopes.push(data as A2uiEnvelope));
  const t = await runTurn(session, scenario === "s1" ? CONTROL_EXAMPLE_TEXT : "Покажи итог: кто сколько должен и кто кому переводит");
  // The tree that ended up on screen for the last surface created in this turn.
  const created = envelopes.filter((e) => "createSurface" in e).map((e) => (e as { createSurface: { surfaceId: string } }).createSurface.surfaceId);
  const lastSurface = created.at(-1);
  const tree = envelopes
    .filter((e) => "updateComponents" in e && e.updateComponents.surfaceId === lastSurface)
    .flatMap((e) => (e as { updateComponents: { components: unknown[] } }).updateComponents.components);
  const rendered = scenario === "s1" ? session.surfaces.has("bill") : true;
  const result: RunResult = {
    run,
    ok: !t.error && rendered,
    validFirstTry: !t.error && rendered && t.validationRepairs === 0,
    repairs: t.validationRepairs,
    components: tree.length,
    finalTreeValid: tree.length > 0 ? validateComponents(tree).ok : scenario === "s5",
    outputTokens: t.tokens.output,
    inputTokens: t.tokens.input,
    cacheRead: t.tokens.cacheRead,
    cacheWrite: t.tokens.cacheWrite,
    firstA2uiMs: t.firstA2uiMs,
    totalMs: t.totalMs,
    error: t.error,
  };
  results.push(result);
  console.info(`[bench] ${scenario} run ${run}/${runs}`, JSON.stringify(result));
}

const nums = (key: keyof RunResult) => results.map((r) => r[key]).filter((v): v is number => typeof v === "number");
const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};
const stats = Object.fromEntries(
  (["outputTokens", "inputTokens", "cacheRead", "cacheWrite", "firstA2uiMs", "totalMs", "components", "repairs"] as const).map((k) => [
    k,
    { mean: mean(nums(k)), median: median(nums(k)) },
  ]),
);
const report = {
  scenario,
  model: config.model,
  effort: config.effort,
  stream: config.stream,
  runs,
  ok: results.filter((r) => r.ok).length,
  validFirstTry: results.filter((r) => r.validFirstTry).length,
  stats,
  results,
};

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bench");
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `${scenario}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(file, JSON.stringify(report, null, 2));
console.table(results.map(({ error, ...r }) => ({ ...r, error: error?.slice(0, 40) ?? "" })));
console.info(JSON.stringify({ ...report, results: undefined }, null, 1));
console.info(`[bench] written ${file}`);
