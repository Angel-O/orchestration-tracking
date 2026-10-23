import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { buildReportModels, type ReportSelector } from "./report.js";
import { renderReportDetailHtml } from "./report-html.js";
import type { TrackerStore } from "./tracking/store.js";

export const REPORT_VIEWER_LIFETIME_MS = 10 * 60 * 1000;

export type ReportViewerLauncher = (url: string) => boolean | Promise<boolean>;

/** Additive tool metadata for a live viewer; disposal remains plugin-owned. */
export interface ReportViewerMetadata {
  readonly url: string;
  readonly expiresAt: number;
  readonly browserOpened: boolean;
}

export interface ReportViewerOptions {
  /** Test seam; production callers should use the native default. */
  readonly launch?: ReportViewerLauncher;
  /** Abort pending startup and dispose a server owned by the caller. */
  readonly signal?: AbortSignal;
  /** Test seams for the fixed post-listen lifetime. */
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * One immutable-selector, IPv4-loopback report delivery. `dispose` is safe to
 * call repeatedly; the server never accepts selector or file overrides.
 */
export interface ReportViewer extends ReportViewerMetadata {
  readonly dispose: () => void;
}

function browserCommand(): { command: string; args: readonly string[] } {
  if (process.platform === "darwin") return { command: "open", args: [] };
  if (process.platform === "win32") {
    return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler"] };
  }
  return { command: "xdg-open", args: [] };
}

/** Best effort only: argv is passed directly and success requires clean opener exit. */
export const launchReportViewerBrowser: ReportViewerLauncher = (url) => {
  const { command, args } = browserCommand();
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (opened: boolean) => {
      if (settled) return;
      settled = true;
      resolve(opened);
    };
    try {
      const child = spawn(command, [...args, url], { detached: true, stdio: "ignore" });
      child.once("spawn", () => {
        child.unref();
      });
      child.once("close", (code) => finish(code === 0));
      child.once("error", () => finish(false));
    } catch {
      finish(false);
    }
  });
};

function diagnostic(message: string): void {
  console.warn(`[orchestration-tracking] ${message}`);
}

function freezeSelector(
  selector: ReturnType<typeof buildReportModels>["selector"],
): ReportSelector {
  return Object.freeze({
    ...selector,
    ...(selector.sessions === undefined ? {} : { sessions: Object.freeze([...selector.sessions]) }),
  });
}

function viewerHeaders(response: ServerResponse): void {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; img-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function emptyResponse(response: ServerResponse, status: number): void {
  viewerHeaders(response);
  response.statusCode = status;
  response.end();
}

function aborted(): Error {
  return new Error("report viewer creation aborted");
}

function listen(server: Server, signal?: AbortSignal): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onError = (error: Error) => {
      server.off("listening", onListening);
      fail(error);
    };
    const onListening = () => {
      server.off("error", onError);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      const address = server.address();
      if (address === null || typeof address === "string") {
        fail(new Error("loopback viewer did not expose an IPv4 address"));
        return;
      }
      cleanup();
      resolve(address);
    };
    const onAbort = () => {
      try {
        server.close();
      } catch {
        // The server may have lost the listen race; either way it is not usable.
      }
      fail(aborted());
    };
    if (signal?.aborted) {
      fail(aborted());
      return;
    }
    server.once("error", onError);
    server.once("listening", onListening);
    signal?.addEventListener("abort", onAbort, { once: true });
    server.listen({ host: "127.0.0.1", port: 0 });
  });
}

function launchWithAbort(
  launch: ReportViewerLauncher,
  url: string,
  signal: AbortSignal,
  dispose: () => void,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => {
      dispose();
      finish(() => reject(aborted()));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      Promise.resolve(launch(url)).then(
        (opened) => finish(() => resolve(opened)),
        () => finish(() => resolve(false)),
      );
    } catch {
      finish(() => resolve(false));
    }
  });
}

/** Start one dynamic report viewer and attempt one native browser launch. */
export async function createReportViewer(
  store: TrackerStore,
  input: ReportSelector = {},
  options: ReportViewerOptions = {},
): Promise<ReportViewer> {
  const now = options.now ?? Date.now;
  const initial = buildReportModels(store.readReportSnapshot(), input, now());
  const selector = freezeSelector(initial.selector);
  const token = randomBytes(32).toString("base64url");
  const path = `/report/${token}`;
  let disposed = false;
  let expectedHost = "";
  let dispose: () => void = () => undefined;
  let abortListener: (() => void) | undefined;

  const server = createServer((request, response) => {
    if (disposed || request.headers.host !== expectedHost) {
      emptyResponse(response, 404);
      return;
    }
    if (request.url !== path) {
      emptyResponse(response, 404);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      emptyResponse(response, 405);
      return;
    }

    try {
      const detail = buildReportModels(store.readReportSnapshot(), selector, now()).reportDetail;
      const html = renderReportDetailHtml(detail);
      viewerHeaders(response);
      response.setHeader("Content-Length", Buffer.byteLength(html));
      response.end(request.method === "HEAD" ? undefined : html);
    } catch {
      // Do not turn local fact or renderer errors into a data-bearing response.
      emptyResponse(response, 500);
    }
  });

  try {
    const address = await listen(server, options.signal);
    expectedHost = `127.0.0.1:${address.port}`;
    const url = `http://${expectedHost}${path}`;
    const expiresAt = now() + REPORT_VIEWER_LIFETIME_MS;
    const setTimer = options.setTimeout ?? setTimeout;
    const clearTimer = options.clearTimeout ?? clearTimeout;
    let timer: ReturnType<typeof setTimeout> | undefined;
    dispose = () => {
      if (disposed) return;
      disposed = true;
      if (abortListener !== undefined) options.signal?.removeEventListener("abort", abortListener);
      if (timer !== undefined) clearTimer(timer);
      server.close();
    };
    if (options.signal !== undefined) {
      abortListener = () => dispose();
      options.signal.addEventListener("abort", abortListener, { once: true });
      if (options.signal.aborted) {
        dispose();
        throw aborted();
      }
    }
    timer = setTimer(() => dispose(), REPORT_VIEWER_LIFETIME_MS);

    const launch = options.launch ?? launchReportViewerBrowser;
    let browserOpened = false;
    try {
      browserOpened =
        options.signal === undefined
          ? await launch(url)
          : await launchWithAbort(launch, url, options.signal, dispose);
    } catch {
      if (options.signal?.aborted) {
        dispose();
        throw aborted();
      }
      browserOpened = false;
    }
    if (options.signal?.aborted) {
      dispose();
      throw aborted();
    }
    if (!browserOpened) diagnostic("report viewer browser launch failed");
    return { url, expiresAt, browserOpened, dispose };
  } catch (error) {
    server.close();
    throw error;
  }
}
