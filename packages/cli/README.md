# catalyst-q-cli

The commands behind `npx catalyst-q`. [Catalyst-Q](https://catalyst-q.strategic-innovations.ai) is a hosted API that runs quantum circuits on classical hardware and returns exact answers, or refuses with the numbers. It is not a quantum computer.

```sh
npx catalyst-q suggest .                       # Where could this help? Runs locally.
npx catalyst-q run bell.qasm --measure 0,1     # The exact probability of every outcome.
npx catalyst-q sample wide.qasm --shots 1000   # Real draws from the exact distribution.
npx catalyst-q score bell.qasm counts.json     # Compare device counts with the circuit.
npx catalyst-q ui                              # The same tools as a local web page.
```

`npx catalyst-q` resolves to the `catalyst-q` client package, whose launcher starts this one. `npx catalyst-q-cli` does the same thing directly.

Add `--json` to get the service's reply as JSON, and `--base-url` to use a different address. Set `CATALYST_Q_KEY` to use your account.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | An answer |
| 10 | A refusal, printed on stdout with its reason and numbers. It is a normal result, and scripts may want to branch on it |
| 1 | No usable reply from the service, or a usage mistake |

## License

MIT
