import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { LlmConfig } from "../../config.js";
import { createApp } from "../server.js";
import { sessions } from "../sessions.js";

const DAHL = { provider: "dahl", model: "MiniMaxAI/MiniMax-M2.7", baseURL: "https://dahl.test/v1" } as const satisfies LlmConfig;
const ANTHROPIC = { provider: "anthropic", model: "claude-opus-5-5", effort: "medium", fallbacks: true } as const satisfies LlmConfig;
const OLLAMA = { provider: "ollama", model: "m", baseURL: "http://x" } as const satisfies LlmConfig;

async function serve(llm: LlmConfig): Promise<{ server: Server; url: string }> {
  const server = createApp({ llm }).listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const png = { mediaType: "image/png", dataBase64: "AA==" };
const post = (url: string, path: string, body: unknown) =>
  fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("/api/health", () => {
  const servers: Server[] = [];
  after(() => servers.forEach((s) => s.close()));

  it("reports provider, model and whether the model has vision", async () => {
    const cases: Array<[LlmConfig, boolean]> = [
      [DAHL, false],
      [ANTHROPIC, true],
      [OLLAMA, true],
    ];
    for (const [llm, vision] of cases) {
      const { server, url } = await serve(llm);
      servers.push(server);
      assert.deepEqual(await (await fetch(`${url}/api/health`)).json(), { ok: true, provider: llm.provider, model: llm.model, vision });
    }
  });
});

describe("POST /api/upload", () => {
  let dahl: { server: Server; url: string };
  let claude: { server: Server; url: string };
  before(async () => {
    dahl = await serve(DAHL);
    claude = await serve(ANTHROPIC);
  });
  after(() => {
    dahl.server.close();
    claude.server.close();
  });

  it("is refused with 422 NO_VISION on Dahl, before any model call, leaving the session untouched", async () => {
    const sessionId = "upload-dahl";
    const res = await post(dahl.url, "/api/upload", { sessionId, ...png });
    assert.equal(res.status, 422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "NO_VISION");
    assert.match(body.error.message, /MiniMaxAI\/MiniMax-M2\.7.*не читает изображения/);
    assert.equal(sessions.has(sessionId), false, "no session was even created");
  });

  it("is not refused when the model has vision (a busy session answers 409 without running a model)", async () => {
    const session = sessions.get("upload-claude");
    session.busy = true;
    try {
      const res = await post(claude.url, "/api/upload", { sessionId: "upload-claude", ...png });
      assert.equal(res.status, 409);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, "BUSY");
    } finally {
      session.busy = false;
    }
  });
});
