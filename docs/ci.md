# Testing every pull request

Spike can test the preview of every pull request and leave one comment on it that updates on each push: a results table, what is wrong, how many pages were looked at, and the spend cap. It uses the saved tests in your repo and/or a whole-site check.

Everything below runs `spike ci`; the GitHub Action (`uvesarshad/spike`) wraps it. Give it a model key as a repository secret (for example `GEMINI_API_KEY` or `ANTHROPIC_API_KEY`) and pass it in `env`. Saved recorded tests replay for $0 and need no key.

Result codes: 0 passed, 1 failed, 2 not sure, 3 Spike could not run (the address never came up, or nothing was selected).

## Vercel previews

Vercel reports each preview through a `deployment_status` event; the address is `environment_url`.

```yaml
name: Spike
on: deployment_status
permissions:
  contents: read
  pull-requests: write
jobs:
  spike:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: uvesarshad/spike@v1
        env:
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
        with:
          url: ${{ github.event.deployment_status.environment_url }}
          suite: true
          check: true
          budget: 2
```

## Netlify previews

Netlify also posts `deployment_status` when its GitHub integration is on. The setup is the same as Vercel; only the guard differs, because Netlify sends several statuses per deploy.

```yaml
name: Spike
on: deployment_status
permissions:
  contents: read
  pull-requests: write
jobs:
  spike:
    if: github.event.deployment_status.state == 'success' && github.event.deployment_status.environment_url != ''
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: uvesarshad/spike@v1
        env:
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
        with:
          url: ${{ github.event.deployment_status.environment_url }}
```

Previews often answer with an error for a minute after the "deployed" event. Spike waits up to three minutes for a 200 before it starts; use `wait-for-url` to wait on a different address (a health page, say).

## A local server on the runner

No preview host? Build and start the app on the runner and test that.

```yaml
name: Spike
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  spike:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci && npm run build
      - run: npm start &
      - uses: uvesarshad/spike@v1
        env:
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
        with:
          url: http://localhost:3000
          suite: true
```

## Inputs

| Input | Meaning |
| --- | --- |
| `url` | The address to test (required) |
| `suite` | Run every saved test (default `true`) |
| `check` | Also walk the site and look at each page (default `false`) |
| `budget` | Spend cap in dollars for the whole run (default `2`); the run stops early rather than go over |
| `wait-for-url` | Wait for this address instead of `url` |
| `version` | Which `spike-agent` version to run (default `latest`) |

The Action attaches the screenshots and reports as a `spike-artifacts` download on the run, and fails the check on a failure or a "not sure". The comment needs `pull-requests: write`; without it the check still runs and reports, it just cannot comment.

## Without the Action

```bash
npx spike-agent ci --url https://my-preview.example.com --suite --check \
  --budget 2 --summary spike.md --junit spike.xml
```

`--summary` writes the Markdown table (it also goes to the GitHub run page when `GITHUB_STEP_SUMMARY` is set), `--junit` writes a JUnit report for other CI systems.
