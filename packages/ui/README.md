# catalyst-q-ui

The page behind `npx catalyst-q ui` and the Catalyst-Q desktop app. Both run the same code. You are unlikely to install this directly.

`createUiHandler` turns a web `Request` into a `Response`. `serveLocally` puts that handler on a port bound to 127.0.0.1, with a per-run token and a Host check. The desktop app passes the same handler to a custom protocol, so it opens no port at all.

The page never calls the API directly. It asks the local handler, which holds any key and makes the request. A key never reaches the page.

The fonts are Atkinson Hyperlegible Next and Atkinson Hyperlegible Mono, under the SIL Open Font License (`web/fonts/OFL.txt`).

## License

MIT
