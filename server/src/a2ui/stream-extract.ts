// Incremental reader for the streamed render_surface tool input
// ({"surfaceId": "...", "components": [{...}, {...}], "data": {...}}): reports the surface id
// as soon as its string closes and each top-level component as soon as its object closes,
// so the client can render while the model is still writing (S10).
import { createScope } from "../log.js";

const logger = createScope("a2ui.stream");

export interface ExtractorEvents {
  onSurfaceId?: (surfaceId: string) => void;
  onComponent?: (component: Record<string, unknown>, index: number) => void;
}

export class ComponentStreamExtractor {
  private buffer = "";
  private pos = 0;
  /** Stack of open containers: "{" or "[". */
  private stack: string[] = [];
  private inString = false;
  private escaped = false;
  private stringStart = -1;
  /** At depth 1 (root object): whether the next string is a key. */
  private expectKey = false;
  private lastKey: string | undefined;
  /** Depth of the "components" array once it is open (its elements live at depth + 1). */
  private componentsDepth = -1;
  private componentStart = -1;
  private emitted = 0;
  private surfaceId: string | undefined;

  constructor(private readonly events: ExtractorEvents = {}) {}

  get componentCount(): number {
    return this.emitted;
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    for (; this.pos < this.buffer.length; this.pos++) this.step(this.buffer[this.pos], this.pos);
  }

  /** Full parsed input; throws a readable error when the accumulated JSON is invalid. */
  done(): Record<string, unknown> {
    try {
      return JSON.parse(this.buffer) as Record<string, unknown>;
    } catch (err) {
      const tail = this.buffer.slice(-120);
      throw new Error(`render_surface input is not valid JSON (${(err as Error).message}); tail: …${tail}`);
    }
  }

  private step(ch: string, i: number): void {
    if (this.inString) {
      if (this.escaped) this.escaped = false;
      else if (ch === "\\") this.escaped = true;
      else if (ch === '"') {
        this.inString = false;
        this.onStringEnd(this.buffer.slice(this.stringStart, i + 1));
      }
      return;
    }
    switch (ch) {
      case '"':
        this.inString = true;
        this.stringStart = i;
        break;
      case "{":
      case "[":
        if (ch === "[" && this.stack.length === 1 && this.lastKey === "components" && !this.expectKey) {
          this.componentsDepth = 2;
        }
        if (ch === "{" && this.componentsDepth > 0 && this.stack.length === this.componentsDepth) this.componentStart = i;
        this.stack.push(ch);
        if (this.stack.length === 1) this.expectKey = true;
        break;
      case "}":
      case "]":
        this.stack.pop();
        if (ch === "}" && this.componentStart >= 0 && this.stack.length === this.componentsDepth) {
          this.emitComponent(this.buffer.slice(this.componentStart, i + 1));
          this.componentStart = -1;
        }
        if (ch === "]" && this.stack.length === 1 && this.componentsDepth > 0) this.componentsDepth = -1;
        break;
      case ":":
        if (this.stack.length === 1) this.expectKey = false;
        break;
      case ",":
        if (this.stack.length === 1) this.expectKey = true;
        break;
    }
  }

  private onStringEnd(raw: string): void {
    if (this.stack.length !== 1) return;
    const value = JSON.parse(raw) as string;
    if (this.expectKey) {
      this.lastKey = value;
    } else if (this.lastKey === "surfaceId" && this.surfaceId === undefined) {
      this.surfaceId = value;
      logger.debug("surfaceId", { surfaceId: value });
      this.events.onSurfaceId?.(value);
    }
  }

  private emitComponent(raw: string): void {
    let component: Record<string, unknown>;
    try {
      component = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return; // malformed element: the final validation reports it
    }
    this.events.onComponent?.(component, this.emitted);
    this.emitted += 1;
  }
}
