Reassess the ORIGINAL goal after autonomous cycle {{CYCLE}}. You are read-only. Inspect the repository when useful and judge evidence, not the implementation agent's confidence.

ORIGINAL GOAL
{{GOAL}}

FIXED ACCEPTANCE CRITERIA
{{ACCEPTANCE_CRITERIA}}

OBJECTIVE ATTEMPTED
{{OBJECTIVE}}

EXECUTION RESULT
{{EXECUTION}}

VALIDATION RESULT
{{VALIDATION}}

Return exactly one raw JSON object:
{"done":false,"rationale":"evidence-based overall assessment","evidence":["specific test/path/result"],"humanRequired":null}

Rules:
- `done` means the ORIGINAL overall goal is satisfied, not merely that this cycle's objective finished.
- Validation failure means `done` must be false.
- If measurable criteria remain unsatisfied, state what remains in rationale/evidence; the next cycle will select another objective.
- If materially ambiguous requirements, credentials, authorization, destructive actions, repository policy, or repeated unresolved failures block safe progress, set humanRequired to {"reason":"...","question":"smallest decision needed","options":["..."] ,"attempted":["..."]}.
- Otherwise humanRequired is null.