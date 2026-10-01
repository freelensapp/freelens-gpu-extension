# Instructions for GitHub Copilot and other coding agents

The canonical agent guide for this repository is [AGENTS.md](../AGENTS.md)
in the repository root. Read it first and follow it strictly, in particular:

- the zero cluster footprint rule: the extension only reads pods, nodes and
  the pod proxy through the Kubernetes API, and never installs anything or
  writes to the cluster;
- the attribution rules shared with kubectl-gpugo: `src/renderer/gpu/aggregate.ts`
  is a port of the CLI's scraper, and both tools must keep showing the same
  numbers on the shared fixtures;
- the architecture: everything runs in the renderer, the data layer is pure and
  unit-tested with the `.prom` fixtures, the impure edge is behind `ScraperDeps`;
- the testing requirements: unit tests for every data-layer change and the
  Playwright integration tests inside Freelens with the fake GPU fixture;
- the code style rules in AGENTS.md (biome, trunk, import order, no emoji).
