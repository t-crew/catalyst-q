# Catalyst-Q desktop

A thin Electron shell around the page in `packages/ui`, the same one `npx catalyst-q ui` serves.

```sh
npm install           # from the repo root
npm run desktop
```

The first screen asks what you are trying to do. The advisor answers as you type, on your computer. The run view takes a circuit, shows the outcomes as a bar chart, explains a refusal with its numbers, and copies the permalink. The score view compares counts from a device with the exact distribution of the circuit you ran. With no connection it says it is offline, and nothing runs.

## How it is locked down

- The page has no Node access: `contextIsolation`, `sandbox`, and no `nodeIntegration`.
- A strict Content Security Policy allows scripts, styles and fonts from the app itself, and nothing inline.
- It uses a custom protocol, so it opens no network port.
- The page never sees your API key. You hand it over once, Electron's `safeStorage` encrypts it with your operating system's keychain, and the main process uses it for requests. If no keychain is available, the key is not saved.
- Links open in your browser, and only over https. The window does not navigate anywhere else.

## Screenshots

`npm run screenshots -w catalyst-q-desktop -- docs/screenshots` launches the real app and saves what it shows. With no `--base-url` it talks to an address nothing listens on, so those shots show the advisor and the offline state.

To capture real answers, point it at the service. This makes three real calls, and the circuits it sends go into public records:

```sh
npm run screenshots -w catalyst-q-desktop -- docs/screenshots --base-url https://catalyst-q.strategic-innovations.ai
```

Packaged installers are not built here yet.
