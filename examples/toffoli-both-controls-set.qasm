// Set both controls. The target should flip, so outcome 111 should have probability 1.
OPENQASM 3.0;
qubit[3] q;
x q[0];
x q[1];
ccx q[0], q[1], q[2];
