Execute this ONE bounded objective in the current shared working directory.

ORIGINAL GOAL
{{GOAL}}

CURRENT OBJECTIVE
{{OBJECTIVE}}

FIXED ACCEPTANCE CRITERIA
{{ACCEPTANCE_CRITERIA}}

CONTROLLER RATIONALE
{{RATIONALE}}

READ-ONLY COLLABORATOR PLANS
{{COLLABORATOR_PLANS}}

CURRENT OBSERVATION
{{OBSERVATION}}

Rules:
- Inspect current state first; preserve existing changes.
- Modify only what is needed for this objective.
- Do not create worktrees or alternate checkouts.
- Do not launch background/detached processes.
- Do not perform external service actions or irreversible/destructive operations.
- Use bounded local validation where useful, but the harness will independently validate afterward.
- If blocked by credentials, authorization, ambiguous product requirements, repository safety policy, or an irreversible action, make no unsafe workaround; report the blocker.

Return a concrete report containing changed paths, validation/evidence, remaining risks, and handoff.