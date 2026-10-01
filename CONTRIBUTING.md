# Contributing

Thanks for helping improve the Freelens GPU extension.

## Development setup

```sh
pnpm install
pnpm type:check && pnpm lint:check && pnpm knip:check && pnpm test:unit
pnpm pack            # prepack builds; writes the .tgz to install in Freelens (Extensions → path to .tgz)
```

Try it without a GPU: on any cluster (kind works) run a pod named like `*dcgm-exporter*` that serves one of the
fixture files from `src/renderer/gpu/__tests__/fixtures/` at `/metrics` (nginx + ConfigMap). Discovery and every
view behave exactly as with the real DaemonSet.

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

1. Branch from `main`; keep PRs focused.
2. `pnpm biome:fix` before committing; CI runs type-check, lint, knip, unit tests, Trunk and OSV.
3. Add a line to `CHANGELOG.md`.
4. For UI changes attach a screenshot from Freelens.

## Releasing

See [docs/publishing.md](docs/publishing.md).
