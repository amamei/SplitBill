// Domain errors are returned to the model as tool results and shown in the UI,
// so `message` is user-facing Russian text and `details` is machine-readable.

export type DomainErrorCode =
  | "INVALID_AMOUNT"
  | "EXACT_MISMATCH"
  | "INVALID_WEIGHT"
  | "UNKNOWN_PERSON"
  | "PERSON_REFERENCED"
  | "NOT_FOUND"
  | "EMPTY_SPLIT"
  | "DUPLICATE_NAME"
  | "AMBIGUOUS_NAME"
  | "INVALID_NAME";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: DomainErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: DomainErrorCode; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError;
}
