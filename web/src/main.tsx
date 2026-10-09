import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initialDebugMode } from "./lib/debugMode";
import { info, setLogDebug } from "./lib/log";
import "./styles/index.css";

setLogDebug(initialDebugMode(location.search));
info("app", "boot", { search: location.search });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
