# AGENTS.md

> Instructions for AI coding agents working on this repository.

## Project Overview

**lumira** — Cross-platform terminal statusline for Claude Code & Qwen Code.

- **Type:** TypeScript CLI tool (statusline renderer)
- **License:** MIT
- **Node:** >= 22.14.0

## Setup & Dev Environment

```bash
# Install dependencies
npm install

# Verify build
npm run build

# Run all tests
npm test

# Check coverage
npm run test:coverage
```

## Build, Lint, and Test

```bash
# Compile TypeScript
npm run build

# Run tests (Vitest)
npm test

# Tests with coverage report
npm run test:coverage

# Lint
npm run lint
```

**Important:** Agents will automatically attempt to run these commands and fix failures before marking a task complete. Always run `npm test` after making changes.

## Code Style

- **TypeScript:** Strict mode, no `any` except for platform detection in renderers
- **Naming:** `camelCase` functions, `PascalCase` types
- **Formatting:** Handled by ESLint automatically
- **Imports:** `.js` extension on relative imports
- **No unnecessary additions:** Don't add features or error handling beyond what's asked
- **No comments in code** unless logic isn't self-evident

## Testing Instructions

- **Framework:** Vitest (`npm test`)
- **Coverage target:** 90%+ line coverage (`npm run test:coverage`)
- **Fixtures:** `tests/fixtures/` contains real JSON payloads from Claude & Qwen
- **Rule:** Add or update tests for the code you change, even if nobody asked
- **Fix procedure:** If a test fails, fix the code or the test until the whole suite is green before committing

## Security Considerations

- **Never commit secrets, API keys, or tokens** — tests use mock data only
- **No hardcoded credentials** in source code or config files
- **Statusline commands run locally** — no network calls, no external services
- **Input from stdin is untrusted** — always handle parse errors gracefully

## PR & Commit Guidelines

- **Branches:** `main` (stable), `develop` (integration), `feat/*`, `fix/*`
- **Commits:** One concern per commit, imperative mood ("feat: add Qwen support")
- **PRs:** Merge to `develop` via squash merge
- **Pre-commit:** Always run `npm test` and `npm run build` before committing
- **PR title format:** `type(scope): description` (conventional commits)

## Deployment

Releases are fully automated by `.github/workflows/release.yml`. The workflow
triggers when a `release/vX.Y.Z` branch is merged into `main`, then:
parses the version from the branch name → creates the git tag → publishes
the GitHub Release with notes from CHANGELOG.md → runs `npm publish`.

**Release process:**
1. Branch from `develop` → `release/vX.Y.Z`
2. Bump `package.json` version and move the `[Unreleased]` changelog entries
   into a new `[X.Y.Z] - YYYY-MM-DD` section. Update the compare links.
3. Open PR against `main` and use `--merge` (not squash — preserves branch
   name for workflow detection).
4. CI takes over: tag + GitHub Release + npm publish happen automatically.
5. **Post-release: merge `main` back into `develop`.** This is mandatory —
   without it, `develop` keeps the old version and stale changelog, and the
   *next* release branch will conflict on every file touched since.
   ```bash
   git checkout develop && git pull
   git merge origin/main --no-edit && git push
   ```

## Guardrails

- **No platform-specific branching in renderers** — use feature detection, not platform identity
- **`normalize()` is the single source of truth** for platform differences
- **No `as any` anywhere**. Use union types (`RawInput`), type guards (`isQwenInput()`), or normalization to handle platform differences.
- **Keep AGENTS.md updated** — stale instructions cause agents to execute outdated steps

## References

- [README.md](README.md) — User-facing documentation
- [CONTRIBUTING.md](CONTRIBUTING.md) — Human contributor guide
- [CHANGELOG.md](CHANGELOG.md) — Version history
