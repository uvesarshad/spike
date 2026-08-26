# Security Policy

Spike drives a real browser with the Chrome `debugger` permission, edits files
on disk (auto-fix), and stores API keys and test secrets in an encrypted
on-device vault. That's exactly the kind of tool responsible-disclosure
reports exist for — please report privately rather than opening a public
issue.

## Reporting a vulnerability

**Preferred: GitHub Security Advisories.**
Open a private report at
https://github.com/uvesarshad/spike/security/advisories/new
This notifies the maintainer directly without creating a public issue, and
lets us collaborate with you on a fix before disclosure.

**Fallback: email.**
If you don't have (or don't want to use) a GitHub account, email
**uveskhan234@gmail.com** with a description of the issue, steps to
reproduce, and the affected version/commit. Please use a descriptive subject
line (e.g. `SECURITY: <short summary>`) so it isn't missed.

Please do not open a public GitHub issue for anything you believe is a
security vulnerability — that discloses it to everyone, including anyone
looking to exploit it, before a fix ships.

### What to include

- A clear description of the vulnerability and its impact.
- Steps to reproduce, or a minimal proof of concept.
- The affected component (CLI, extension, daemon/bridge, vault, auto-fix)
  and version/commit hash.
- Whether you believe it requires local access, a malicious page, a
  compromised model provider, or is remotely exploitable.

## Scope

Spike is a local-first tool: a CLI/daemon plus a Chrome extension. The
security-relevant surface is:

- **The extension's `debugger` permission.** The extension attaches to the
  Chrome DevTools Protocol to drive the page under test (navigate, click,
  type, capture screenshots, read the accessibility tree, and collect
  console/network activity). Bugs that let a malicious web page escalate out
  of the intended test target, or that let the extension be tricked into
  driving a page the user didn't intend, are in scope.
- **The WebSocket bridge and local daemon (Spike Core).** The daemon
  listens on `localhost` and exchanges JSON-RPC with the extension's service
  worker. Anything that lets a process other than the extension talk to the
  daemon, or lets the daemon be reached from outside the local machine, is
  in scope.
- **The encrypted vault (API keys and secrets).** API keys and
  `{{secret:NAME}}` values are stored in an on-device, AES-256-GCM-encrypted
  vault (Windows: key protected by DPAPI bound to the user account;
  otherwise a local key file). Anything that weakens that encryption, leaks
  a key/secret to a model provider or to disk in plaintext, or lets one
  local user read another's vault, is in scope.
- **Auto-fix file edits.** The auto-fix flow writes changes to files on
  disk based on a model's suggested fix. Anything that lets a crafted page,
  task description, or model response cause auto-fix to write outside the
  intended project directory, or to write attacker-controlled content
  without the user's awareness, is in scope.

Out of scope: vulnerabilities in a third-party AI model provider itself
(report those to the provider), and issues that require the attacker to
already have full local control of the machine running Spike (at that
point the local vault and files are already compromised by definition).

## `npm audit` findings

`npm audit` currently reports transitive vulnerabilities pulled in via
`@modelcontextprotocol/sdk`'s HTTP-transport dependencies. Spike only uses
the SDK's **stdio transport** (`spike mcp` starts a stdio MCP server) — the
HTTP transport code path that carries those vulnerabilities is never
imported or executed by anything in this repository. We consider these
findings unreachable at runtime and are tracking an SDK version bump to
clear them from the audit output rather than treating them as an active
risk. If you believe one of these is reachable through some path we've
missed, please report it through the channels above.

## Coordinated disclosure

We ask for **90 days** from your initial report before any public
disclosure, to give us time to investigate, fix, and release a patched
version. We'll acknowledge your report, keep you updated on progress, and
credit you in the release notes/advisory (unless you'd prefer to stay
anonymous). If a fix lands sooner, we're happy to coordinate an earlier
disclosure date with you.

## Supported versions

Spike is pre-1.0 and moving quickly. Security fixes are made against the
latest release on the default branch; there is no back-porting to older
tags at this stage.
