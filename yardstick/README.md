# Catalyst-Q in Quantum Yardstick

[Quantum Yardstick](https://github.com/t-crew/quantum-yardstick) is an open benchmark harness. It defines circuits, checks answers against analytic ground truth, and reports correctness, width, throughput and efficiency. `catalyst-q.js` is a provider for it, so you can hold Catalyst-Q to that yardstick yourself.

It is one file with no dependencies.

## Run it

Clone the harness, then pass the provider by path:

```sh
git clone https://github.com/t-crew/quantum-yardstick
cd quantum-yardstick
node cli.js run --provider ../catalyst-q/yardstick/catalyst-q.js --benchmarks ghz --max 8
```

Use your account for anything larger:

```sh
export CATALYST_Q_KEY=cq_live_...
node cli.js run --provider ../catalyst-q/yardstick/catalyst-q.js --max 64
```

`--url` or `CATALYST_Q_BASE_URL` points it at a different address.

To register the provider by name in the harness itself, see [PATCH.md](PATCH.md).

## What to expect

- **No key means small runs.** The no-account route allows 6 calls a minute and 60 a day. The provider waits out a rate limit using the `retry-after` the service sends, so a run can be slow. The full suite makes more calls than one day allows, so run one benchmark at a time or use a key.
- **Refusals are recorded.** A refusal becomes an error on that benchmark at that width, with the service's code, detail and numbers. The harness stops counting that width. Run with `--json` to keep the record counts.
- **Throughput includes the network.** The harness times each call from your machine, so its throughput axis measures your connection as well as the service.
- **Efficiency reads zero.** The API does not report memory, so the provider leaves `memory_bytes` and `materialized` out. Do not read that axis as a measurement of Catalyst-Q.
- **Wide Grover circuits stop in the provider.** The harness asks for one multi-controlled Z across every qubit. The provider writes that out in smaller gates, and past a size limit it raises an error, so those widths say nothing about the service.

## Leaderboard

The harness has no leaderboard. It produces a report for each run, sealed with a content hash, and a `compare` command for providers you run yourself.

## Tests

`test/provider.test.mjs` runs offline with a mocked fetch. From the repo root: `npm test`.
