// The only things the page can ask of the desktop shell. A key goes in. It never comes back out.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("catalystQDesktop", {
	saveKey: (key) => ipcRenderer.invoke("key:save", key),
	clearKey: () => ipcRenderer.invoke("key:clear"),
});
