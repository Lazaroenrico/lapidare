"use strict";
// Ponte minima e fixa renderer <-> main. Nao expoe ipcRenderer cru nem segredos.
const { contextBridge, ipcRenderer } = require("electron");

const arg = process.argv.find((a) => a.startsWith("--lapidare-version="));
const appVersion = arg ? arg.slice("--lapidare-version=".length) : "";
const STATE = "lapidare:updates:state";

contextBridge.exposeInMainWorld("lapidare", {
  appVersion,
  updates: {
    getState: () => ipcRenderer.invoke("lapidare:updates:get"),
    onState: (cb) => {
      if (typeof cb !== "function") return () => {};
      const h = (_e, s) => cb(s);
      ipcRenderer.on(STATE, h);
      return () => ipcRenderer.removeListener(STATE, h);
    },
    check: () => ipcRenderer.invoke("lapidare:updates:check"),
    restart: () => ipcRenderer.invoke("lapidare:updates:restart"),
    openRelease: () => ipcRenderer.invoke("lapidare:updates:open-release"),
    setAuto: (on) => ipcRenderer.invoke("lapidare:updates:set-auto", on === true),
  },
  vault: {
    pick: (current) => ipcRenderer.invoke("lapidare:vault:pick", typeof current === "string" ? current : ""),
  },
});
