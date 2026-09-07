You are selecting ONE useful objective for cycle {{CYCLE}} of a bounded autonomous run.

ORIGINAL GOAL
{{GOAL}}

FIXED ACCEPTANCE CRITERIA SO FAR
{{ACCEPTANCE_CRITERIA}}

CURRENT OBSERVATION
{{OBSERVATION}}

CONFIGURED ROSTER
{{ROSTER}}

LIMITS / FAILURE MEMORY
{{LIMITS}}

Return exactly one raw JSON object with this schema:
{"objective":"smallest concrete next objective","rationale":"why this objective now","acceptanceCriteria":["measurable criterion"],"strategy":"single|collaborate","slotIds":["configured-slot-id"],"humanRequired":null}

Rules:
- If the run has no fixed acceptance criteria yet, derive reasonable measurable criteria for the ORIGINAL goal and put them in acceptanceCriteria. Do not change the user's goal.
- If criteria are already fixed, repeat those same criteria unless the observation proves one is impossible; if impossible, use humanRequired rather than silently changing it.
- `single` means one write-capable builder is enough. `collaborate` means multiple configured slots should reason read-only before one writer implements.
- slotIds may contain one slot, a useful subset, or the whole configured stack. Use exact roster ids only. Do not choose models by provider name.
- Prefer `single` for tiny mechanical work. Prefer `collaborate` for architecture, cross-cutting changes, ambiguity, or after failure evidence.
- Do not declare the overall goal done here; select the next objective. Overall completion is reviewed after validation.
- If safe progress genuinely requires a person, set `humanRequired` to {"reason":"...","question":"smallest decision needed","options":["..."] ,"attempted":["..."]} and otherwise use null.