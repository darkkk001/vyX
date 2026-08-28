import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

// data-surface="super-admin" pulls in admin-theme.css's purple accent
// tokens (--accent/--accent-bg) that AdminShell's topbar avatar
// references via var(--accent) -- see app/(super-admin)/layout.tsx's
// identical attribute on the website.
createRoot(document.getElementById("root")!).render(
  <div data-surface="super-admin" className="min-h-dvh">
    <App />
  </div>
);
