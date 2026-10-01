#!/usr/bin/env bash
# Removes the fake GPU fixture. The fake capacity stays on the nodes of the
# disposable cluster; delete the cluster to get rid of it.
set -euo pipefail

kubectl delete namespace gpu-operator ml embeddings it-dgx1 it-dgx2 research --ignore-not-found --wait=false
