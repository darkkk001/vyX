import { createRoot } from "react-dom/client";
import { installDesktopFetchShim } from "@/lib/desktop-api";
import "./index.css";
import App from "./App";

// Every Manager component below calls the browser's own fetch("/api/...")
// -- see installDesktopFetchShim's own doc comment for why this has to
// run before React renders anything that might fetch on mount.
installDesktopFetchShim();

createRoot(document.getElementById("root")!).render(<App />);
