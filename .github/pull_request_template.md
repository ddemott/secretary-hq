## Summary

<!-- One or two sentences describing what this PR does and why. -->

## Type of Change

- [ ] Feature (new functionality)
- [ ] Bug fix
- [ ] Refactor / cleanup (no behavior change)
- [ ] Documentation only
- [ ] Test addition / improvement
- [ ] Other: __________

## Related Work

<!-- Link to GitHub issue, previous PR, or branch name if applicable. -->

## Changes Made

- ...
- ...

## Testing

**Unit / Integration tests**
- [ ] All relevant unit tests pass (`npm test` or targeted vitest)
- [ ] New or modified tests include 5W comments (WHO/WHAT/WHEN/WHERE/WHY)

**E2E / Live QA (when applicable)**
- [ ] Relevant Playwright tests run and pass (use `--grep` for targeted execution)
- [ ] Live QA (`scripts/qa-live-test.py`) executed if voice/agent flows are involved

**Manual / Local verification**
- [ ] Ran locally with `npm start` + relevant flows
- [ ] Build succeeds (`npm run build` + dashboard build)
- [ ] Quality gates pass (`npm run checks`)

## Documentation

- [ ] `CLAUDE.md` updated (if new directories, commands, patterns, or principles were introduced)
- [ ] `docs/planning/TODO.md` / `RESOLVED.md` updated as appropriate
- [ ] Other relevant `*.md` files updated
- [ ] `npm run verify:claude-md` passes

## Checklist (from [docs/DEVELOPMENT_WORKFLOW.md](/home/dale/projects/secretary-hq/docs/DEVELOPMENT_WORKFLOW.md))

- [ ] All code is linted and formatted (`npm run lint && npm run format:check`)
- [ ] TypeScript is clean (root + dashboard)
- [ ] Build succeeds
- [ ] Relevant unit tests pass
- [ ] Relevant E2E tests pass (targeted with `--grep` where possible)
- [ ] All new/modified tests have proper 5W comments
- [ ] Documentation has been updated
- [ ] `npm run verify:claude-md` passes
- [ ] No `.only` or `.skip` left in test files
- [ ] No secrets or large binaries accidentally staged

## Screenshots / Recordings (if UI changes)

<!-- Add screenshots or short recordings for dashboard changes. -->

## Notes for Reviewer

<!-- Any context, risks, follow-up work, or areas that need extra attention. -->