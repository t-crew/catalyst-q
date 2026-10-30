# Registering Catalyst-Q upstream

This is the smallest change that would register the provider in [quantum-yardstick](https://github.com/t-crew/quantum-yardstick). It has not been applied there. The provider already works without it, by path (see [README.md](README.md)).

The provider adds no dependency and follows that repo's code style, as its CONTRIBUTING file asks.

## Steps

Copy the provider in, from a checkout of this repo:

```sh
cp yardstick/catalyst-q.js ../quantum-yardstick/providers/catalyst-q.js
```

Then apply this diff in the quantum-yardstick checkout:

```diff
--- a/providers/registry.js
+++ b/providers/registry.js
@@ -32,6 +32,7 @@
   braket: "./aws_braket.js",
   azure: "./azure_quantum.js",
   quantinuum: "./quantinuum.js",
+  "catalyst-q": "./catalyst-q.js",
 };
 
 export function list() {
--- a/cli.js
+++ b/cli.js
@@ -437,6 +437,8 @@
   console.log("    braket       AWS Braket (backend, AWS credentials)");
   console.log("    azure        Azure Quantum (workspace, backend)");
   console.log("    quantinuum   Quantinuum H-series (token, backend)");
+  console.log("\n  Hosted classical simulators:");
+  console.log("    catalyst-q   Catalyst-Q API (no key needed for small jobs; --key for more)");
   console.log("\n  Generic connectors (any backend):");
   console.log("    http         Any REST API (--url, --header)");
   console.log("    stdio        Any subprocess speaking JSON (--command)");
```

## Check it

```sh
node cli.js providers
node cli.js run --provider catalyst-q --benchmarks ghz --max 8
node test/test.js
```

The diff was checked against a copy of the harness on 2026-10-30. On that copy `node test/test.js` stops with a `ReferenceError` in `workflows/shor_factoring.js`, with or without this change, so that failure is not from this provider.
