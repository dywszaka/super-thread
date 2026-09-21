import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles/globals.css";
import { AppKernel } from "./app/AppKernel";

createRoot(document.getElementById("root")!).render(<StrictMode><AppKernel /></StrictMode>);
