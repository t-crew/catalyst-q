// The desktop shell. All it adds to the shared page is a window, a custom protocol instead of an open port, and a
// place to keep an API key that the operating system encrypts. The page runs sandboxed with no Node access.
import { app, BrowserWindow, ipcMain, net, protocol, safeStorage, session, shell } from "electron";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createUiHandler } from "catalyst-q-ui";

const SCHEME = "catalyst-q";
const ORIGIN = `${SCHEME}://app`;
const here = dirname(fileURLToPath(import.meta.url));

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const keyPath = () => join(app.getPath("userData"), "api-key.enc");

async function readStoredKey() {
	try {
		const sealed = await readFile(keyPath());
		return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(sealed) : null;
	} catch {
		return null;
	}
}

async function saveKey(key) {
	if (typeof key !== "string" || !/^cq_live_\S+$/.test(key.trim())) {
		return { ok: false, detail: "That does not look like a key. Keys start with cq_live_." };
	}
	if (!safeStorage.isEncryptionAvailable()) {
		return { ok: false, detail: "This computer has no system keychain available, so the key was not saved." };
	}
	await mkdir(dirname(keyPath()), { recursive: true });
	await writeFile(keyPath(), safeStorage.encryptString(key.trim()), { mode: 0o600 });
	return { ok: true };
}

const fromThisApp = (event) => {
	const url = event.senderFrame?.url ?? "";
	return url === ORIGIN || url.startsWith(`${ORIGIN}/`);
};

/** Registers the protocol and the key channels. `baseUrl` and `fetch` can be replaced for local checks. */
export function setUpShell({ baseUrl, fetch } = {}) {
	const handler = createUiHandler({
		shell: "desktop",
		token: randomBytes(24).toString("hex"),
		baseUrl: baseUrl || process.env.CATALYST_Q_BASE_URL || undefined,
		fetch: fetch ?? ((...args) => net.fetch(...args)),
		getKey: async () => (await readStoredKey()) || process.env.CATALYST_Q_KEY || null,
	});
	protocol.handle(SCHEME, (request) => handler(request));
	ipcMain.handle("key:save", (event, key) => (fromThisApp(event) ? saveKey(key) : { ok: false, detail: "Not allowed." }));
	ipcMain.handle("key:clear", async (event) => {
		if (!fromThisApp(event)) return { ok: false, detail: "Not allowed." };
		await rm(keyPath(), { force: true });
		return { ok: true };
	});
	session.defaultSession.setPermissionRequestHandler((_contents, permission, respond) => respond(permission === "clipboard-sanitized-write"));
}

export function createWindow({ show = true, width = 1180, height = 860 } = {}) {
	const window = new BrowserWindow({
		width,
		height,
		minWidth: 420,
		minHeight: 560,
		show,
		title: "Catalyst-Q",
		backgroundColor: "#e9f0e1",
		webPreferences: {
			preload: join(here, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webviewTag: false,
			spellcheck: true,
		},
	});
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https:\/\//.test(url)) shell.openExternal(url);
		return { action: "deny" };
	});
	window.webContents.on("will-navigate", (event, url) => {
		if (url !== ORIGIN && !url.startsWith(`${ORIGIN}/`)) event.preventDefault();
	});
	window.loadURL(`${ORIGIN}/`);
	return window;
}

if (process.env.CATALYST_Q_DESKTOP_NO_AUTOSTART !== "1") {
	if (!app.requestSingleInstanceLock()) app.quit();
	app.whenReady().then(() => {
		setUpShell();
		createWindow();
		app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
	});
	app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
}
