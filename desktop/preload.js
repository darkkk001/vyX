const { contextBridge } = require("electron");

// Lets WebTrader (running as the remote page in this window) tell it's
// inside the desktop shell — used to gate native OS notifications for
// background events (price alerts, SL/TP hits) that a normal browser tab
// wouldn't need this for. Nothing else exposed: WebTrader is a plain web
// app with no other need for Electron-specific APIs today.
contextBridge.exposeInMainWorld("vyxDesktop", { isDesktop: true });
