import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aggregateByPod, aggregateDevicesDcgm, extractDcgmSamples, totalPowerW } from "../aggregate";
import { parsePrometheusText } from "../prom";
import { promCandidates, promQueryPath, promResultToNodeFamilies, seriesCount } from "../prometheus";
import { formatTarget, parseTarget } from "../targets";

const dgx = parsePrometheusText(readFileSync(join(__dirname, "fixtures", "dgx_a100_mig_mixed.prom"), "utf8"));

/**
 * The DGX capture as kube-prometheus-stack (honor_labels: false) would return it: the exporter pod's own
 * namespace/pod/job/instance stamped on every series, the workload's labels moved to exported_*, and a second
 * copy of everything from an HA replica.
 */
function asPrometheusVector(): string {
  const result: { metric: Record<string, string>; value: [number, string] }[] = [];
  for (const [name, samples] of dgx) {
    for (const s of samples) {
      const { namespace, pod, ...rest } = s.labels;
      const metric: Record<string, string> = {
        __name__: name,
        ...rest,
        namespace: "gpu-operator",
        pod: "nvidia-dcgm-exporter-abcde",
        job: "nvidia-dcgm-exporter",
        instance: "10.42.0.7:9400",
        endpoint: "gpu-metrics",
      };
      if (namespace) metric.exported_namespace = namespace;
      if (pod) metric.exported_pod = pod;
      for (const replica of ["prometheus-0", "prometheus-1"]) {
        result.push({ metric: { ...metric, prometheus_replica: replica }, value: [1700000000, String(s.value)] });
      }
    }
  }
  return JSON.stringify({ status: "success", data: { resultType: "vector", result } });
}

describe("Prometheus fallback", () => {
  it("reproduces the direct scrape from a relabelled, HA-duplicated Prometheus result", () => {
    const groups = promResultToNodeFamilies(asPrometheusVector());
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ node: "dgx-1", kind: "dcgm" });
    const fams = groups[0].fams;
    const devs = aggregateDevicesDcgm(fams, groups[0].node);
    expect(devs).toHaveLength(48);
    expect(Math.round(totalPowerW(devs))).toBe(805);
    const rows = aggregateByPod(extractDcgmSamples(fams, groups[0].node));
    expect(rows).toHaveLength(29);
    // nothing got credited to the exporter pod or its namespace
    expect(rows.some((r) => r.pod.includes("dcgm-exporter") || r.namespace === "gpu-operator")).toBe(false);
    // HA duplicates were dropped: VRAM equals the direct scrape
    const direct = aggregateByPod(extractDcgmSamples(dgx, "dgx-1"));
    expect(rows.reduce((s, r) => s + r.vramUsedMiB, 0)).toBe(direct.reduce((s, r) => s + r.vramUsedMiB, 0));
  });

  it("keeps workload labels when the scrape honours them (no exported_*)", () => {
    const json = JSON.stringify({
      status: "success",
      data: {
        result: [
          {
            metric: {
              __name__: "DCGM_FI_DEV_FB_USED",
              gpu: "0",
              UUID: "GPU-a",
              namespace: "ml",
              pod: "vllm-0",
              node: "n1",
            },
            value: [0, "1000"],
          },
          {
            metric: {
              __name__: "gpu_process_memory_bytes",
              uuid: "GPU-b",
              gpu: "1",
              namespace: "ml",
              pod: "tei-0",
              kubernetes_node: "n2",
            },
            value: [0, "2048"],
          },
        ],
      },
    });
    const groups = promResultToNodeFamilies(json);
    expect(groups.map((g) => `${g.kind}@${g.node}`).sort()).toEqual(["dcgm@n1", "enricher@n2"]);
    const dcgm = groups.find((g) => g.kind === "dcgm");
    expect(dcgm?.fams.get("DCGM_FI_DEV_FB_USED")?.[0].labels).toMatchObject({
      namespace: "ml",
      pod: "vllm-0",
      Hostname: "n1",
    });
  });

  it("prefers the service-discovery node label over DCGM's Hostname (the exporter pod name without NODE_NAME)", () => {
    const [g] = promResultToNodeFamilies(
      JSON.stringify({
        status: "success",
        data: {
          result: [
            {
              metric: {
                __name__: "DCGM_FI_DEV_FB_USED",
                gpu: "0",
                Hostname: "nvidia-dcgm-exporter-x7k2p",
                node: "gpu-node-3",
              },
              value: [0, "1"],
            },
          ],
        },
      }),
    );
    expect(g.node).toBe("gpu-node-3");
    expect(aggregateDevicesDcgm(g.fams, g.node)[0].node).toBe("gpu-node-3");
  });

  it("rejects error and non-JSON responses clearly", () => {
    expect(() => seriesCount(JSON.stringify({ status: "error", error: "bad query" }))).toThrow("bad query");
    expect(() => seriesCount("<html>404</html>")).toThrow(/not a Prometheus API response/);
    expect(seriesCount(JSON.stringify({ status: "success", data: { result: [] } }))).toBe(0);
  });

  it("finds query APIs among services and skips look-alikes", () => {
    const c = promCandidates([
      {
        namespace: "monitoring",
        name: "kube-prometheus-stack-alertmanager",
        ports: [{ name: "http-web", port: 9093 }],
      },
      { namespace: "monitoring", name: "kube-prometheus-stack-operator", ports: [{ name: "https", port: 443 }] },
      { namespace: "monitoring", name: "thanos-query", ports: [{ name: "http", port: 10902 }] },
      { namespace: "monitoring", name: "kube-prometheus-stack-prometheus", ports: [{ name: "http-web", port: 9090 }] },
      { namespace: "vm", name: "vmsingle-main", ports: [{ port: 8428 }] },
      { namespace: "default", name: "kubernetes", ports: [{ port: 443 }] },
    ]);
    expect(c.map((t) => `${t.name}:${t.port}`)).toEqual([
      "kube-prometheus-stack-prometheus:9090",
      "thanos-query:10902",
      "vmsingle-main:8428",
    ]);
    expect(promQueryPath(c[0], 'count({__name__=~"A|B"})')).toBe(
      "/api/v1/namespaces/monitoring/services/kube-prometheus-stack-prometheus:9090/proxy/api/v1/query?query=count(%7B__name__%3D~%22A%7CB%22%7D)",
    );
  });
});

describe("pinned targets", () => {
  it("parses pod prefixes and services, and round-trips", () => {
    expect(parseTarget("gpu-mon/my-exporter:9400")).toEqual({
      kind: "pod",
      namespace: "gpu-mon",
      prefix: "my-exporter",
      port: 9400,
    });
    expect(parseTarget(" monitoring/svc/vm-single:8428 ")).toEqual({
      kind: "service",
      namespace: "monitoring",
      name: "vm-single",
      port: 8428,
    });
    for (const s of ["gpu-mon/my-exporter:9400", "monitoring/svc/vm-single:8428"]) {
      const t = parseTarget(s);
      if ("error" in t) throw new Error(t.error);
      expect(formatTarget(t)).toBe(s);
    }
  });
  it("explains bad input", () => {
    expect(parseTarget("my-exporter:9400")).toHaveProperty("error");
    expect(parseTarget("ns/pod")).toHaveProperty("error");
    expect(parseTarget("ns/pod:70000")).toEqual({ error: "port 70000 is out of range" });
    expect(parseTarget("NS/pod:1")).toEqual({ error: '"NS" is not a valid namespace name' });
  });
});
