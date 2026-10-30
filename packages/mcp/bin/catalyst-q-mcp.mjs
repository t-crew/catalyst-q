#!/usr/bin/env node
import { CatalystQ } from "catalyst-q";
import { createServer, serveStdio } from "../src/server.mjs";

const client = new CatalystQ({ baseUrl: process.env.CATALYST_Q_BASE_URL || undefined });
serveStdio(createServer({ client }), process.stdin, process.stdout);
