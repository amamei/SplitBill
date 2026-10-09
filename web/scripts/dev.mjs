// Vite's dev server cannot load modules when the project path contains "#"
// (it treats "#" as a URL fragment), e.g. ~/workspaces/#hakaton/... .
// In that case fall back to `vite build --watch`; the API server serves web/dist
// on the same origin (http://localhost:8787). Otherwise run the normal dev server.
import { spawn } from "node:child_process";

const hashInPath = process.cwd().includes("#");
const args = hashInPath
  ? ["build", "--watch", "--mode", "development", "--sourcemap", "--emptyOutDir"]
  : [];
const port = process.env.PORT || "8787";

if (hashInPath) {
  console.info(`[web.dev] project path contains "#": building with --watch; open http://localhost:${port}`);
} else {
  console.info("[web.dev] starting Vite dev server (proxies /api to :" + port + ")");
}

const child = spawn("vite", args, { stdio: "inherit", shell: process.platform === "win32" });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
