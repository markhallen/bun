// This script is JS so that it can run in Node.js due to issues with happy dom and Bun
// - https://github.com/oven-sh/bun/issues/16363
// - https://github.com/oven-sh/bun/issues/6044
import { Window } from "happy-dom";
import util from "node:util";

let url = process.argv[2];
if (!url) {
  console.error("Usage: node client-fixture.mjs <url>");
  process.exit(1);
}
url = new URL(url, "http://localhost:3000");

// Create a new window instance
let window;
let expectingReload = false;
let webSockets = [];
let pendingReload = null;
let pendingReloadTimer = null;

function reset() {
  for (const ws of webSockets) {
    ws.onclose = () => {};
    ws.onerror = () => {};
    ws.onmessage = () => {};
    ws.onopen = () => {};
    ws.close();
  }
  webSockets = [];
  if (window) {
    window.location.reload = () => {};
    window.console = {
      log: () => {},
      error: () => {},
      warn: () => {},
      info: () => {},
    };
    window.harness = {
      send: () => {},
    };
  }
}

function createWindow(windowUrl) {
  window = new Window({
    url: windowUrl,
    width: 1024,
    height: 768,
  });

  window.fetch = fetch;

  // Provide WebSocket
  window.WebSocket = class extends WebSocket {
    constructor(url, protocols, options) {
      url = new URL(url, window.location.origin).href;
      super(url, protocols, options);
      webSockets.push(this);
    }
    close() {
      super.close();
      webSockets = webSockets.filter(ws => ws !== this);
    }
  };

  // Add fetch support
  window.fetch = fetch;

  // Intercept console messages
  const originalConsole = window.console;
  window.console = {
    log: (...args) => {
      process?.send({ type: "message", args: args });
    },
    error: (...args) => {
      console.error("[E]", ...args);
      originalConsole.error(...args);
    },
    warn: (...args) => {
      console.warn("[W]", ...args);
      originalConsole.warn(...args);
    },
    info: (...args) => {
      if (args[0]?.startsWith("[WS] receive message")) return;
      if (args[0]?.startsWith("Updated modules:")) return;
      console.info("[I]", ...args);
      originalConsole.info(...args);
    },
  };

  window.location.reload = async () => {
    reset();
    if (expectingReload) {
      // Permission already granted, proceed with reload
      handleReload();
    } else {
      // Store the reload request and set a timer
      pendingReload = () => handleReload();
      if (pendingReloadTimer) clearTimeout(pendingReloadTimer);
      pendingReloadTimer = setTimeout(() => {
        // If we get here, permission never came
        console.error("[E] location.reload() called but permission never arrived");
        process.exit(2);
      }, 1000);
    }
  };
}

async function handleReload() {
  expectingReload = false;
  pendingReload = null;
  if (pendingReloadTimer) {
    clearTimeout(pendingReloadTimer);
    pendingReloadTimer = null;
  }

  process.send({ type: "reload", args: [] });

  // Destroy the old window
  reset();
  window.close();

  // Create a new window instance
  createWindow(url);

  // Reload the page content
  try {
    await loadPage(window);
  } catch (error) {
    console.error("Failed to reload page:", error);
    process.exit(1);
  }
}

// Extract page loading logic to a reusable function
async function loadPage() {
  const response = await fetch(url);
  if (response.status >= 400 && response.status <= 499) {
    console.error("Failed to load page:", response.statusText);
    process.exit(1);
  }
  if (!response.headers.get("content-type").match(/^text\/html;?/)) {
    console.error("Invalid content type:", response.headers.get("content-type"));
    process.exit(1);
  }
  const html = await response.text();
  if (!html.includes("<script")) {
    console.error("missing <script>");
    process.exit(1);
  }
  window.document.write(html);
}

// Listen for control messages from the test harness
process.on("message", async message => {
  if (message.type === "expect-reload") {
    expectingReload = true;
    // If there was a pending reload request, handle it now
    if (pendingReload) {
      pendingReload();
    }
  }
  if (message.type === "hard-reload") {
    expectingReload = true;
    await handleReload();
  }
  if (message.type === "evaluate") {
    const [messageId, code, mode] = message.args;
    try {
      // Evaluate the code in the window context
      let result;
      try {
        result = await window.eval(code);
      } catch (error) {
        if (error.message === "Illegal return statement") {
          result = await window.eval(`(async () => { ${code} })()`);
        } else {
          throw error;
        }
      }

      if (mode === "interactive") {
        result = util.inspect(result, false, null, true);
      }

      // Send back the result
      process.send({
        type: `js-result-${messageId}`,
        args: [
          {
            value: result,
          },
        ],
      });
    } catch (error) {
      // Send back any errors
      process.send({
        type: `js-result-${messageId}`,
        args: [
          {
            error: error.message,
          },
        ],
      });
    }
  }
  if (message.type === "exit") {
    process.exit(0);
  }
});
process.on("exit", () => {
  if (expectingReload) {
    console.error("[E] location.reload() was not called");
    process.exit(2);
  }
});

// Initial page load
createWindow(url);
await loadPage(window);
