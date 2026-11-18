# 10-Minute Reconstruction Drill (E-05)

Goal: from one operator question, rebuild the decision and execution chain of an
AI-initiated operation in under ten minutes, without reading model transcripts.

## Procedure

0. If the operation came from a goal (the agent decomposed a task into steps),
   start on the goal side instead of guessing which command ran:

```sh
bkagent goal show --db /var/lib/backup-agent/control.db --goal <goalId>
bkagent goal diagnose --db /var/lib/backup-agent/control.db --step <stepId>
```

`goal show` returns the step list, every attempt with its exit code, error class
and stable signature, and the diagnosis; each attempt records the `planId` it
dispatched. Continue with step 2 using that `planId`.

1. Take the `planId` from the tool result (every `bkagent backup|restore` output
   includes it).
2. Run:

```sh
bkagent trace --db /var/lib/backup-agent/control.db --plan <planId>
```

The result contains:

- the `Plan` payload (engine, provider, target, fingerprint, Step DAG, risk);
- the `Attempt` (state, timestamps, exit code, error class);
- the `Artifact` (path, size, verification level, protection flag);
- lineage edges recorded for the plan.

3. For a ticket-level view:

```sh
bkagent trace --db /var/lib/backup-agent/control.db --ticket <ticketId>
```

This adds the ticket state, the Mandate (principal, scope, policy version,
allowed risk) and every plan/attempt/artifact under the ticket.

4. Cross-check with `bkagent report --db ... --since 1d` and, for integrity,
   `bkagent verify --dsn ... --input <artifact path>`.

## Acceptance

- One command returns plan, attempt, artifact and lineage.
- For a goal-dispatched run, the goal, its steps and the diagnosis are reachable
  without the model transcript, and each step attempt names its `planId`.
- The Mandate identifies the initiating principal and the policy version.
- No step requires reading the model conversation.
- Credentials never appear in the output.

## Notes

- `trace` is read-only and works offline.
- If lineage is empty, the plan predates lineage recording; the plan/attempt/
  artifact fields still reconstruct the chain.
