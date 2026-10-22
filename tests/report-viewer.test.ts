import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { parseOptions } from "../src/options.js";
import {
  createReportViewer,
  REPORT_VIEWER_LIFETIME_MS,
  type ReportViewer,
} from "../src/report-viewer.js";
import { TrackerStore } from "../src/store.js";

function fixture(): { directory: string; store: TrackerStore } {
  const directory = mkdtempSync(join(tmpdir(), "tracker-viewer-"));
  return { directory, store: TrackerStore.open(parseOptions({ dataDir: directory })) };
}

async function response(
  viewer: ReportViewer,
  method = "GET",
  url = viewer.url,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, { method, headers });
}

async function closedRequest(viewer: ReportViewer): Promise<boolean> {
  try {
    await fetch(viewer.url);
    return false;
  } catch {
    return true;
  }
}

function cleanup(directory: string, store: TrackerStore): void {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}

function expectViewerHeaders(result: Response): void {
  expect(result.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(result.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(result.headers.get("referrer-policy")).toBe("no-referrer");
  expect(result.headers.get("x-content-type-options")).toBe("nosniff");
  expect(result.headers.get("x-frame-options")).toBe("DENY");
}

test("serves only the exact loopback token route with dynamic, protected HTML", async () => {
  const { directory, store } = fixture();
  let viewer: ReportViewer | undefined;
  try {
    viewer = await createReportViewer(store, {}, { launch: () => false });
    const viewerURL = new URL(viewer.url);
    expect(viewerURL.hostname).toBe("127.0.0.1");
    expect(viewerURL.port === "0").toBe(false);
    expect(viewerURL.pathname.startsWith("/report/")).toBe(true);
    const first = await response(viewer);
    const firstHtml = await first.text();
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; img-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(first.headers.get("referrer-policy")).toBe("no-referrer");
    expect(first.headers.get("x-content-type-options")).toBe("nosniff");
    expect(first.headers.get("x-frame-options")).toBe("DENY");
    expect(firstHtml).toContain("all local activity");

    store.recordSession({ sessionID: "session-a", observedAt: 10, projectLabel: "demo" });
    store.startAction({
      sessionID: "session-a",
      actionID: "action-a",
      observedRole: "builder",
      startedAt: 20,
    });
    const refreshed = await response(viewer);
    expect((await refreshed.text()).includes("session-a")).toBe(true);

    const head = await response(viewer, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await response(viewer, "POST")).status).toBe(405);
    expect((await response(viewer, "GET", `${viewer.url}?file=secret`)).status).toBe(404);
    expect((await response(viewer, "GET", `${new URL(viewer.url).origin}/`)).status).toBe(404);
    expect((await response(viewer, "GET", viewer.url, { host: "example.test" })).status).toBe(404);
  } finally {
    viewer?.dispose();
    cleanup(directory, store);
  }
});

test("freezes the selected scope and isolates browser-launch failure", async () => {
  const { directory, store } = fixture();
  let viewer: ReportViewer | undefined;
  try {
    const sessions = ["session-a"];
    viewer = await createReportViewer(store, { sessions }, { launch: () => false });
    sessions.push("session-b");
    expect(viewer.browserOpened).toBe(false);
    store.recordSession({ sessionID: "session-a", observedAt: 10 });
    store.startAction({
      sessionID: "session-a",
      actionID: "action-a",
      observedRole: "builder",
      startedAt: 20,
    });
    expect((await (await response(viewer)).text()).includes("session-a")).toBe(true);
  } finally {
    viewer?.dispose();
    cleanup(directory, store);
  }
});

test("applies viewer headers to rejected and rendering-failure responses", async () => {
  const { directory, store } = fixture();
  let viewer: ReportViewer | undefined;
  let storeClosed = false;
  try {
    viewer = await createReportViewer(store, {}, { launch: () => false });
    const notFound = await response(viewer, "GET", `${new URL(viewer.url).origin}/missing`);
    expect(notFound.status).toBe(404);
    expectViewerHeaders(notFound);
    expect(await notFound.text()).toBe("");

    const methodNotAllowed = await response(viewer, "POST");
    expect(methodNotAllowed.status).toBe(405);
    expectViewerHeaders(methodNotAllowed);
    expect(await methodNotAllowed.text()).toBe("");

    store.close();
    storeClosed = true;
    const renderingFailure = await response(viewer);
    expect(renderingFailure.status).toBe(500);
    expectViewerHeaders(renderingFailure);
    expect(await renderingFailure.text()).toBe("");
  } finally {
    viewer?.dispose();
    if (!storeClosed) cleanup(directory, store);
    else rmSync(directory, { recursive: true, force: true });
  }
});

test("reports browser success and closes at the fixed non-extending expiry", async () => {
  const { directory, store } = fixture();
  let viewer: ReportViewer | undefined;
  let expire: (() => void) | undefined;
  let cleared = false;
  try {
    viewer = await createReportViewer(
      store,
      {},
      {
        launch: () => true,
        now: () => 1_000,
        setTimeout: (callback) => {
          expire = callback;
          return 1 as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeout: () => {
          cleared = true;
        },
      },
    );
    expect(viewer.browserOpened).toBe(true);
    expect(viewer.expiresAt).toBe(1_000 + REPORT_VIEWER_LIFETIME_MS);
    expect(expire === undefined).toBe(false);
    expect((await response(viewer)).status).toBe(200);
    expire!();
    expect(cleared).toBe(true);
    expect(await closedRequest(viewer)).toBe(true);
    viewer.dispose();
  } finally {
    viewer?.dispose();
    cleanup(directory, store);
  }
});
