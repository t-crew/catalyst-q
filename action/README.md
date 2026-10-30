# Catalyst-Q circuit check

On a pull request, this action finds the `.qasm` files that changed, runs them through the Catalyst-Q no-account route, and writes the exact results, or the refusal with its numbers, to the job summary. It needs no secret.

```yaml
name: Check circuits
on:
  pull_request:
    paths: ["**/*.qasm"]

permissions:
  contents: read

jobs:
  circuits:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: t-crew/catalyst-q/action@v1
```

Before you turn this on in a private repository: the circuits go to a hosted service, and replies usually carry a permalink to a public record that includes the circuit. Do not use it on circuits that must stay private.

## Post a comment as well

```yaml
permissions:
  contents: read
  pull-requests: write

# ...
      - uses: t-crew/catalyst-q/action@v1
        with:
          github-token: ${{ github.token }}
          comment: true
```

It updates its own comment on later pushes. A pull request from a fork gets a read-only token, so the comment is skipped with a warning and the summary still has the results.

## Score counts from a device

```yaml
      - uses: t-crew/catalyst-q/action@v1
        with:
          counts: results/run-42-counts.json
          counts-circuit: circuits/run-42.qasm
```

The counts file holds `{"00": 498, "11": 502}` or `{"counts": {...}}`, with classical bit 0 on the right.

## Inputs

| Input | Default | What it does |
|---|---|---|
| `github-token` | none | Needed only to post a comment |
| `comment` | `false` | Post the summary as a pull request comment |
| `paths` | none | Space-separated files to run instead of the changed files |
| `max-files` | `6` | The most calls to make. The no-account route allows 6 a minute. Files past this are listed as not run |
| `counts` | none | A counts JSON to score |
| `counts-circuit` | none | The `.qasm` file that produced the counts |
| `api-key` | none | A Catalyst-Q key, for circuits wider than the no-account route allows |
| `base-url` | the hosted service | API address |
| `fail-on-refusal` | `false` | Fail the job when a circuit is refused |
| `fail-when-unreachable` | `true` | Fail the job when no usable reply came back, because nothing was checked |

Outputs: `answered`, `refused`, `unreachable`.

A refusal does not fail the job unless you ask it to. It makes one call per file and never retries.

`vendor/catalyst-q.mjs` is a copy of the built client, so the action needs no install step. A test checks that it matches the source.
