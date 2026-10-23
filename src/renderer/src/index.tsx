import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
// App tokens and editor overrides must follow the third-party themes.
import "./styles/globals.css";
import { AppKernel } from "./app/AppKernel";

createRoot(document.getElementById("root")!).render(<StrictMode><AppKernel /></StrictMode>);
