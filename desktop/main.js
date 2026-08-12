const { app, BrowserWindow, Menu, shell, Tray, session, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const windowStateKeeper = require("electron-window-state");
const { autoUpdater } = require("electron-updater");

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "broker.config.json"), "utf-8"));
// "launcher" (no broker baked in) opens the root-domain server picker,
// same role as MT5's server dropdown — the trader picks their broker there,
// which then sends them on to that specific broker's own login. "broker"
// mode skips straight to one broker's WebTrader.
const isLauncher = config.mode === "launcher";
const launchUrl = `https://${config.subdomain}/launch`;
const brokerUrl = `https://${config.subdomain}/trade`;
// In launcher mode navigation must be allowed to roam across broker
// subdomains (that's the whole point); in broker mode it stays locked to
// that one broker's own subdomain.
const allowedHost = isLauncher ? config.rootDomain : config.subdomain;
const iconPath = path.join(__dirname, "build", "icon.ico");
const loadingPath = path.join(__dirname, "screens", "loading.html");
const offlinePath = path.join(__dirname, "screens", "offline.html");

// Which broker subdomain to reopen straight to next launch, remembered so
// the trader isn't back at the server picker every time — the actual
// "still logged in" part comes from the session cookie persisting on its
// own (Electron's default session is disk-backed), this only decides which
// URL to point at. Only meaningful in launcher mode; a broker-specific
// build always has exactly one broker anyway.
const rememberedBrokerPath = path.join(app.getPath("userData"), "remembered-broker.json");
function getRememberedBroker() {
  try {
    return JSON.parse(fs.readFileSync(rememberedBrokerPath, "utf-8")).hostname || null;
  } catch {
    return null;
  }
}
function setRememberedBroker(hostname) {
  try {
    fs.writeFileSync(rememberedBrokerPath, JSON.stringify({ hostname }));
  } catch {
    // non-fatal — worst case the picker shows again next launch
  }
}
function clearRememberedBroker() {
  try {
    fs.unlinkSync(rememberedBrokerPath);
  } catch {
    // already gone
  }
}

function startUrlFor() {
  if (!isLauncher) return brokerUrl;
  const remembered = getRememberedBroker();
  return remembered ? `https://${remembered}/trade` : launchUrl;
}

// No default Electron menu — this is a trading terminal, not a browser,
// and the window has its own custom title bar (see below) rendered by
// WebTrader itself when window.vyxDesktop.isDesktop is set.
Menu.setApplicationMenu(null);

let mainWindow = null;
let tray = null;
let isQuitting = false;

function createWindow() {
  const windowState = windowStateKeeper({ defaultWidth: 1440, defaultHeight: 900, file: "window-state.json" });

  const win = new BrowserWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    minWidth: 1024,
    minHeight: 640,
    title: config.brokerName,
    backgroundColor: "#07090C",
    icon: iconPath,
    frame: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
    show: false,
  });
  windowState.manage(win);
  mainWindow = win;

  win.once("ready-to-show", () => win.show());
  win.on("page-title-updated", (event) => event.preventDefault());
  win.on("maximize", () => win.webContents.send("win:maximized-changed", true));
  win.on("unmaximize", () => win.webContents.send("win:maximized-changed", false));

  // Splash first (instant, local), then swap to the real remote page —
  // otherwise a slow/unreachable connection just leaves a blank white
  // window with no feedback.
  win.loadFile(loadingPath);
  const swapToRemote = setTimeout(() => win.loadURL(startUrlFor()), 350);
  win.once("close", () => clearTimeout(swapToRemote));

  win.webContents.on("did-fail-load", (_event, _code, _desc, failedUrl, isMainFrame) => {
    if (!isMainFrame) return;
    if (failedUrl.startsWith("file://")) return; // the offline page itself failing — don't loop
    win.loadFile(offlinePath, { query: { url: startUrlFor() } });
  });

  // Keep the terminal on the broker's own domain (or, in launcher mode, any
  // broker subdomain — that's the whole point of the picker); anything else
  // (support links, external docs) opens in the OS browser instead of
  // inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("file://")) return; // internal splash/offline pages
    const target = new URL(url);
    const host = allowedHost.split(":")[0];
    if (target.hostname !== host && !target.hostname.endsWith(`.${host}`)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Closing the window minimizes to tray instead of quitting, so background
  // price alerts / SL-TP notifications keep working — matches how a real
  // trading terminal behaves. Only the tray's own "Quit" (or OS shutdown)
  // actually exits.
  win.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });
}

ipcMain.on("win:minimize", () => mainWindow?.minimize());
ipcMain.on("win:toggle-maximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on("win:close", () => mainWindow?.close());
ipcMain.on("auth:remember-broker", (_event, hostname) => {
  if (typeof hostname === "string" && hostname) setRememberedBroker(hostname);
});
ipcMain.on("auth:forget-broker", () => clearRememberedBroker());

function createTray() {
  tray = new Tray(iconPath);
  tray.setToolTip(config.brokerName);
  refreshTrayMenu();
  tray.on("click", () => mainWindow?.show());
}

function refreshTrayMenu() {
  const openAtLogin = app.getLoginItemSettings().openAtLogin;
  const contextMenu = Menu.buildFromTemplate([
    { label: `Show ${config.brokerName}`, click: () => mainWindow?.show() },
    { type: "separator" },
    {
      label: "Launch at startup",
      type: "checkbox",
      checked: openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: "separator" },
    { label: "Quit", click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
}

app.whenReady().then(() => {
  // Auto-grant notification permission for the app's own remote origin so
  // WebTrader's native Notification calls (price alerts, SL/TP hits — see
  // pushToast in WebTrader.tsx) show without an interruptive prompt.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "notifications");
  });

  createWindow();
  createTray();

  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {
      // no update feed reachable / configured — not fatal, app already runs
    });
  }
});

// Tray keeps the app "running" on Windows even with the window hidden — the
// app should only fully exit via the tray's Quit item or OS shutdown, not
// just because the last window closed (it doesn't actually close, see the
// window's own "close" handler above, but this covers other platforms/edge
// cases consistently).
app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && isQuitting) app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else mainWindow?.show();
});
