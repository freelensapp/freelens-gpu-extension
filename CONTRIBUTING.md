# Contributing

Thanks for helping improve the Freelens GPU extension.

## Development setup

```sh
pnpm install
pnpm type:check && pnpm lint:check && pnpm knip:check && pnpm test:unit
pnpm pack            # prepack builds; writes the .tgz to install in Freelens (Extensions → path to .tgz)
```

Try it without a GPU: on any kind cluster run `integration/fixtures/gpu/up.sh` and `integration/fixtures/gpu/wait.sh`
(fake capacity on the nodes, busybox exporters serving the fixture files of `src/renderer/gpu/__tests__/fixtures/`),
then install the packed extension. Discovery and every view behave exactly as with the real DaemonSet. Any pod named
like `*dcgm-exporter*` that serves one of those files at `/metrics` works too.

## Ground rules

- **Zero cluster footprint.** The extension only reads: `list pods`, `list nodes` and `get pods/proxy`. Never add a
  DaemonSet, CRD or write path.
- **Same numbers as kubectl-gpugo.** `src/renderer/gpu/aggregate.ts` is a port of the CLI's scraper. Change the
  attribution rules in both, and keep the shared fixtures green in both repos.
- **Pure aggregation, tested.** Parsing and aggregation are pure functions with colocated tests under
  `src/renderer/gpu/__tests__/`. The impure edge (pod listing, pod-proxy fetch) is behind `ScraperDeps` so tests inject
  fakes.
- **Host CSS is hostile to `<table>`.** Use `DataGrid` (CSS grid) for tabular UI.
- **Runtime API over typings.** Freelens 1.10.3 declares APIs it does not ship (`KubeJsonApi.forCluster`). Probe for
  existence before relying on a new host API.

## Pull requests

1. Branch from `main`; keep PRs focused. Plain, descriptive PR titles and commit messages, no
   Conventional Commits prefixes.
2. `pnpm biome:fix` and `pnpm trunk:fix` before committing; CI runs type check, lint (biome and
   trunk), knip, unit tests, the Playwright integration tests inside a packaged Freelens on kind
   with the fake GPU fixture, and the OSV scanner.
3. Add a line to `CHANGELOG.md`.
4. For UI changes attach a screenshot from Freelens.

## Releasing

Releases follow the freelensapp organization process, shared by every extension:

1. A maintainer runs the **Automated npm version** workflow (`npm-version.yaml`) choosing
   `patch`, `minor` or `major`. It opens a pull request that bumps `version` in `package.json`.
2. The pull request is reviewed and merged.
3. A maintainer comments `/tag` on the merged pull request: the **Automated tag** workflow
   (`tag.yaml`) creates and pushes the `vX.Y.Z` tag.
4. The **Release** workflow (`release.yaml`) builds the extension, publishes
   `@freelensapp/gpu-extension` to npm (Trusted Publishing with provenance, with
   `NPM_TOKEN` as fallback) and attaches the `.tgz`, its checksum and the SBOM to a GitHub
   Release.

Do not push tags by hand and do not publish from a workstation.
