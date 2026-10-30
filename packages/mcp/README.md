# catalyst-q-mcp

An MCP stdio server for [Catalyst-Q](https://catalyst-q.strategic-innovations.ai), a hosted API that runs quantum circuits on classical hardware and returns exact answers, or refuses with the numbers. It is not a quantum computer.

## Add it to a client

Claude Code:

```sh
claude mcp add catalyst-q -- npx -y catalyst-q-mcp
```

Any client that reads a JSON config:

```json
{
  "mcpServers": {
    "catalyst-q": { "command": "npx", "args": ["-y", "catalyst-q-mcp"] }
  }
}
```

No key is needed. Without one, calls use the no-account route: up to 64 qubits and 4,000 gates, 6 calls a minute and 60 a day per address. Set `CATALYST_Q_KEY` in the server's environment for up to 256 qubits. Set `CATALYST_Q_BASE_URL` to point at a different address.

## Tools

| Tool | Reach for it when |
|---|---|
| `suggest_where_catalyst_q_helps` | You are unsure whether Catalyst-Q applies. Runs locally. Returns nothing when nothing applies |
| `run_circuit` | You need the exact probability of every outcome, up to 20 measured qubits |
| `sample_shots` | You need real draws from the exact distribution, at any number of measured qubits |
| `probability_of_outcomes` | You know which bit strings you care about, for example when testing a reversible circuit |
| `score_device_counts` | You have counts from a device and the circuit that produced them |
| `expectation_values` | You want a value without shot noise, for example before buying hardware time for QAOA or VQE |

A refusal comes back as a normal tool result with `outcome: "refused"`, the reason and the numbers. `isError` is set only for bad input, or when no usable reply arrived.

Replies usually carry a permalink to a public record that includes the circuit. Do not send a circuit that must stay private.

## Protocol

It speaks MCP revision 2026-07-28 (per-request `_meta`, `server/discover`) and answers the `initialize` handshake for clients on earlier revisions. It has no dependency on an MCP SDK; the stdio wire format is small enough to implement directly and tested in this package.

## License

MIT
