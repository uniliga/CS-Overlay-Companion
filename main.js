const { app, BrowserWindow, ipcMain, screen } = require("electron");
const fs = require("fs");
const path = require("path");

const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;
const CSGOGSI = require("node-csgo-gsi");

const GSI_PORT = 55599;
const WS_PORT = 55333;
// Skip a client whose send buffer grows beyond this (slow/hung overlay)
const MAX_BUFFERED_BYTES = 5 * 1024 * 1024;
const RELOAD_DELAY_MS = 3000;
// Layout size the overlay page is designed for; it gets zoomed to fill the screen
const OVERLAY_BASE_WIDTH = 1920;
const OVERLAY_BASE_HEIGHT = 1080;
// How long a player has to be alive without any weapon before counting as coach
const COACH_DETECT_MS = 3000;

// Without this, Windows marks the overlay as occluded while a fullscreen game
// is in front and Chromium stops painting / throttles it.
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");

let mainWindow;
let controlWindow;
let logWindow;
let overlayUrl = "";
let reloadTimer = null;
let gsi = null;
let wss = null;
// Manual choice from the control panel per steamid (true = shown), wins over coach detection
let playerVisibility = {};
const detectedCoaches = new Set();
// steamid -> since when the player is alive without weapons
const unarmedSince = new Map();
let playerListJson = "";
let lastAllPlayers = null;

// Stored in %APPDATA%\CS Overlay Companion, survives portable exe restarts
function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  try {
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
  } catch (error) {
    logError("saving config", error);
  }
}

function log(message) {
  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.webContents.send("log", message);
  }
}

function logError(context, error) {
  const text = `Error (${context}): ${error && error.stack ? error.stack : error}`;
  console.error(text);
  log(text);
}

if (!app.requestSingleInstanceLock()) {
  // Another instance already owns the GSI/WebSocket ports
  app.quit();
} else {
  app.on("second-instance", () => {
    if (controlWindow) {
      if (controlWindow.isMinimized()) controlWindow.restore();
      controlWindow.focus();
    }
  });

  app.on("ready", () => {
    const config = loadConfig();
    overlayUrl = config.overlayUrl || "";
    playerVisibility = config.playerVisibility || {};
    createControlWindow();
    startServers();
  });
}

process.on("uncaughtException", (error) => logError("uncaught", error));
process.on("unhandledRejection", (error) => logError("unhandled rejection", error));

function scheduleOverlayReload(reason) {
  log(`Overlay ${reason}, reloading in ${RELOAD_DELAY_MS / 1000}s`);
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && overlayUrl) mainWindow.loadURL(overlayUrl);
  }, RELOAD_DELAY_MS);
}

function createMainWindow() {
  if (mainWindow) {
    mainWindow.show();
    return;
  }

  const { x, y, width, height } = screen.getPrimaryDisplay().bounds;
  mainWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      // Remote page: no Node access
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  // Windows clamps the initial size to the work area (minus taskbar)
  mainWindow.setBounds({ x, y, width, height });
  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.setVisibleOnAllWorkspaces(true);
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  // Bounds are in DIP, so this also accounts for Windows display scaling
  // (4K @ 100% -> 2.0, 4K @ 200% -> 1.0). Zoom resets on navigation, so reapply.
  const zoomFactor = Math.min(width / OVERLAY_BASE_WIDTH, height / OVERLAY_BASE_HEIGHT);
  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.webContents.setZoomFactor(zoomFactor);
  });

  mainWindow.webContents.on("did-fail-load", (event, code, description, url, isMainFrame) => {
    // -3 = ERR_ABORTED, happens on normal navigation/reload
    if (isMainFrame && code !== -3) scheduleOverlayReload(`failed to load (${description})`);
  });
  mainWindow.webContents.on("render-process-gone", (event, details) => {
    scheduleOverlayReload(`renderer gone (${details.reason})`);
  });
  mainWindow.on("unresponsive", () => scheduleOverlayReload("unresponsive"));

  if (overlayUrl) {
    mainWindow.loadURL(overlayUrl);
  } else {
    log("No overlay URL set yet, enter one in the control panel");
  }

  mainWindow.on("closed", () => {
    clearTimeout(reloadTimer);
    mainWindow = null;
  });
}

function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 700,
    height: 520,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  controlWindow.loadFile("control.html");

  controlWindow.on("closed", () => {
    controlWindow = null;
    app.quit();
  });
}

function createLogWindow() {
  if (logWindow) {
    logWindow.show();
    return;
  }

  logWindow = new BrowserWindow({
    width: 800,
    height: 600,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  logWindow.loadFile("log.html");

  logWindow.on("closed", () => {
    logWindow = null;
  });
}

// Resolves once both ports are released so they can be bound again
function stopServers() {
  const closing = [];
  if (gsi) {
    const { server } = gsi;
    gsi.removeAllListeners();
    gsi.stopC4Countdown();
    closing.push(new Promise((resolve) => server.close(resolve)));
    server.closeAllConnections();
    gsi = null;
  }
  if (wss) {
    const server = wss;
    server.clients.forEach((client) => client.terminate());
    closing.push(new Promise((resolve) => server.close(resolve)));
    wss = null;
  }
  return Promise.all(closing);
}

function restartServers() {
  stopServers().then(startServers);
}

function startServers() {
  gsi = new CSGOGSI({ port: GSI_PORT });
  gsi.server.on("error", (error) => logError(`GSI server on port ${GSI_PORT}`, error));
  gsi.server.on("clientError", (error, socket) => socket.destroy());
  gsi.on("all", gsiAll);

  wss = new WebSocketServer({ port: WS_PORT });
  wss.on("error", (error) => logError(`WebSocket server on port ${WS_PORT}`, error));
  wss.on("connection", (ws) => {
    ws.on("error", (error) => logError("WebSocket client", error));
    ws.on("message", onMessage);
    ws.send("connected to cs websocket server");
    onConnection();
  });

  log(`GSI listening on ${GSI_PORT}, WebSocket on ${WS_PORT}`);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  stopServers();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createControlWindow();
  }
});

ipcMain.on("refresh-main-window", () => {
  if (mainWindow) mainWindow.reload();
});

ipcMain.on("hide-overlay", () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.on("show-overlay", () => {
  createMainWindow();
});

ipcMain.on("load-url", (event, url) => {
  let parsed;
  try {
    parsed = new URL(String(url).trim());
  } catch {
    log(`Invalid overlay URL: ${url}`);
    return;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    log(`Invalid overlay URL: ${url}`);
    return;
  }
  overlayUrl = parsed.href;
  saveConfig({ ...loadConfig(), overlayUrl });
  log(`Overlay URL saved: ${overlayUrl}`);
  if (mainWindow) mainWindow.loadURL(overlayUrl);
});

ipcMain.handle("get-overlay-url", () => overlayUrl);

ipcMain.on("shutdown-app", () => {
  app.quit();
});

ipcMain.on("run-csgo-websocket-script", () => {
  restartServers();
});

ipcMain.on("open-log-window", () => {
  createLogWindow();
});

ipcMain.handle("get-players", () => JSON.parse(playerListJson || "[]"));

ipcMain.on("set-player-visible", (event, steamid, visible) => {
  playerVisibility = { ...playerVisibility, [steamid]: !!visible };
  saveConfig({ ...loadConfig(), playerVisibility });
  log(`Player ${steamid} ${visible ? "shown" : "hidden"}`);
  sendPlayerList(lastAllPlayers);
});

ipcMain.on("reset-player-visibility", () => {
  playerVisibility = {};
  saveConfig({ ...loadConfig(), playerVisibility });
  log("Player visibility reset");
  sendPlayerList(lastAllPlayers);
});

function isPlayerVisible(steamid) {
  if (steamid in playerVisibility) return playerVisibility[steamid];
  return !detectedCoaches.has(steamid);
}

// Coaches spawn alive in freezetime but never get a weapon, real players always have at least a knife.
// The pattern has to last a moment so a single update right at spawn doesn't count.
function detectCoaches(allplayers) {
  const players = Object.entries(allplayers || {});
  // Without "allplayers_weapons" in the GSI config every player would look unarmed
  if (!players.some(([, player]) => Object.keys(player.weapons || {}).length)) return;
  const now = Date.now();
  for (const [steamid, player] of players) {
    const unarmed = player.state && player.state.health > 0 && !Object.keys(player.weapons || {}).length;
    if (!unarmed) {
      unarmedSince.delete(steamid);
      continue;
    }
    if (!unarmedSince.has(steamid)) unarmedSince.set(steamid, now);
    if (now - unarmedSince.get(steamid) >= COACH_DETECT_MS && !detectedCoaches.has(steamid)) {
      detectedCoaches.add(steamid);
      log(`Coach detected: ${player.name} (${steamid})`);
    }
  }
}

// Copy of the GSI data without hidden players; node-csgo-gsi keeps working on the original
function withoutHiddenPlayers(data) {
  const strip = (players) =>
    players && typeof players === "object"
      ? Object.fromEntries(Object.entries(players).filter(([steamid]) => isPlayerVisible(steamid)))
      : players;
  const filtered = { ...data, allplayers: strip(data.allplayers) };
  for (const key of ["previously", "added"]) {
    if (data[key] && data[key].allplayers) {
      filtered[key] = { ...data[key], allplayers: strip(data[key].allplayers) };
    }
  }
  return filtered;
}

// Player list for the control panel, only sent when something changed
function sendPlayerList(allplayers) {
  const players = Object.entries(allplayers || {}).map(([steamid, player]) => ({
    steamid,
    name: player.name,
    team: player.team,
    observer_slot: player.observer_slot,
    coach: detectedCoaches.has(steamid),
    visible: isPlayerVisible(steamid),
  }));
  const json = JSON.stringify(players);
  if (json === playerListJson) return;
  playerListJson = json;
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send("players", players);
  }
}

function gsiAll(data) {
  lastAllPlayers = data.allplayers;
  detectCoaches(data.allplayers);
  sendPlayerList(data.allplayers);
  const payload = JSON.stringify({
    message: { type: "csgsiAll", projectid: "", data: withoutHiddenPlayers(data) },
  });
  log(payload);
  if (!wss) return;
  wss.clients.forEach((client) => {
    if (
      client.readyState === WebSocket.OPEN &&
      client.bufferedAmount < MAX_BUFFERED_BYTES
    ) {
      client.send(payload);
    }
  });
}

function onMessage(message) {
  const text = message.toString();
  console.log("Message received: ", text);
  log(text);
}

function onConnection() {
  const payload = JSON.stringify({ message: "CS GSI Connection established" });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}
