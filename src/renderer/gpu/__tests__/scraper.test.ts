import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// The scraper imports the Freelens API for its default deps; tests inject their own, so stub the module.
vi.mock("@freelensapp/extensions", () => ({ Common: { logger: { info() {}, warn() {} } }, Renderer: {} }));

const { GpuScraper } = await import("../scraper");

type FakePod = {
  ns: string;
  name: string;
  phase: string;
  node?: string;
  limits?: Record<string, string>;
  scheduled?: { status: string; reason?: string; message?: string };
  ports?: number[];
};

const pod = (p: FakePod) => ({
  getNs: () => p.ns,
  getName: () => p.name,
  getStatusPhase: () => p.phase,
  getNodeName: () => p.node,
  getContainers: () => [
    {
      name: "c",
      image: "app:1",
      resources: { limits: p.limits ?? {} },
      ports: (p.ports ?? []).map((containerPort) => ({ containerPort })),
    },
  ],
  metadata: { labels: {}, annotations: {}, creationTimestamp: "2026-09-24T10:00:00Z" },
  status: { conditions: p.scheduled ? [{ type: "PodScheduled", ...p.scheduled }] : [] },
});

describe("GpuScraper pod state", () => {
  it("keeps pending pods and requests even when no exporter exists (snapshot throws)", async () => {
    const pods = [
      pod({ ns: "ml", name: "run", phase: "Running", node: "n1", limits: { "nvidia.com/mig-1g.10gb": "1" } }),
      // bound but still pulling images: already holds its slice
      pod({
        ns: "ml",
        name: "starting",
        phase: "Pending",
        node: "n1",
        limits: { "nvidia.com/mig-1g.10gb": "1" },
        scheduled: { status: "True" },
      }),
      pod({
        ns: "queue",
        name: "waiting",
        phase: "Pending",
        limits: { "nvidia.com/gpu": "1" },
        scheduled: { status: "False", reason: "Unschedulable", message: "0/1 nodes are available" },
      }),
      pod({ ns: "web", name: "cpu", phase: "Running", node: "n1" }),
    ];
    const s = new GpuScraper({
      clusterId: () => "c1",
      listPods: async () => pods as never,
      listServices: async () => [],
      fetchText: async () => "",
    });
    await expect(s.snapshot()).rejects.toThrow(/No GPU metrics exporter found/);

    const ps = s.podState;
    expect(ps?.pending).toEqual([
      expect.objectContaining({
        namespace: "queue",
        pod: "waiting",
        requests: { "nvidia.com/gpu": 1 },
        reason: "Unschedulable",
      }),
    ]);
    expect(ps?.requestedByNode.n1).toMatchObject({ gpus: 2, byResource: { "nvidia.com/mig-1g.10gb": 2 } });
    expect(ps?.requestedByNamespace.ml.pods).toEqual(["ml/run", "ml/starting"]);
    expect(ps?.requestedByNamespace.web).toBeUndefined();
  });
});

describe("GpuScraper discovery sources", () => {
  const promJson = JSON.stringify({
    status: "success",
    data: {
      result: [
        {
          metric: {
            __name__: "DCGM_FI_DEV_FB_USED",
            gpu: "0",
            UUID: "GPU-a",
            exported_namespace: "ml",
            exported_pod: "vllm-0",
            namespace: "gpu-operator",
            pod: "nvidia-dcgm-exporter-x",
            Hostname: "n1",
          },
          value: [0, "4096"],
        },
        { metric: { __name__: "DCGM_FI_DEV_FB_FREE", gpu: "0", UUID: "GPU-a", Hostname: "n1" }, value: [0, "4096"] },
      ],
    },
  });

  it("falls back to a Prometheus query API when no exporter pod exists", async () => {
    const paths: string[] = [];
    const s = new GpuScraper({
      clusterId: () => "c1",
      listPods: async () => [],
      listServices: async () => [
        { namespace: "monitoring", name: "prometheus-server", ports: [{ name: "http", port: 80 }] },
      ],
      fetchText: async (_c, path) => {
        paths.push(path);
        if (path.includes("count("))
          return JSON.stringify({ status: "success", data: { result: [{ metric: {}, value: [0, "2"] }] } });
        return promJson;
      },
    });
    const snap = await s.snapshot();
    expect(snap.exporters).toEqual([
      expect.objectContaining({ name: "prometheus-server", kind: "dcgm", via: "prometheus" }),
    ]);
    expect(snap.rows).toEqual([
      expect.objectContaining({ namespace: "ml", pod: "vllm-0", node: "n1", vramUsedMiB: 4096 }),
    ]);
    expect(snap.gpus).toHaveLength(1);
    expect(
      paths.every((p) =>
        p.startsWith("/api/v1/namespaces/monitoring/services/prometheus-server:80/proxy/api/v1/query"),
      ),
    ).toBe(true);
  });

  it("probes a pinned pod that auto-discovery would skip, at the pinned port", async () => {
    const odd = pod({ ns: "obs", name: "metrics-agent-7f9c", phase: "Running", node: "n1" }); // no gpu/dcgm keyword
    const probed: string[] = [];
    const s = new GpuScraper({
      clusterId: () => "c1",
      listPods: async () => [odd] as never,
      listServices: async () => [],
      fetchText: async (_c, path) => {
        probed.push(path);
        return 'DCGM_FI_DEV_FB_USED{gpu="0",UUID="GPU-a",namespace="ml",pod="p"} 100\n';
      },
    });
    s.pins = [{ kind: "pod", namespace: "obs", prefix: "metrics-agent", port: 9500 }];
    const snap = await s.snapshot();
    expect(probed[0]).toBe("/api/v1/namespaces/obs/pods/metrics-agent-7f9c:9500/proxy/metrics");
    expect(snap.exporters[0]).toMatchObject({ name: "metrics-agent-7f9c", port: 9500, kind: "dcgm" });
  });
});

describe("Prometheus fallback lifecycle", () => {
  const countOk = JSON.stringify({ status: "success", data: { result: [{ metric: {}, value: [0, "1"] }] } });
  const series = JSON.stringify({
    status: "success",
    data: {
      result: [{ metric: { __name__: "DCGM_FI_DEV_FB_USED", gpu: "0", UUID: "GPU-a", node: "n1" }, value: [0, "1"] }],
    },
  });
  const make = (fetchText: (path: string) => Promise<string>) =>
    new GpuScraper({
      clusterId: () => "c1",
      listPods: async () => [],
      listServices: async () => [{ namespace: "mon", name: "prometheus-server", ports: [{ name: "http", port: 80 }] }],
      fetchText: async (_c, path) => fetchText(path),
    });

  it("probes once, then reuses the chosen query API on later ticks", async () => {
    let probes = 0;
    const s = make(async (p) => {
      if (p.includes("count(")) {
        probes++;
        return countOk;
      }
      return series;
    });
    await s.snapshot();
    await s.snapshot();
    await s.snapshot();
    expect(probes).toBe(1);
    await s.snapshot(true); // Refresh re-probes
    expect(probes).toBe(2);
  });

  it("a failing query gives the explanatory error, forgets the target, and re-probes next tick", async () => {
    let probes = 0;
    let fail = true;
    const s = make(async (p) => {
      if (p.includes("count(")) {
        probes++;
        return countOk;
      }
      if (fail) throw new Error("HTTP 503 Service Unavailable");
      return series;
    });
    await expect(s.snapshot()).rejects.toThrow(/No GPU metrics exporter found[\s\S]*query failed: HTTP 503/);
    fail = false;
    const snap = await s.snapshot();
    expect(probes).toBe(2);
    expect(snap.gpus[0]).toMatchObject({ node: "n1" });
  });
});

describe("GpuScraper inference discovery", () => {
  const vllm = readFileSync(join(__dirname, "fixtures", "vllm_v1_idle.prom"), "utf8");
  it("finds a vLLM pod among GPU pods, skips non-servers for a while, and scrapes it without any GPU exporter", async () => {
    const server = pod({
      ns: "vllm",
      name: "vllm-7645db44c9-8rn4j",
      phase: "Running",
      node: "n1",
      limits: { "nvidia.com/gpu": "1" },
      ports: [8000],
    });
    const worker = pod({
      ns: "ml",
      name: "trainer-0",
      phase: "Running",
      node: "n1",
      limits: { "nvidia.com/gpu": "1" },
      ports: [8000],
    });
    const cpu = pod({ ns: "web", name: "api-0", phase: "Running", node: "n1" });
    const calls: string[] = [];
    const s = new GpuScraper({
      clusterId: () => "c1",
      listPods: async () => [server, worker, cpu] as never,
      listServices: async () => [],
      fetchText: async (_c, path) => {
        calls.push(path);
        if (path.includes("vllm-7645db44c9-8rn4j")) return vllm;
        if (path.includes("trainer-0")) return "# not an inference server\nprocess_cpu_seconds_total 1\n";
        throw new Error("404");
      },
    });
    await expect(s.snapshot()).rejects.toThrow(); // no GPU exporter at all
    expect(s.inferenceTargets).toEqual([
      { namespace: "vllm", pod: "vllm-7645db44c9-8rn4j", node: "n1", port: 8000, engine: "vllm" },
    ]);
    const [scrape] = await s.scrapeInference();
    expect(scrape.sample?.models).toEqual(["gemma-4-E4B-it"]);
    expect(calls.some((c) => c.includes("api-0"))).toBe(false); // CPU pods without hints are never probed

    calls.length = 0;
    await expect(s.snapshot()).rejects.toThrow();
    expect(calls.filter((c) => c.includes("trainer-0"))).toEqual([]); // remembered as not-a-server
  });
});

describe("inference probe caching", () => {
  const vllmText = readFileSync(join(__dirname, "fixtures", "vllm_v1_idle.prom"), "utf8");
  it("does not probe (or blacklist) a server whose containers are still starting, then finds it once ready", async () => {
    const p = pod({
      ns: "vllm",
      name: "vllm-0",
      phase: "Running",
      node: "n1",
      limits: { "nvidia.com/gpu": "1" },
      ports: [8000],
    });
    const status = p.status as { containerStatuses?: { ready: boolean }[] };
    status.containerStatuses = [{ ready: false }]; // loading the model
    const calls: string[] = [];
    const s = new GpuScraper({
      clusterId: () => "c1",
      listPods: async () => [p] as never,
      listServices: async () => [],
      fetchText: async (_c, path) => {
        calls.push(path);
        return vllmText;
      },
    });
    await expect(s.snapshot()).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(s.inferenceTargets).toEqual([]);
    status.containerStatuses = [{ ready: true }];
    await expect(s.snapshot()).rejects.toThrow();
    expect(s.inferenceTargets.map((t) => t.pod)).toEqual(["vllm-0"]);
  });

  it("retries a failed probe after a short wait but remembers a 404 for long", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-26T10:00:00Z"));
      const flaky = pod({
        ns: "a",
        name: "flaky",
        phase: "Running",
        node: "n",
        limits: { "nvidia.com/gpu": "1" },
        ports: [8000],
      });
      const nometrics = pod({
        ns: "a",
        name: "nometrics",
        phase: "Running",
        node: "n",
        limits: { "nvidia.com/gpu": "1" },
        ports: [8000],
      });
      const calls: string[] = [];
      const s = new GpuScraper({
        clusterId: () => "c1",
        listPods: async () => [flaky, nometrics] as never,
        listServices: async () => [],
        fetchText: async (_c, path) => {
          calls.push(path);
          throw new Error(path.includes("flaky") ? "connect ECONNREFUSED" : "HTTP 404 Not Found for /api-kube/...");
        },
      });
      const probedAt = async (min: number) => {
        vi.setSystemTime(new Date(Date.parse("2026-09-26T10:00:00Z") + min * 60_000));
        calls.length = 0;
        await expect(s.snapshot()).rejects.toThrow();
        return ["flaky", "nometrics"].filter((n) => calls.some((c) => c.includes(`/${n}:8000/`)));
      };
      expect(await probedAt(0)).toEqual(["flaky", "nometrics"]);
      expect(await probedAt(1)).toEqual([]);
      expect(await probedAt(3)).toEqual(["flaky"]); // refused: retried after 2 min
      expect(await probedAt(11)).toEqual(["flaky", "nometrics"]); // 404: after 10 min
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GpuScraper after every exporter scrape failed", () => {
  it("discovers again at the next tick instead of scraping the same dead pods", async () => {
    const dcgm = readFileSync(join(__dirname, "fixtures", "dcgm_pod_labels.prom"), "utf8");
    const exporter = pod({
      ns: "gpu-operator",
      name: "nvidia-dcgm-exporter-a",
      phase: "Running",
      node: "n1",
      ports: [9400],
    });
    let alive = true;
    let lists = 0;
    const s = new GpuScraper({
      clusterId: () => "c1",
      listPods: async () => {
        lists++;
        return (alive ? [exporter] : []) as never;
      },
      listServices: async () => [],
      fetchText: async () => {
        if (!alive) throw new Error("HTTP 404 Not Found");
        return dcgm;
      },
    });
    await s.snapshot();
    expect(lists).toBe(1);

    alive = false; // the exporter pod is deleted
    await expect(s.snapshot()).rejects.toThrow(/All 1 exporter scrapes failed/);
    await expect(s.snapshot()).rejects.toThrow(/No GPU metrics exporter found/);
    expect(lists).toBe(2);
  });
});
