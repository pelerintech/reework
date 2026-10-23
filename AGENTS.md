# AGENTS.md

Guidance for contributors and coding agents working in this repo.

## Test quality policy

Tests must be **behavioral and integration-first**. A test should exercise real
behavior, flows, and public boundaries — not implementation detail. Avoid
trivial strategies such as checking that a file exists, that a line of text is
present, or that a symbol has a name; these assert nothing about behavior and
provide no value.

Prefer:

- Writing tests against a component's public API and observable outcomes.
- Driving flows end to end through the module's real entry points.
- Verifying state transitions and results, not internal call graphs.

## E2E policy

- **API** E2E is exercised in-process via Hono's `app.request()` harness — no
  separate server process, keeping API tests fast and hermetic.
- **TUI** E2E renders the real `AgentTui` with `ink-testing-library` against a real
  in-process agent (`@reework/core/testing`), types keys, and asserts on the rendered
  frames (`tests/tui-*.test.tsx`). TUI logic lives in `.ts` modules, which the coverage
  gate counts; `.tsx` views are exercised by these tests.
- **Web UI** main-workflow E2E uses Playwright. This is **forward policy**: the
  partner console (`packages/ui`) is not built yet, so no Playwright E2E runs yet.

## LLM boundary

Engine and server tests use a mock/fake provider at the LLM boundary (pi-ai's
`faux` provider), so tests are hermetic, fast, and CI-runnable with no real
model.

## Repo gates

- Conventional Commits via commitlint (`commit-msg` hook).
- Trunk-based workflow off `main`.
- `vp check` (format + lint + type-check) and `vp test` with a hard 85%
  coverage gate run in CI on every PR.
