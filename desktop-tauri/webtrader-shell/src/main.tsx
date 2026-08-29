import { createRoot } from "react-dom/client";
import { installDesktopFetchShim, installDesktopContextMenuGuard } from "@/lib/desktop-api";
import App from "./App";

// WebTrader.tsx itself always used tradeApi/apiCall correctly, but at
// least one shared component (NewsPanel.tsx) calls the browser's own
// fetch("/api/...") directly -- see installDesktopFetchShim's own doc
// comment. Must run before React renders anything that might fetch on
// mount.
installDesktopFetchShim();
installDesktopContextMenuGuard();

createRoot(document.getElementById("root")!).render(<App />);
