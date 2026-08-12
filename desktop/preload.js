const { contextBridge, ipcRenderer } = require("electron");

// Exposed to WebTrader (running as the remote page in this window) so it
// can render its own dark-themed title bar and drive real window controls
// — the frameless window (see main.js) has no native title bar of its own.
// Also the isDesktop flag gates native OS notifications and desktop-only
// UI (title bar, connection status wording) that a normal browser tab
// doesn't need.
contextBridge.exposeInMainWorld("vyxDesktop", {
  isDesktop: true,
  minimize: () => ipcRenderer.send("win:minimize"),
  toggleMaximize: () => ipcRenderer.send("win:toggle-maximize"),
  close: () => ipcRenderer.send("win:close"),
  onMaximizedChange: (callback) => {
    const handler = (_event, isMaximized) => callback(isMaximized);
    ipcRenderer.on("win:maximized-changed", handler);
    return () => ipcRenderer.removeListener("win:maximized-changed", handler);
  },
  // Called after a successful /trade load so the app can skip straight
  // back to this broker next launch instead of showing the server picker
  // again (the session cookie itself is what actually keeps them logged
  // in — this only remembers which broker to point at).
  rememberBroker: (hostname) => ipcRenderer.send("auth:remember-broker", hostname),
  forgetBroker: () => ipcRenderer.send("auth:forget-broker"),
});
