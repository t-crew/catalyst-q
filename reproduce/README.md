# Reproduce every claim

Each script here checks one claim on [the Evidence page](https://catalyst-q.strategic-innovations.ai/bench). It asks the live service, computes the same answer a second way, and compares the two. The second way is Qiskit Aer, quimb, a formula, or ordinary arithmetic. None of it shares code with the service.

```sh
pip install -r requirements.txt
python run.py                # every claim
python run.py c4_scrambled   # one claim
```

Each line of output is one claim: the numbers, whether it passed, and whether its two controls behaved. A positive control is a correct answer that must pass the test. A negative control is a wrong answer that must fail it. If either control misbehaves, the claim counts as failed.

## Limits

Without a key you get the no-account route: 64 qubits, 4,000 gates, 6 calls a minute and 60 a day from one address. The script waits between calls. Set `CQ_SCALE=0.05` to run fewer circuits.

Claims 3, 4, 5, 9 and 10 go past those limits at full size. [Create a free key](https://catalyst-q.strategic-innovations.ai/account) and set `CATALYST_Q_KEY`.

The referee needs memory: 26 qubits takes about 1 GB, twice over, so `c4_scrambled` and `c10_distributed` want 3 GB free. `c10_distributed` also takes a few minutes in quimb.

## What these checks do not cover

Each claim prints what it leaves out in `not_checked`. A check with a referee is as strong as that referee and as wide as it can hold. We wrote these scripts as well as the service, so read them, and tell us when a control could not fail.

## Who can run the GitHub Action

GitHub lets only people with write access press "Run workflow" on this repository. The checks run here on a schedule, and the logs are public. To run them yourself on demand, fork the repository and run the workflow there.
