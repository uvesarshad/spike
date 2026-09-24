# Contributing to Spike

Thanks for looking at Spike. This is a small project (one core engine, two
transports, a Chrome extension) — the bar for contributing is: it builds,
it typechecks, and the test suites you touched still pass.

## Dev setup

```
npm install
npm run build
```

`npm run build` runs `tsup` (plus the lite config) and produces `dist/cli.js`
and `dist/mcp-server.js` — most suites (and the CLI itself) expect a fresh
build before you run them.

Requires Node 20+ and, for anything that drives a real browser, desktop
Chrome 138+ (148+ for multimodal Nano). `docs/overview.md` has the full
architecture tour — read it before making any non-trivial change.

### Running from a source checkout

There is no `spike` on your PATH until you link it, so either run
`node dist/cli.js <command>` (every command in the README works this way), or
`npm link` once to get a `spike` command that follows your build.

Try it against the built-in fixture app (an intentionally broken shop):

```
node dist/cli.js fixture --bug on        # terminal 1
node dist/cli.js run "log in as test@test.com with password pw and complete checkout" \
  --url http://localhost:9401/login      # terminal 2
```

To register your checkout with a coding agent, use the built server directly
(no global install needed):

```
claude mcp add spike -- node /path/to/repo/dist/mcp-server.js
```

Optional $0 on-device model: `node dist/cli.js nano --check`, then `nano --download`.
On Windows use PowerShell with the same commands (line continuation is a backtick).

## Before you open a PR — the gate sequence

Run these **in order**, locally, as a manual pre-release gate. This is not
what CI runs (CI currently covers typecheck/build/`npm test` only — the
Chrome-dependent suites are deliberately kept out of CI and are a local
gate you run yourself):

```
npm run typecheck     # tsc --noEmit — strict TS, no Chrome needed
npm test               # fast suites: node scripts/run-tests.mjs (pure/in-memory, no Chrome)
npm run test:browser   # browser suites: node scripts/run-tests.mjs --browser (needs real Chrome)
```

Notes on each step:

- `npm run typecheck` — must be clean before anything else; the project
  leans on the compiler to enforce the port/adapter/rung seams described in
  `docs/overview.md`.
- `npm test` — runs the fast bucket (`test/` suites that don't need Chrome —
  currently around three dozen `v*.ts`/`m4.router.ts` files; run
  `node scripts/run-tests.mjs --list` to see the exact current split between
  fast and browser suites). These are pure/in-memory and should pass on a
  machine with no Chrome installed.
- `npm run test:browser` — runs the suites that need a real Chrome instance
  (`m1`, `m2`, `m5`, `m6`, the `e2e.*` suites, extension/bridge suites, and
  more — again see `--list` for the live set). Only run this if your change
  touches browser control, the driver loop, the extension, Nano, or the
  recorder/replay path — but do run it before a release-shaped PR even if
  you think your change is unrelated, since these are the suites that
  actually exercise CDP.
- If your change affects the full-stack oracle behavior (pass/fail
  discrimination against the fixture app), also run `npm run test:e2e`.
- Never run `spike daemon --install-service` as part of testing — it
  registers a real OS-level autostart entry that persists beyond the
  session.

If a suite needs something you don't have locally (no Chrome, no API key,
no `claude`/`codex` CLI on PATH), say so in the PR description rather than
skipping it silently — several suites (e.g. `m4.router.ts`'s live half)
already degrade to a SKIP rather than a FAIL when a dependency is missing,
and that's fine to note as-is.

## Doc-update expectations

This repo treats `docs/` as a first-class, agent-navigable artifact — the
same expectations apply whether you're a human or an AI agent making the
change. `AGENTS.md` (read it) sets the actual rule:

1. Read `docs/overview.md` before doing anything else — it's the mental
   model: stack, architecture, data flow, module map, glossary.
2. Read the relevant module doc in `docs/modules/` if one exists for the
   area you're touching.
3. Make the change.
4. Run the update decision tree against the change — look for `AGENT
   UPDATE:` tags in the doc files affected by what you changed, and update
   those files.
5. Output a "DOCS UPDATED" summary in your PR description (which docs you
   touched, or a note that none applied).

`AGENTS.md` also documents doc-file tag conventions worth knowing while you
read: `AGENT NOTE:` (a constraint to follow), `AGENT SEE:` (cross-reference),
`AGENT AVOID:` (anti-pattern), `AGENT UPDATE:` (docs to update when this area
changes), `AGENT OWNER:` (the module/file that owns a concept). If a `docs/`
file would exceed 200 lines after your edit, split it and update
`docs/overview.md`'s index accordingly.

A few hard rules from `AGENTS.md` worth restating since they trip people up:

- Never import from `spikes/` in `src/` — `spikes/` is frozen reference code.
- Never hardcode `'gemini'` as the Google CLI binary name — use the
  config-driven `googleCliBin`.
- Never run Chrome in headless mode — Gemini Nano requires a headed,
  secure-context Chrome.
- Never store API keys in `SettingsStore` (`src/vibe/settings.ts`) — keys
  belong in the Vault only.
- Never add an environment variable without updating
  `docs/infra/environment.md`.
- Never change `BrowserPort` without updating both implementations
  (`CdpBrowser` and `ExtensionBrowser`).

## PR checklist

Use the PR template — it mirrors the gate sequence above (which of
typecheck/test/test:browser you ran) and asks what docs you updated.

## Commit style

Commit messages in this repo generally follow `type(scope): summary`
(e.g. `fix(v0.2): …`, `feat(v0.2): …`) — look at `git log` for recent
examples before writing yours.
