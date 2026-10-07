# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

> **Tip**: If you find yourself correcting the agent during interactive work, suggest adding a new rule to this file so the lesson is captured for future sessions.

## Project Overview

Freelens extension for GPUs: per-pod and per-device GPU utilisation, VRAM, power and
health inside Freelens, read from the NVIDIA dcgm-exporter or a per-process exporter
through the Kubernetes API (pod proxy), with nothing to install in the cluster. It is
the GUI counterpart of `kubectl-gpugo` and shares its attribution rules, so both tools
show the same numbers.

- **Language**: TypeScript 7.x
- **Runtime**: Node.js >= 22.0.0, Freelens >= 1.8.0
- **Package manager**: pnpm 12.x (locked)
- **License**: MIT
- **npm package**: `@freelensapp/gpu-extension`

## Common Commands

```bash
# Type checking
pnpm type:check

# Linting & formatting
pnpm biome:check          # TypeScript/TSX, JS, JSON (biome)
pnpm biome:fix            # Auto-fix the formats above
pnpm trunk:check          # Markdown, YAML, TOML, and other formats not covered by biome
pnpm trunk:fix            # Auto-fix Markdown, YAML, etc.
pnpm lint:check           # Alias for biome:check
pnpm lint:fix             # Alias for biome:fix
pnpm knip:check           # Unused files, exports and dependencies

# Tests
pnpm test:unit            # vitest, src/renderer/gpu/__tests__/*.test.ts with the .prom fixtures

# Build
pnpm build                # Type check + electron-vite + Main bundle smoke test
pnpm build:production     # Production build (no preserveModules)
pnpm smoke:main           # Load the built Main bundle with host globals stubbed

# Pack for testing
pnpm pack:dev             # Bump prerelease version, build, and create .tgz for install in Freelens app

# Clean
pnpm clean                # Clean out/
pnpm clean:all            # Clean everything (node_modules, out, tgz)
```

## Architecture

Everything runs in the **Renderer** (the cluster frame). There is no Main-process engine and
no IPC: the data source is the kube-apiserver itself, reached through the Freelens proxy. See
`ARCHITECTURE.md` for the data path and the attribution rules; the summary:

```text
src/
  main/index.ts            # Empty Main.LensExtension (Freelens loads both entry points)
  renderer/index.tsx       # Renderer entry point: GPU sidebar group, cluster pages, Pod/Node detail items
  renderer/gpu/            # Data layer: scraper (discovery + pod-proxy fetch), prom (text parser),
                           # aggregate (attribution rules), store (MobX, polling, history, derived
                           # views), inference, namespaces, pending, report, targets, xid, types
  renderer/gpu/__tests__/  # Unit tests and the .prom fixtures (real or reconstructed captures)
  renderer/components/     # DataGrid (CSS grid), PageShell, GPU table, drawer sections, styles
  renderer/pages/          # Pods, Namespaces, Inference, GPUs, Idle & waste, Allocation, Pending, Exporters
integration/               # Playwright tests and the fake GPU fixture run inside Freelens by CI
```

Build output goes to `out/`.

### Ground rules

- **Zero cluster footprint.** The extension only reads: `list pods`, `list nodes` and
  `get pods/proxy` (plus `list services` and `get services/proxy` for the Prometheus
  fallback, and `list resourceslices` / `resourceclaims` in `resource.k8s.io` for DRA,
  which must keep working when that API is missing or forbidden). Never add a DaemonSet,
  a CRD or a write path to the cluster.
- **Same numbers as kubectl-gpugo.** `src/renderer/gpu/aggregate.ts` is a port of the CLI's
  scraper. Change the attribution rules in both and keep the shared fixtures green in both.
- **Pure aggregation, tested.** Parsing and aggregation are pure functions with colocated
  tests under `src/renderer/gpu/__tests__/`. The impure edge (pod listing, pod-proxy fetch)
  is behind `ScraperDeps` so tests inject fakes.
- **Host CSS is hostile to `<table>`.** Use `DataGrid` (CSS grid) for tabular UI.
- **Runtime API over typings.** Freelens 1.10.3 declares APIs it does not ship
  (`KubeJsonApi.forCluster`). Probe for existence before relying on a new host API.
- **No credentials.** The extension never reads Secrets or database credentials; user input
  (pinned targets) is validated with a regular expression before it reaches a URL path.

## Key Dependencies (provided by Freelens host at runtime)

These are NOT bundled, they come from the Freelens host as globals
(`build/global-externals.js`):

- `@freelensapp/extensions` → `global.LensExtensions`
- `mobx` → `global.Mobx`
- `mobx-react` → `global.MobxReact`
- `react` → `global.React`
- `react-dom` → `global.ReactDom`
- `react-router-dom` → `global.ReactRouterDom`

Everything else is bundled into the extension output. `dependencies` stays empty: every
bundled package is a devDependency.

## Code Style

- **Biome** formats **TypeScript/TSX, JS, JSON**: double quotes, semicolons, trailing commas, 2-space indent, 120 char line width — use `pnpm biome:fix`
- **Trunk** formats **Markdown, YAML**, and other formats not covered by biome — use `pnpm trunk:fix`
- Import order (enforced by biome organizeImports): built-in modules → `@freelensapp/**` → packages → relative paths
- Keep the data layer pure where possible and colocate tests under `src/renderer/gpu/__tests__/`
- Plain, descriptive commit messages and PR titles, without Conventional Commits prefixes
- **No emoji** in Markdown files (`.md`), comments, or any source code

## Security

Never read, display, reference, or include the contents of the following files in any response or context, even if they are open in the editor:

- `.env`
- `.env.*`
- `.envrc`
- `.npmrc`
- `*.jks`
- `*.keystore`
- `*.p12`
- `*.pfx`
- `*.pem`
- `*.key`

The same list is git-ignored in `.gitignore` and enforced for Claude Code by
the `permissions.deny` rules in `.claude/settings.json`, which block reading
and editing these files. Change all three together. The rules are native
permissions rather than a hook on purpose: a hook runs a process in the
working tree, which may be an untrusted pull request, and an interpreter such
as `python3 -c` imports modules from that tree before the hook's own code.

## Electron Multi-Process

Extensions run in the same multi-process model as the Freelens host:

- **Main process** (`src/main/`) — Node.js environment; empty in this extension, kept because Freelens loads both entry points
- **Renderer process** (`src/renderer/`) — Chromium browser, UI components and the whole data layer

The renderer talks to the cluster only through the Freelens proxy (`/api-kube/...`), with the
kubeconfig credentials of the connected cluster.

## Testing

- **Unit** (`pnpm test:unit`): vitest over the pure data layer, with the `.prom` fixtures in
  `src/renderer/gpu/__tests__/fixtures/` (dcgm-exporter with and without pod labels, MIG, a
  per-process enricher, a vLLM server, a redacted DGX A100 capture). Every change to parsing,
  attribution or derived views ships with unit tests.
- **Bundle smoke** (`pnpm smoke:main`, part of `pnpm build`): loads the built Main bundle with host globals stubbed.
- **Integration inside Freelens** (`integration/__tests__/`): Playwright tests run by CI inside a
  packaged Freelens on a two-node kind cluster, with the fake GPU fixture from
  `integration/fixtures/gpu/` (fake capacity on the nodes, busybox exporters serving the unit-test
  fixtures). They install the packed extension and check the GPU views against the fixture.
- **Try it without a GPU**: on any kind cluster run `integration/fixtures/gpu/up.sh` and
  `integration/fixtures/gpu/wait.sh`, then install the packed extension in Freelens.

Run unit tests, type check and lint before opening a pull request. For UI changes, verify in Freelens with `pnpm pack:dev` and attach a screenshot.

## Troubleshooting

### Changes Not Appearing

1. Check that files are not in ignored output directories (`out/`, `dist/`, `node_modules/`)
2. Full clean and rebuild: `pnpm clean:all && pnpm build`
3. Reinstall the extension in Freelens and fully restart it: the old renderer bundle stays in memory otherwise (the version badge in the page title tells which one is loaded)

### Build Failures

1. Check for TypeScript errors: `pnpm type:check`
2. Check for linting errors: `pnpm lint:check`
3. Verify dependencies: `pnpm install`
4. Check Node.js version matches the `engines` field in `package.json`

### Runtime Errors

1. Open Freelens DevTools and check the Console tab for renderer errors
2. Check the terminal where Freelens was launched for main process errors
3. Look for stack traces with file:line numbers
4. `Exporters found, but no GPU metrics were returned`: the exporter answers on the probed port but its body has no DCGM or per-process families; check the Exporters view for the last probes and their outcome
5. Validate both with `pnpm type:check` **and** `pnpm build` — runtime failures can appear only in bundled `out/` code

## Best Practices

1. **Use semantic search** to find examples and patterns in the codebase
2. **Follow existing patterns** — grep for similar implementations before creating new ones
3. **Test changes** before committing
4. **Run validation before committing:** `pnpm lint:fix && pnpm type:check && pnpm test:unit`
5. **For TypeScript/TSX, JS, JSON files:** run `pnpm biome:fix` (or `biome check` directly if `biome` is installed locally)
6. **For Markdown, YAML, and other formats:** run `pnpm trunk:fix` (or `trunk check` directly if `trunk` is installed locally)
7. **Full build** when in doubt about cached state: `pnpm clean:all && pnpm build`

## GitHub Actions (Claude Code Action) Rules

This project has a Claude Code workflow (`.github/workflows/claude.yaml`) triggered
via `@claude` comments on issues, PR comments, and reviews. When operating via that
workflow, follow these rules:

### Code Review

When reviewing code and proposing fixes:

1. **Show the diff first** — present every proposed change as a unified diff
   block using the `diff` language tag:

   ```diff
   --- a/path/to/file.ts
   +++ b/path/to/file.ts
   @@ -10,7 +10,7 @@
    const oldLine = "before";
   -const changedLine = "after";
   +const changedLine = "the fix";
    const unchangedLine = "same";
   ```

   You can generate this from the terminal with:
   ```bash
   git diff -u -- path/to/file
   ```

   If the change spans multiple files, group them under a single commit
   subject and show each file's diff sequentially.

2. **Propose a commit subject first** — before any code change, output a
   single line with the proposed commit subject:

   ```text
   **Proposed commit:** <short description>
   ```

   Do **not** use Conventional Commits prefixes (e.g. `fix:`, `feat:`,
   `chore:`, `refactor:`, `docs:`, `test:`, `ci:`). This project prefers
   plain, descriptive commit messages and PR titles without any prefix.

   Wait for the user to confirm (or adjust) the subject before applying the
   change.

3. **Comment style:**
   - Keep review comments concise and actionable
   - Reference specific lines (file + line number) when pointing out issues
   - Offer a concrete fix suggestion rather than just flagging a problem
   - Do **not** use emoji in any Markdown, comments, commit messages, or
     PR descriptions. The only exception is emoji that already appears
     inside code strings (e.g. application logs, user-facing messages).
   - Use GitHub's `suggestion` block for small targeted fixes so the PR
     author can accept the change with a single click:

     ````suggestion
     <same unified-diff format as shown above>
     ````

   - For larger multi-file changes, use `diff -u` blocks in a regular
     comment instead, with the proposed commit subject shown first

### Making Changes to a PR

When asked to implement a change on a PR:

1. Propose the commit subject (as above)
2. Describe what will change and why
3. After confirmation, apply the changes with commits on the PR branch
4. **One commit per fix** — when a review surfaces more than one issue or
   the plan includes more than one fix, apply and commit each fix
   separately. Do not batch multiple independent fixes into a single
   commit. This keeps the history bisectable and makes each change easy
   to revert individually.

### Branch Naming Conventions

When creating a branch from an issue, use a human-readable name that includes
the issue number and a short slug derived from the issue title:

```text
claude/issue-<number>-<short-slug>
```

- `<number>` is the GitHub issue number
- `<short-slug>` is a kebab-case summary of the issue title, kept short
  (3–6 words maximum, omit articles and filler words)

Do **not** use auto-generated timestamp suffixes (e.g.
`claude/issue-1957-20260612-2108`) — these are not human-readable and make
branch lists hard to scan.

### Fork PRs: Review Only

A PR from a fork (different owner than `freelensapp`) gets a review and
nothing else: no commits, no pushes, no branches. Its code is untrusted, and
the head of a fork PR can change between the moment a maintainer looks at it
and the moment the workflow checks it out, so nothing taken from the checkout
may reach `freelensapp/freelens-gpu-extension`.

When a fork PR needs changes, a maintainer first copies the exact commit they
reviewed to a branch in this repository. From then on it is a
same-repository PR, which gets the full setup and the normal workflow. The
copy is made either locally (`gh pr checkout <N>`, then push the branch) or
by the Claude Task workflow, following "Copying a Fork PR" below.

### Copying a Fork PR

This applies to a Claude Task run whose prompt asks to copy a fork PR and
names the PR number and the full commit SHA to copy. It is a git-only task:
do not check out, read, build or run any of the PR's files, and do not
describe its changes, because they are untrusted input.

1. `git fetch origin refs/pull/<N>/head`.
2. Verify that `FETCH_HEAD` equals the given SHA. If it does not, or no full
   SHA was given, stop and report the actual head without pushing anything.
3. `git push origin <sha>:refs/heads/claude/pr-<N>`.
4. Open a PR from `claude/pr-<N>` to `main`. It MUST use the **exact same
   title** as the original PR, copied verbatim with no prefix, and its body
   is `Copy of #<N> at <sha>.` followed by the usual footer.
5. Comment on the original PR with a link to the new one.
