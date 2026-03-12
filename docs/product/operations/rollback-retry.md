# Rollback and Retry Playbook

## Retry Rules
- Use `onError: "retry"` for transient external dependencies.
- Limit retries to 2-3 attempts to avoid runaway loops.
- Log retry attempts via workflow progress and audit entries.

## Rollback Rules
- Roll back at the workflow-template level, not ad hoc per run.
- Keep previous known-good template JSON in version control.
- If approval or handoff workflow is affected, stop downstream publication first.

## Standard Rollback Steps
1. Disable new runs for failing template.
2. Re-point automation to previous template revision.
3. Run one verification execution in staging/safe workspace.
4. Resume production runs.
5. Document rollback reason and prevention step.
