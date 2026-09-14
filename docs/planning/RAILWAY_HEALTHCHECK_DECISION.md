# Decision: Railway healthcheckPath stays `/health`

**Date:** 2026-09-14  
**Verdict:** **DO NOT** repoint to `/ready`  
**Card:** t_8e226375 (Stark architect pass)

## Recommendation

Keep `railway.json` → `deploy.healthcheckPath: "/health"`.  
Leave `/ready` as monitoring/alerting only. No Railway dashboard change required
(path is already set in-repo).

## /health vs /ready

| | `/health` | `/ready` |
| --- | --- | --- |
| Purpose | Process liveness | DB readiness + pool + RLS role report |
| DB touch | None | `pool.connect` + `SELECT 1` + `pg_roles` |
| Failure | Essentially never (sync 200) | **503** when DB unreachable / checkout fails |
| Railway role today | Deploy-time promote gate | None (ops curl / status board) |

Railway healthchecks run **only at deploy time** (not continuous after live).  
`ON_FAILURE` restart policy tracks process exit, not HTTP probes.

## Failure modes if repointed to `/ready`

1. Transient DB blip during deploy window → promotion blocked; good code stuck failed.
2. Emergency deploy during DB maintenance impossible until DB recovers.
3. False sense of safety: `/ready` does not prove migrations applied (half-land still possible).
4. Couples shipability to shared dependency already used by the previous revision.

## Narrow case `/ready` would catch

Wrong `DATABASE_URL` (or pool config) **only on the new deployment's env** while old
revision still has a working URL. Rare; cheaper to catch with post-deploy
`curl …/ready` than to tax every promote.

## Instead

- Post-deploy: `curl -sS "$BACKEND/ready"` + `npm run status -- --env prod --deep`
- Continuous: external probe on `/ready` (see `docs/operations/ALERTS.md`)
- Migration half-land: compare prod `schema_migrations` head to repo files

Canonical write-up: `docs/planning/RESOLVED.md` (2026-09-14 Railway healthcheck decision).
