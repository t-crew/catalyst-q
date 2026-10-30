// Starting points. These are circuits, not results: pick one and it runs against the real service like any other.
export const EXAMPLES = [
	{
		id: "bell",
		name: "A Bell pair",
		qasm: "OPENQASM 3.0;\nqubit[2] q;\nh q[0];\ncx q[0], q[1];\n",
		measure: "0,1",
	},
	{
		id: "ghz",
		name: "GHZ on 5 qubits",
		qasm: "OPENQASM 3.0;\nqubit[5] q;\nh q[0];\ncx q[0], q[1];\ncx q[1], q[2];\ncx q[2], q[3];\ncx q[3], q[4];\n",
		measure: "0,1,2,3,4",
	},
	{
		id: "tgate",
		name: "H, T, H on one qubit",
		qasm: "OPENQASM 3.0;\nqubit[1] q;\nh q[0];\nt q[0];\nh q[0];\n",
		measure: "0",
	},
	{
		id: "toffoli",
		name: "A Toffoli with both controls set",
		qasm: "OPENQASM 3.0;\nqubit[3] q;\nx q[0];\nx q[1];\nccx q[0], q[1], q[2];\n",
		measure: "0,1,2",
	},
];

export const GOAL_STARTERS = [
	"Check the counts from my hardware run",
	"Plan a QAOA run before I pay for device time",
	"Reproduce a figure from a quantum paper",
	"Test a reversible adder on inputs I choose",
];
