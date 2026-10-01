/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Runs inside the Freelens repository (copied there by integration-tests.yaml),
// so the helpers come from freelens/integration/helpers.

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { kindReady } from "../helpers/kind";
import * as utils from "../helpers/utils";

import type { ConsoleMessage, ElectronApplication, Frame, Page } from "playwright";

const EXTENSION_NAME = "@freelensapp/gpu-extension";
const EXTENSION_ID = "freelensapp--gpu-extension";
const TEST_KIND_CLUSTER_NAME = process.env.TEST_KIND_CLUSTER_NAME || "kind";
// Namespace that kindReady() is allowed to wipe. It must differ from the
// namespaces of the fixture (gpu-operator, ml, embeddings, it-dgx1, it-dgx2,
// research) applied by the workflow.
const TEST_NAMESPACE = process.env.TEST_NAMESPACE || "integration-tests";
// Node names of the two-node kind cluster of integration/fixtures/gpu/kind.yaml:
// up.sh advertises whole GPUs on the worker and MIG slices on the control plane.
const WHOLE_GPU_NODE = `${TEST_KIND_CLUSTER_NAME}-worker`;
const MIG_NODE = `${TEST_KIND_CLUSTER_NAME}-control-plane`;
const GPU_VIEWS = ["Pods", "Namespaces", "Inference", "GPUs", "Idle & waste", "Allocation", "Pending", "Exporters"];

const outputErrorPattern = /\[out\]\s*error:/i;
const ansiEscapePattern = /\u001b\[[0-9;]*m/g;

interface ErrorCollector {
  errorLogs: string[];
  processErrorLogs: string[];
  logger: (msg: ConsoleMessage) => void;
  restore: () => void;
}

// Mirrors the skeleton test: collects renderer console errors and main
// process "[out] error:" lines so a silent failure still fails the run.
function collectErrors(): ErrorCollector {
  const errorLogs: string[] = [];
  const processErrorLogs: string[] = [];
  let processOutputBuffer = "";

  const collectOutputErrors = (chunk: string | Uint8Array) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    processOutputBuffer += text;

    if (processOutputBuffer.length > 200_000) {
      processOutputBuffer = processOutputBuffer.slice(-20_000);
    }

    const normalizedOutput = processOutputBuffer.replaceAll(ansiEscapePattern, "");

    if (outputErrorPattern.test(normalizedOutput)) {
      processErrorLogs.push(normalizedOutput.trim());
      processOutputBuffer = "";
    }
  };

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk, encoding, cb) => {
    collectOutputErrors(chunk);

    return originalStdoutWrite(chunk, encoding as never, cb as never);
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk, encoding, cb) => {
    collectOutputErrors(chunk);

    return originalStderrWrite(chunk, encoding as never, cb as never);
  }) as typeof process.stderr.write;

  const logger = (msg: ConsoleMessage) => {
    const text = msg.text();
    const normalizedText = text.replaceAll(ansiEscapePattern, "");

    console.log(text);

    if (msg.type() === "error" || outputErrorPattern.test(normalizedText)) {
      errorLogs.push(`[${msg.type()}] ${normalizedText}`);
    }
  };

  return {
    errorLogs,
    processErrorLogs,
    logger,
    restore: () => {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    },
  };
}

async function installExtension(app: ElectronApplication, window: Page): Promise<void> {
  console.log("await utils.clickWelcomeButton");
  await utils.clickWelcomeButton(window);

  console.log("await app.evaluate (navigate to extensions)");
  await app.evaluate(async ({ app }) => {
    await app.applicationMenu
      ?.getMenuItemById(process.platform === "darwin" ? "mac" : "file")
      ?.submenu?.getMenuItemById("navigate-to-extensions")
      ?.click();
  });

  const textbox = window.getByPlaceholder("Name or file path or URL");
  console.log("await textbox.fill");
  await textbox.fill(process.env.EXTENSION_PATH || EXTENSION_NAME);
  const installButtonSelector = 'button[class*="Button install-module__button--"]';
  console.log("await window.click [data-waiting=false]");
  await window.click(installButtonSelector.concat("[data-waiting=false]"));

  console.log('await window.waitForSelector div[class*="installed-extensions-module__extensionName--"]');
  const installedExtensionName = await (
    await window.waitForSelector('div[class*="installed-extensions-module__extensionName--"]', { timeout: 120_000 })
  ).textContent();
  expect(installedExtensionName).toBe(EXTENSION_NAME);
  const installedExtensionState = await (
    await window.waitForSelector('div[class*="installed-extensions-module__enabled--"]', { timeout: 120_000 })
  ).textContent();
  expect(installedExtensionState).toBe("Enabled");

  // Dismiss notifications so one still in its enter animation does not
  // intercept pointer events on the elements behind it.
  console.log("dismiss notifications");
  const notificationCloseSelector =
    'i[data-testid*="close-notification-for-notification_"], div[class*="close-button-module__closeButton--"][aria-label="Close"]';
  for (let attempt = 0; attempt < 10; attempt++) {
    const closeButtons = await window.$$(notificationCloseSelector);
    if (closeButtons.length === 0) break;
    for (const closeButton of closeButtons) {
      await closeButton.click({ force: true }).catch(() => {});
    }
    await window.waitForTimeout(200);
  }
}

describe("extensions page tests", () => {
  let window: Page;
  let cleanup: undefined | (() => Promise<void>);
  let errors: ErrorCollector;

  beforeAll(async () => {
    let app: ElectronApplication;

    errors = collectErrors();
    ({ window, cleanup, app } = await utils.start());
    window.on("console", errors.logger);
    await installExtension(app, window);
  }, 120 * 1000);

  afterAll(
    async () => {
      // Keep listeners active through cleanup to catch late shutdown errors in CI logs.
      await cleanup?.();
      window.off("console", errors.logger);
      errors.restore();
      expect([...errors.errorLogs, ...errors.processErrorLogs]).toEqual([]);
    },
    10 * 60 * 1000,
  );

  it(
    "installs and enables the extension",
    async () => {
      expect([...errors.errorLogs, ...errors.processErrorLogs]).toEqual([]);
    },
    100 * 60 * 1000,
  );
});

// The cluster tests need a kind cluster with the fixture from
// integration/fixtures/gpu applied (integration-tests.yaml does both).
const clusterDescribe = kindReady(TEST_KIND_CLUSTER_NAME, TEST_NAMESPACE) ? describe : describe.skip;

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

async function launchKindClusterFromCatalog(window: Page): Promise<Frame> {
  const catalogList = window.locator('[data-testid^="catalog-list-for-"]');
  await catalogList.waitFor({ state: "visible", timeout: 120_000 });

  const search = catalogList.getByPlaceholder("Search...");
  await search.fill(`kind-${TEST_KIND_CLUSTER_NAME}`);
  await window.waitForSelector(`div.TableCell >> text='kind-${TEST_KIND_CLUSTER_NAME}'`, { timeout: 120_000 });

  return utils.launchKindClusterFromCatalog(TEST_KIND_CLUSTER_NAME, window);
}

// Freelens 1.10.3, the version the workflow builds, has no clickSidebarItem
// helper: open the GPU group first when the child entry is collapsed.
async function openGpuMenuItem(frame: Frame, menuId: string): Promise<void> {
  const item = frame.locator(`[data-testid="link-for-sidebar-item-${EXTENSION_ID}-${menuId}"]`);
  if (!(await item.isVisible())) {
    await frame.click(`[data-testid="link-for-sidebar-item-${EXTENSION_ID}-gpu"]`);
  }
  await item.click();
  await frame.locator(".gpuext-page").waitFor({ state: "visible", timeout: 60_000 });
}

const ROW_SELECTOR = ".gpuext-page .gpuext-row:not(.gpuext-head)";

// Rows appear after the first scrape and the store polls every 20 s, so poll
// the DOM for a minimum number of rows instead of waiting on one locator.
async function waitForRows(frame: Frame, min: number, timeout = 120_000): Promise<string[]> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await frame.locator(ROW_SELECTOR).count()) >= min) break;
    await frame.waitForTimeout(500);
  }

  return (await frame.locator(ROW_SELECTOR).allInnerTexts()).map(flat);
}

async function waitForPageText(frame: Frame, pattern: RegExp, timeout = 120_000): Promise<string> {
  const deadline = Date.now() + timeout;
  let text = "";
  while (Date.now() < deadline) {
    text = flat(await frame.locator(".gpuext-page").innerText());
    if (pattern.test(text)) break;
    await frame.waitForTimeout(500);
  }

  return text;
}

clusterDescribe("GPU cluster pages", () => {
  let window: Page;
  let cleanup: undefined | (() => Promise<void>);
  let frame: Frame;
  let errors: ErrorCollector;

  beforeAll(
    async () => {
      let app: ElectronApplication;

      errors = collectErrors();
      ({ window, cleanup, app } = await utils.start());
      window.on("console", errors.logger);
      await installExtension(app, window);

      console.log("await launchKindClusterFromCatalog");
      frame = await launchKindClusterFromCatalog(window);
    },
    10 * 60 * 1000,
  );

  afterAll(
    async () => {
      await cleanup?.();
      window.off("console", errors.logger);
      errors.restore();
    },
    10 * 60 * 1000,
  );

  it(
    "lists the eight GPU views in the sidebar",
    async () => {
      console.log("await openGpuMenuItem gpu-pods");
      await openGpuMenuItem(frame, "gpu-pods");

      const entries = (
        await frame.locator(`[data-testid^="link-for-sidebar-item-${EXTENSION_ID}-gpu-"]`).allInnerTexts()
      ).map(flat);
      // jest expect, not the Playwright one: read the values and assert on them.
      expect(GPU_VIEWS.filter((view) => !entries.some((entry) => entry.includes(view)))).toEqual([]);
    },
    5 * 60 * 1000,
  );

  it(
    "shows the six GPU pods scraped from the two fake exporters",
    async () => {
      console.log("await openGpuMenuItem gpu-pods");
      await openGpuMenuItem(frame, "gpu-pods");

      const rows = await waitForRows(frame, 6);
      expect(rows.length).toBe(6);
      // The scrape status names the exporters that were discovered and scraped.
      const status = flat(await frame.locator(".gpuext-header .gpuext-status").first().innerText());
      expect(status).toMatch(/2 exporters \(dcgm\)/);
      // One pod from the whole-GPU exporter and one from the MIG exporter.
      expect(rows.some((row) => row.includes("tei-7d9f-x1"))).toBe(true);
      expect(rows.some((row) => row.includes("transcription-0"))).toBe(true);
    },
    5 * 60 * 1000,
  );

  it(
    "finds the vLLM server next to its GPU on the Inference view",
    async () => {
      console.log("await openGpuMenuItem gpu-inference");
      await openGpuMenuItem(frame, "gpu-inference");

      const rows = await waitForRows(frame, 1);
      expect(rows.some((row) => row.includes("vllm-0"))).toBe(true);
    },
    5 * 60 * 1000,
  );

  it(
    "lists four cards and four MIG slices on the GPUs view with the XID explained",
    async () => {
      console.log("await openGpuMenuItem gpu-devices");
      await openGpuMenuItem(frame, "gpu-devices");

      const rows = await waitForRows(frame, 8);
      expect(rows.length).toBe(8);
      // The idle card of the whole-GPU exporter reports XID 79 in the fixture.
      const fallen = rows.find((row) => /XID 79/.test(row)) ?? "";
      expect(fallen).toMatch(/fallen off the bus/i);
    },
    5 * 60 * 1000,
  );

  it(
    "lists both nodes with their capacity on the Allocation view",
    async () => {
      console.log("await openGpuMenuItem gpu-allocation");
      await openGpuMenuItem(frame, "gpu-allocation");

      const rows = await waitForRows(frame, 2);
      const whole = rows.find((row) => row.startsWith(WHOLE_GPU_NODE)) ?? "";
      const mig = rows.find((row) => row.startsWith(MIG_NODE)) ?? "";
      expect(whole).not.toBe("");
      expect(mig).toContain("1g.10gb");
    },
    5 * 60 * 1000,
  );

  it(
    "explains why the two waiting pods cannot be scheduled on the Pending view",
    async () => {
      console.log("await openGpuMenuItem gpu-pending");
      await openGpuMenuItem(frame, "gpu-pending");

      const rows = await waitForRows(frame, 2);
      const big = rows.find((row) => row.includes("train-big")) ?? "";
      const slice = rows.find((row) => row.includes("needs-a-slice")) ?? "";
      expect(big).toMatch(/any node|16/);
      expect(slice).toMatch(/No node offers|mig-2g\.20gb/);
    },
    5 * 60 * 1000,
  );

  it(
    "lists the two scraped exporters on the Exporters view",
    async () => {
      console.log("await openGpuMenuItem gpu-exporters");
      await openGpuMenuItem(frame, "gpu-exporters");

      const text = await waitForPageText(frame, /Scraped exporters \(2\)/);
      expect(text).toMatch(/Scraped exporters \(2\)/);
      expect(text).toContain("dcgm");
    },
    5 * 60 * 1000,
  );

  it(
    "keeps the renderer and the main process free of GPU errors",
    async () => {
      const gpuErrors = [...errors.errorLogs, ...errors.processErrorLogs].filter((line) => /gpu|dcgm/i.test(line));
      expect(gpuErrors).toEqual([]);
    },
    60 * 1000,
  );
});
