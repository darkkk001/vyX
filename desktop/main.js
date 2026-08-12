const { app, BrowserWindow, Menu, shell } = require("electron");
const path = require("path");
const fs = require("fs");

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "broker.config.json"), "utf-8"));
// "launcher" (no broker baked in) opens the root-domain server picker,
// same role as MT5's server dropdown — the trader picks their broker there,
// which then sends them on to that specific broker's own login. "broker"
// mode skips straight to one broker's WebTrader.
const isLauncher = config.mode === "launcher";
const startUrl = `https://${config.subdomain}${isLauncher ? "/launch" : "/trade"}`;
// In launcher mode navigation must be allowed to roam across broker
// subdomains (that's the whole point); in broker mode it stays locked to
// that one broker's own subdomain.
const allowedHost = isLauncher ? config.rootDomain : config.subdomain;

// No default Electron menu — this is a trading terminal, not a browser.
Menu.setApplicationMenu(null);

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: config.brokerName,
    backgroundColor: "#07090C",
    icon: path.join(__dirname, "build", "icon.ico"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
    show: false,
  });

  win.once("ready-to-show", () => win.show());

  // The web app's own <title> ("Create Next App" — never customized) would
  // otherwise silently overwrite this window's title; keep it on the
  // broker's name instead.
  win.on("page-title-updated", (event) => event.preventDefault());

  win.loadURL(startUrl);

  // Keep the terminal on the broker's own domain; anything else (support
  // links, external docs) opens in the OS browser instead of inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const target = new URL(url);
    const host = allowedHost.split(":")[0];
    if (target.hostname !== host && !target.hostname.endsWith(`.${host}`)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
