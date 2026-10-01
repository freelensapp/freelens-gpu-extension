# Publishing and releases

How this package reaches npm and GitHub Releases. Same flow as
[freelens-rabbitmq-extension](https://github.com/Tal-Naeh/freelens-rabbitmq-extension/blob/main/docs/publishing.md).

## Package requirements

1. **Scoped name you own**: `@tal-naeh/freelens-gpu-extension`. Only the npm user `tal-naeh` can publish it.
2. `publishConfig.access: "public"` — scoped packages are private by default.
3. `files: ["out/**/*"]` — only the built output ships (`LICENSE`, `README.md`, `package.json` always included).
4. `repository.url` points at the real GitHub repo — required for provenance.
5. `prepack` runs the build, so `pnpm pack` / `pnpm publish` always ship a fresh `out/`. (Never name a script `pack`;
   it shadows pnpm's built-in.)
6. Verify what will be uploaded: `pnpm publish --dry-run`.

## First publish (manual, once)

npm requires 2FA to publish. With a security key / passkey the CLI needs an interactive terminal (it prints an
`https://www.npmjs.com/auth/cli/…` URL to approve in the browser; non-interactive shells fail with `EOTP`).

```sh
cd ~/Documents/GitHub/freelens-gpu-extension
npm whoami                                   # tal-naeh
pnpm publish --access public --no-git-checks
npm view @tal-naeh/freelens-gpu-extension version
```

After this the package exists, which is a prerequisite for Trusted Publishing.

## Trusted Publishing (token-less CI)

On npmjs.com → package → Settings → **Trusted Publisher** → GitHub Actions:

| Field | Value |
| --- | --- |
| User / org | `Tal-Naeh` |
| Repository | `freelens-gpu-extension` |
| Workflow filename | `release.yaml` |
| Environment | `publishing` |
| Allowed actions | **staged only** |

`.github/workflows/release.yaml` runs on any `v*` tag: checks tag == `package.json` version → install → build (with the
Main smoke test) → `pnpm pack` → `npm stage publish --access public` with provenance → GitHub Release with the `.tgz`.
If an `NPM_TOKEN` secret exists it publishes directly instead of staging.

Staged versions are hidden until a human approves (this is where 2FA happens):

```sh
npm stage list @tal-naeh/freelens-gpu-extension
npm stage approve <stage-id>        # or Approve on the package's "Staged versions" page
```

## Release routine

```sh
pnpm bump-version 0.3.1                  # edits package.json
# update CHANGELOG.md, commit
git tag -a v0.3.1 -m "v0.3.1" && git push origin main v0.3.1
# CI: build → test → npm stage publish → GitHub Release with .tgz
npm stage approve <id>                   # → live
npm view @tal-naeh/freelens-gpu-extension dist-tags
```

Tags with a `-` (e.g. `v0.4.0-rc.1`) publish under the `next` dist-tag instead of `latest`.

## Installing

Freelens → `cmd`+`shift`+`E` → paste `@tal-naeh/freelens-gpu-extension` → Install → enable. Or download the `.tgz`
from GitHub Releases and drag it into the window. Upgrades: install the same name again, then fully restart Freelens —
the old renderer bundle stays in memory otherwise (the version badge in the page title tells you which one is loaded).
