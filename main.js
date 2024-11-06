const { app, BrowserWindow, ipcMain } = require("electron");

const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;
const CSGOGSI = require("node-csgo-gsi");

let mainWindow;
let controlWindow;
let logWindow;
let childProcess = null;
let isFullscreen = true;

function createMainWindow() {
  if (!mainWindow) {
    mainWindow = new BrowserWindow({
      width: 1920,
      height: 1080,
      frame: false,
      fullscreen: isFullscreen,
      transparent: true,
      alwaysOnTop: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    mainWindow.setAlwaysOnTop(true, "screen");
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
    mainWindow.loadURL(
      "https://uniliga.overlays.konopka.gg/19278d91-51d1-43df-8998-4f8fc992dfce/games/cs2/ingame"
    );

    mainWindow.on("closed", () => {
      mainWindow = null;
    });
  } else {
    mainWindow.show();
  }
}

function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 700,
    height: 220,
    transparent: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  controlWindow.loadFile("control.html");

  controlWindow.on("closed", () => {
    controlWindow = null;
    if (mainWindow) mainWindow.close();
  });
}

function createLogWindow() {
  if (!logWindow) {
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
}

function runCSGOScript() {
  // Assuming gsiAll accepts callbacks for logging data and errors
  gsiAll(
    // onData callback
    (data) => {
      if (logWindow) {
        logWindow.webContents.send("log", data.toString());
      }
    },
    // onError callback
    (error) => {
      if (logWindow) {
        logWindow.webContents.send("log", `Error: ${error.toString()}`);
      }
    },
    // onClose callback
    (code) => {
      if (logWindow) {
        logWindow.webContents.send("log", `Process exited with code ${code}`);
      }
    }
  );
}

app.on("ready", () => {
  createControlWindow();
  runCSGOScript();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
    createControlWindow();
  }
});

ipcMain.on("refresh-main-window", () => {
  if (mainWindow) mainWindow.reload();
});

// IPC event for hiding the main window
ipcMain.on("hide-overlay", () => {
  if (mainWindow) {
    mainWindow.close();
  }
});

// IPC event for showing the main window
ipcMain.on("show-overlay", () => {
  createMainWindow();
});

ipcMain.on("load-url", (event, url) => {
  if (mainWindow) mainWindow.loadURL(url);
});

ipcMain.on("shutdown-app", () => {
  app.quit();
});

ipcMain.on("run-csgo-websocket-script", () => {
  runCSGOScript();
});

ipcMain.on("open-log-window", () => {
  if (!logWindow) {
    createLogWindow();
  }
  logWindow.show();
});

//CS GSI Websocket Script
let gsi = new CSGOGSI({ port: 55599 });
gsi.on("all", (data) => gsiAll(data));

let wsPort = 55333;

const wss = new WebSocketServer({
  port: wsPort,
});

wss.on("connection", async (ws) => {
  ws.on("error", console.error);

  ws.on("message", (message) => onMessage(message));

  ws.send("connected to cs websocket server");

  onConnection();
});

function gsiAll(data) {
  // console.log(data);
  if (logWindow) {
    logWindow.webContents.send("log", JSON.stringify(data));
  }
  const message = {
    type: "csgsiAll",
    projectid: "",
    data: data,
  };
  wss.clients.forEach(function each(client) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ message }));
    }
  });
}

function onMessage(message) {
  console.log("Message received: ", message);
  if (logWindow) {
    logWindow.webContents.send("log", message);
  }
}

function onConnection() {
  wss.clients.forEach(function each(client) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ message: "CS GSI Connection established" }));
    }
  });
}
