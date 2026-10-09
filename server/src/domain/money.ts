// Money parsing/formatting. Storage is integer minor units; users and the model speak
// major units with up to 2 decimals ("1200", "33.5", "33,50", "1 200.00").
import { DomainError } from "./errors.js";

export const MINOR_PER_MAJOR = 100;
/** U+2212 MINUS SIGN, as in the TZ tables ("−405"). */
export const MINUS = "−";

const MAJOR_RE = /^(\d+)(?:[.,](\d{1,2}))?$/;

export function parseMajor(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) {
      throw new DomainError("INVALID_AMOUNT", `Некорректная сумма: ${input}`, { input });
    }
    const scaled = Math.round(input * MINOR_PER_MAJOR);
    // Reject more than 2 decimals: 12.345 * 100 is not (close to) an integer.
    if (Math.abs(scaled - input * MINOR_PER_MAJOR) > 1e-6) {
      throw new DomainError("INVALID_AMOUNT", `Больше двух знаков после запятой: ${input}`, { input });
    }
    return scaled;
  }
  const normalized = input.trim().replace(/[\s  ']/g, "");
  const match = MAJOR_RE.exec(normalized);
  if (!match) {
    throw new DomainError("INVALID_AMOUNT", `Некорректная сумма: «${input}»`, { input });
  }
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const result = whole * MINOR_PER_MAJOR + fraction;
  if (!Number.isSafeInteger(result)) {
    throw new DomainError("INVALID_AMOUNT", `Слишком большая сумма: «${input}»`, { input });
  }
  return result;
}

/** 120000 → "1200.00"; with `sign: true` → "+1200.00" / "−405.00" / "0.00". */
export function formatMinor(n: number, opts: { sign?: boolean } = {}): string {
  if (!Number.isInteger(n)) throw new Error(`formatMinor expects an integer, got ${n}`);
  const abs = Math.abs(n);
  const body = `${Math.floor(abs / MINOR_PER_MAJOR)}.${String(abs % MINOR_PER_MAJOR).padStart(2, "0")}`;
  if (n < 0) return `${MINUS}${body}`;
  if (opts.sign && n > 0) return `+${body}`;
  return body;
}
