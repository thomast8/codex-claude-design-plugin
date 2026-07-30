#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const DESIGN_CLIENT_ID = "59637612-477b-4836-a601-b0589eda7704";
export const SCOPES = ["user:design:read", "user:design:write"];
export const AUTHORISE_URL = "https://claude.com/cai/oauth/authorize";
export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const MANUAL_REDIRECT_URL =
  "https://platform.claude.com/oauth/code/callback";
export const MCP_URL = "https://api.anthropic.com/v1/design/mcp";
export const STORE_PATH =
  process.env.CODEX_CLAUDE_DESIGN_CREDENTIALS ||
  join(homedir(), ".config", "codex-claude-design", "credentials.json");

const REFRESH_SKEW_MS = 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const MCP_REMOTE_VERSION = "0.1.37";
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_EXPORT_BYTES = 512 * 1024 * 1024;
const MAX_EXPORT_FILES = 20_000;
const EXPORT_MANIFEST = ".claude-design-export.json";
const require = createRequire(import.meta.url);

export const LOCAL_TOOLS = [
  {
    name: "download_file_to_local",
    description:
      "Download one Claude Design project file to a new local path as exact raw bytes. Works for binary assets such as PNG, JPEG, GIF, WebP, fonts, PDFs, and archives as well as text. The destination must be an absolute path under the user's home or temporary directory and must not already exist.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["project_id", "path", "output_path"],
      properties: {
        project_id: {
          type: "string",
          description: "Claude Design project ID.",
        },
        path: {
          type: "string",
          description: "Project-relative file path.",
        },
        output_path: {
          type: "string",
          description:
            "Absolute destination file path. Existing files are never overwritten.",
        },
      },
    },
  },
  {
    name: "export_project_to_local",
    description:
      "Export every file in a Claude Design project to a new local directory as exact raw bytes, including binary assets that read_file cannot return. Preserves project-relative paths and writes .claude-design-export.json with source etags, sizes, content types, and SHA-256 hashes. The destination directory must not already exist.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["project_id", "output_dir"],
      properties: {
        project_id: {
          type: "string",
          description: "Claude Design project ID.",
        },
        output_dir: {
          type: "string",
          description:
            "Absolute destination directory under the user's home or temporary directory. It must not already exist.",
        },
      },
    },
  },
];

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function createPkce() {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(
    createHash("sha256").update(verifier).digest(),
  );
  return { verifier, challenge };
}

export function createState() {
  return base64Url(randomBytes(32));
}

export function buildAuthoriseUrl({ challenge, state }) {
  const url = new URL(AUTHORISE_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", DESIGN_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", MANUAL_REDIRECT_URL);
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.toString();
}

export function parsePastedCode(raw) {
  const trimmed = raw.trim().replace(/^["']|["']$/g, "");
  const [code, state, ...extra] = trimmed.split("#");
  if (!code || !state || extra.length > 0) return null;
  return { code, state };
}

async function readStore() {
  try {
    return JSON.parse(await readFile(STORE_PATH, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function saveStore(data) {
  const storeDirectory = dirname(STORE_PATH);
  await mkdir(storeDirectory, { recursive: true, mode: 0o700 });
  await chmod(storeDirectory, 0o700);
  await writeFile(STORE_PATH, `${JSON.stringify(data, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(STORE_PATH, 0o600);
}

async function requestTokens(body, label) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "codex-claude-design/0.5.0",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed (${response.status}). Start the flow again.`);
  }
  return JSON.parse(text);
}

async function exchangeCode({ code, state, verifier }) {
  return requestTokens(
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: MANUAL_REDIRECT_URL,
      client_id: DESIGN_CLIENT_ID,
      code_verifier: verifier,
      state,
    },
    "Token exchange",
  );
}

async function refreshStore(store) {
  const tokenResponse = await requestTokens(
    {
      grant_type: "refresh_token",
      refresh_token: store.refreshToken,
      client_id: store.clientId || DESIGN_CLIENT_ID,
      scope: SCOPES.join(" "),
    },
    "Token refresh",
  );
  const next = toStore(tokenResponse, store);
  verifyScopes(next.scopes);
  await saveStore(next);
  return next;
}

function toStore(tokenResponse, previous = {}) {
  const scopes =
    typeof tokenResponse.scope === "string"
      ? tokenResponse.scope.split(" ").filter(Boolean)
      : previous.scopes || SCOPES;
  return {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token || previous.refreshToken,
    expiresAt: Date.now() + Number(tokenResponse.expires_in || 3600) * 1000,
    scopes,
    clientId: DESIGN_CLIENT_ID,
    createdAt: previous.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function verifyScopes(scopes) {
  const missing = SCOPES.filter((scope) => !scopes.includes(scope));
  if (missing.length > 0) {
    throw new Error(`Design OAuth is missing scopes: ${missing.join(", ")}`);
  }
}

export async function ensureAccessToken({ forceRefresh = false } = {}) {
  let store = await readStore();
  if (!store?.accessToken || !store?.refreshToken) {
    throw new Error("Claude Design is not logged in. Run the plugin login command.");
  }
  const shouldRefresh =
    forceRefresh ||
    !store.expiresAt ||
    Date.now() >= store.expiresAt - REFRESH_SKEW_MS;
  if (shouldRefresh) store = await refreshStore(store);
  verifyScopes(store.scopes || []);
  return store.accessToken;
}

function openBrowser(url) {
  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderLoginPage({ authoriseUrl, formToken, error = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Claude Design login</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
    main { width: min(34rem, calc(100% - 2rem)); padding: 2rem; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 1rem; }
    h1 { margin-top: 0; }
    p { line-height: 1.5; }
    a, button { display: inline-block; border: 0; border-radius: .6rem; padding: .75rem 1rem; background: #d97757; color: white; font: inherit; font-weight: 650; text-decoration: none; cursor: pointer; }
    label { display: block; margin: 1.5rem 0 .5rem; font-weight: 650; }
    input { box-sizing: border-box; width: 100%; padding: .75rem; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); border-radius: .5rem; font: inherit; }
    .error { color: #c33; }
    .fine { font-size: .875rem; opacity: .75; }
  </style>
</head>
<body>
  <main>
    <h1>Connect Claude Design</h1>
    <p>Open Claude in a new tab and approve Design access. Claude will display a short-lived <code>CODE#STATE</code> value.</p>
    <p><a href="${escapeHtml(authoriseUrl)}" target="_blank" rel="noreferrer">Authorise with Claude</a></p>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    <form method="post" action="/complete">
      <input type="hidden" name="form_token" value="${escapeHtml(formToken)}">
      <label for="code">Paste the full CODE#STATE value</label>
      <input id="code" name="code" autocomplete="off" spellcheck="false" required>
      <p><button type="submit">Finish connection</button></p>
    </form>
    <p class="fine">This helper is running only on 127.0.0.1. The code is sent directly to Anthropic and is not added to Codex chat.</p>
  </main>
</body>
</html>`;
}

function renderSuccessPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Claude Design connected</title></head>
<body style="font-family:system-ui,sans-serif;margin:3rem"><h1>Claude Design connected</h1><p>You can close this tab and return to Codex.</p></body></html>`;
}

async function readForm(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new Error("Form response is too large.");
  }
  return new URLSearchParams(body);
}

export async function login({ launchBrowser = true } = {}) {
  const { verifier, challenge } = createPkce();
  const state = createState();
  const authoriseUrl = buildAuthoriseUrl({ challenge, state });
  const formToken = createState();
  let settled = false;
  let resolveLogin;
  let rejectLogin;
  const completion = new Promise((resolve, reject) => {
    resolveLogin = resolve;
    rejectLogin = reject;
  });

  const server = createServer(async (request, response) => {
    const send = (status, html) => {
      response.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(html);
    };

    try {
      if (request.method === "GET" && request.url === "/") {
        send(200, renderLoginPage({ authoriseUrl, formToken }));
        return;
      }
      if (request.method !== "POST" || request.url !== "/complete") {
        send(404, "<h1>Not found</h1>");
        return;
      }

      const form = await readForm(request);
      if (form.get("form_token") !== formToken) {
        throw new Error("The local login form has expired. Start the flow again.");
      }
      const parsed = parsePastedCode(form.get("code") || "");
      if (!parsed) {
        throw new Error("Paste the full value, including the # separator.");
      }
      if (parsed.state !== state) {
        throw new Error("The OAuth state does not match this login attempt.");
      }

      const tokenResponse = await exchangeCode({
        code: parsed.code,
        state: parsed.state,
        verifier,
      });
      const store = toStore(tokenResponse);
      verifyScopes(store.scopes);
      await saveStore(store);
      send(200, renderSuccessPage());
      settled = true;
      resolveLogin(store);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send(400, renderLoginPage({ authoriseUrl, formToken, error: message }));
    }
  });

  server.once("error", (error) => {
    if (!settled) rejectLogin(error);
  });
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not start the local Claude Design login helper.");
  }
  const localUrl = `http://127.0.0.1:${address.port}/`;
  process.stderr.write(`Claude Design login: ${localUrl}\n`);
  if (launchBrowser) openBrowser(localUrl);

  const timeout = setTimeout(() => {
    if (!settled) rejectLogin(new Error("Claude Design login timed out."));
  }, LOGIN_TIMEOUT_MS);
  try {
    const store = await completion;
    process.stderr.write("Claude Design authorised.\n");
    return store;
  } finally {
    clearTimeout(timeout);
    server.close();
  }
}

export async function status() {
  const store = await readStore();
  if (!store) {
    console.log("status: logged_out");
    console.log(`credentials: ${STORE_PATH}`);
    return;
  }
  const expired = !store.expiresAt || Date.now() >= store.expiresAt;
  console.log(`status: ${expired ? "expired" : "logged_in"}`);
  console.log(`credentials: ${STORE_PATH}`);
  console.log(`scopes: ${(store.scopes || []).join(" ")}`);
  console.log(
    `expires: ${store.expiresAt ? new Date(store.expiresAt).toISOString() : "unknown"}`,
  );
}

export async function logout() {
  await rm(STORE_PATH, { force: true });
  console.log(`Removed ${STORE_PATH}`);
}

function isPathInside(root, target) {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

async function allowedOutputRoots() {
  const roots = [homedir(), tmpdir(), "/private/tmp"];
  const resolvedRoots = [];
  for (const root of roots) {
    try {
      resolvedRoots.push(await realpath(root));
    } catch {
      resolvedRoots.push(resolve(root));
    }
  }
  return [...new Set(resolvedRoots)];
}

async function nearestExistingAncestor(target) {
  let candidate = target;
  while (true) {
    try {
      await lstat(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function validateNewLocalPath(target, label) {
  if (typeof target !== "string" || !isAbsolute(target)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  const resolvedTarget = resolve(target);
  const roots = await allowedOutputRoots();
  if (!roots.some((root) => isPathInside(root, resolvedTarget))) {
    throw new Error(
      `${label} must be inside the user's home or temporary directory.`,
    );
  }
  try {
    await lstat(resolvedTarget);
    throw new Error(`${label} already exists; refusing to overwrite it.`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const ancestor = await nearestExistingAncestor(dirname(resolvedTarget));
  const realAncestor = await realpath(ancestor);
  if (!roots.some((root) => isPathInside(root, realAncestor))) {
    throw new Error(`${label} resolves outside the permitted output roots.`);
  }
  return resolvedTarget;
}

export function validateRemoteFilePath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/")
  ) {
    throw new Error("Project paths must be non-empty relative POSIX paths.");
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Project paths cannot contain empty, '.' or '..' segments.");
  }
  return path;
}

function validateProjectId(projectId) {
  if (
    typeof projectId !== "string" ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(projectId)
  ) {
    throw new Error("project_id must be a Claude Design project UUID.");
  }
  return projectId;
}

function validateServeUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".claudeusercontent.com")
  ) {
    throw new Error("Claude Design returned an unexpected asset host.");
  }
  if (!url.searchParams.has("t")) {
    throw new Error("Claude Design returned an asset URL without a token.");
  }
  return url;
}

export function buildProjectFileUrl(serveUrl, path) {
  const safePath = validateRemoteFilePath(path);
  const base = validateServeUrl(serveUrl);
  const marker = "/serve/";
  const markerIndex = base.pathname.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error("Claude Design returned an unexpected asset URL.");
  }
  const prefix = base.pathname.slice(0, markerIndex + marker.length);
  const encodedPath = safePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return new URL(`${base.origin}${prefix}${encodedPath}${base.search}`);
}

function parseToolPayload(result, toolName) {
  if (result?.isError) {
    throw new Error(`${toolName} failed.`);
  }
  const text = (result?.content || []).find((item) => item.type === "text")?.text;
  if (!text) throw new Error(`${toolName} returned no JSON payload.`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${toolName} returned an invalid JSON payload.`);
  }
}

export function decodeReadFilePayload(payload, expectedPath, expectedEtag) {
  const firstLineEnd = payload.indexOf("\n");
  const closingMarker = "\n</untrusted-project-content>";
  const closingIndex = payload.indexOf(closingMarker);
  if (firstLineEnd < 0 || closingIndex < firstLineEnd) {
    throw new Error("read_file returned an unexpected wrapper.");
  }
  const openingTag = payload.slice(0, firstLineEnd);
  const pathMatch = openingTag.match(/\spath="([^"]*)"/);
  const etagMatch = openingTag.match(/\setag="([^"]*)"/);
  const decodedPath = pathMatch
    ? pathMatch[1]
        .replaceAll("&quot;", '"')
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&")
    : null;
  if (decodedPath !== expectedPath) {
    throw new Error("read_file returned a different project path.");
  }
  if (expectedEtag && (!etagMatch || etagMatch[1] !== String(expectedEtag))) {
    throw new Error("read_file etag did not match list_files.");
  }
  const escaped = payload.slice(firstLineEnd + 1, closingIndex);
  return escaped
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

async function readProjectTextFile(callRemoteTool, projectId, file) {
  const result = await callRemoteTool("read_file", {
    project_id: projectId,
    path: file.path,
  });
  if (result?.isError) return null;
  const payload = (result?.content || []).find(
    (item) => item.type === "text",
  )?.text;
  if (!payload) throw new Error(`read_file returned no content for ${file.path}.`);
  const decoded = decodeReadFilePayload(payload, file.path, file.etag);
  const bytes = Buffer.from(decoded, "utf8");
  if (bytes.length !== file.size) {
    return null;
  }
  return {
    bytes,
    contentType: "text/plain",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    source: "read_file",
  };
}

async function fetchProjectAsset(url, expectedSize) {
  const response = await fetch(url, {
    redirect: "error",
    headers: { "User-Agent": "codex-claude-design/0.5.0" },
  });
  if (!response.ok) {
    throw new Error(`Project file download failed (${response.status}).`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (declaredLength && declaredLength > MAX_FILE_BYTES) {
    throw new Error(`Project file exceeds the ${MAX_FILE_BYTES} byte limit.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_FILE_BYTES) {
    throw new Error(`Project file exceeds the ${MAX_FILE_BYTES} byte limit.`);
  }
  if (Number.isFinite(expectedSize) && bytes.length !== expectedSize) {
    throw new Error(
      `Downloaded ${bytes.length} bytes but Claude Design listed ${expectedSize}.`,
    );
  }
  return {
    bytes,
    contentType:
      response.headers.get("content-type")?.split(";")[0] ||
      "application/octet-stream",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    source: "render_preview",
  };
}

async function downloadProjectFile(callRemoteTool, projectId, file, assetBase) {
  const textDownload = await readProjectTextFile(
    callRemoteTool,
    projectId,
    file,
  );
  if (textDownload) return textDownload;
  const base =
    assetBase ||
    (await projectAssetBase(callRemoteTool, projectId, file.path));
  return fetchProjectAsset(buildProjectFileUrl(base, file.path), file.size);
}

async function projectFileIndex(callRemoteTool, projectId) {
  const listing = parseToolPayload(
    await callRemoteTool("list_files", {
      project_id: projectId,
      path: "",
      depth: -1,
    }),
    "list_files",
  );
  if (!Array.isArray(listing)) {
    throw new Error("list_files returned an unexpected payload.");
  }
  const files = listing.filter((entry) => entry?.type === "file");
  if (files.length === 0) throw new Error("The project contains no files.");
  if (files.length > MAX_EXPORT_FILES) {
    throw new Error(`The project exceeds the ${MAX_EXPORT_FILES} file limit.`);
  }
  let totalBytes = 0;
  for (const file of files) {
    validateRemoteFilePath(file.path);
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error(`Claude Design returned an invalid size for ${file.path}.`);
    }
    if (file.size > MAX_FILE_BYTES) {
      throw new Error(`${file.path} exceeds the ${MAX_FILE_BYTES} byte limit.`);
    }
    totalBytes += file.size;
  }
  if (totalBytes > MAX_EXPORT_BYTES) {
    throw new Error(`The project exceeds the ${MAX_EXPORT_BYTES} byte limit.`);
  }
  return { files, totalBytes };
}

async function projectAssetBase(callRemoteTool, projectId, firstPath) {
  const preview = parseToolPayload(
    await callRemoteTool("render_preview", {
      project_id: projectId,
      path: firstPath,
    }),
    "render_preview",
  );
  if (!preview?.serve_url) {
    throw new Error("render_preview returned no asset URL.");
  }
  return validateServeUrl(preview.serve_url);
}

async function downloadFileToLocal(arguments_, callRemoteTool) {
  const { project_id: projectId, path, output_path: outputPath } = arguments_;
  validateProjectId(projectId);
  const safePath = validateRemoteFilePath(path);
  const target = await validateNewLocalPath(outputPath, "output_path");
  const { files } = await projectFileIndex(callRemoteTool, projectId);
  const file = files.find((entry) => entry.path === safePath);
  if (!file) throw new Error(`${safePath} does not exist in the project.`);
  const downloaded = await downloadProjectFile(
    callRemoteTool,
    projectId,
    file,
  );
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, downloaded.bytes, { flag: "wx", mode: 0o600 });
  return {
    project_id: projectId,
    path: safePath,
    output_path: target,
    bytes: downloaded.bytes.length,
    etag: file.etag,
    content_type: downloaded.contentType,
    sha256: downloaded.sha256,
    source: downloaded.source,
  };
}

async function exportProjectToLocal(arguments_, callRemoteTool) {
  const { project_id: projectId, output_dir: outputDir } = arguments_;
  validateProjectId(projectId);
  const targetRoot = await validateNewLocalPath(outputDir, "output_dir");
  const { files, totalBytes } = await projectFileIndex(
    callRemoteTool,
    projectId,
  );
  if (files.some((file) => file.path === EXPORT_MANIFEST)) {
    throw new Error(
      `The project already contains the reserved path ${EXPORT_MANIFEST}.`,
    );
  }
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });

  const exported = [];
  let assetBase;
  for (const file of files) {
    const localPath = join(targetRoot, ...file.path.split("/"));
    if (!isPathInside(targetRoot, localPath)) {
      throw new Error(`Unsafe project path: ${file.path}`);
    }
    let downloaded = await readProjectTextFile(callRemoteTool, projectId, file);
    if (!downloaded) {
      assetBase ||= await projectAssetBase(
        callRemoteTool,
        projectId,
        file.path,
      );
      downloaded = await fetchProjectAsset(
        buildProjectFileUrl(assetBase, file.path),
        file.size,
      );
    }
    await mkdir(dirname(localPath), { recursive: true, mode: 0o700 });
    await writeFile(localPath, downloaded.bytes, {
      flag: "wx",
      mode: 0o600,
    });
    exported.push({
      path: file.path,
      bytes: downloaded.bytes.length,
      etag: file.etag,
      content_type: downloaded.contentType,
      sha256: downloaded.sha256,
      source: downloaded.source,
    });
  }

  const manifestPath = join(targetRoot, EXPORT_MANIFEST);
  const manifest = {
    format: "claude-design-local-export.v1",
    project_id: projectId,
    exported_at: new Date().toISOString(),
    source_file_count: exported.length,
    source_bytes: totalBytes,
    files: exported,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return {
    project_id: projectId,
    output_dir: targetRoot,
    file_count: exported.length,
    bytes: totalBytes,
    manifest_path: manifestPath,
  };
}

function localToolResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function localToolError(error) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}

function resolveMcpRemote() {
  try {
    const packagePath = require.resolve("mcp-remote/package.json");
    const packageJson = require(packagePath);
    const binPath =
      typeof packageJson.bin === "string"
        ? packageJson.bin
        : packageJson.bin?.["mcp-remote"];
    return binPath ? require.resolve(`mcp-remote/${binPath}`) : null;
  } catch {
    return null;
  }
}

function startProtocolProxy(child) {
  const pending = new Map();
  let nextInternalId = 1;
  const childLines = createInterface({ input: child.stdout });
  const parentLines = createInterface({ input: process.stdin });

  const writeToChild = (message) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const writeToParent = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const requestRemote = (method, params) =>
    new Promise((resolveRequest, rejectRequest) => {
      const id = `claude-design-bridge-${nextInternalId++}`;
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      writeToChild({ jsonrpc: "2.0", id, method, params });
    });
  const callRemoteTool = (name, arguments_) =>
    requestRemote("tools/call", { name, arguments: arguments_ });

  childLines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write("Claude Design bridge ignored non-JSON output.\n");
      return;
    }
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      if (message.error) {
        waiter.reject(
          new Error(message.error.message || "Remote MCP request failed."),
        );
      } else {
        waiter.resolve(message.result);
      }
      return;
    }
    writeToParent(message);
  });

  parentLines.on("line", async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      child.stdin.write(`${line}\n`);
      return;
    }

    try {
      if (message.method === "tools/list" && message.id !== undefined) {
        const result = await requestRemote("tools/list", message.params || {});
        const remoteTools = Array.isArray(result?.tools) ? result.tools : [];
        const remoteNames = new Set(remoteTools.map((tool) => tool.name));
        const collisions = LOCAL_TOOLS.filter((tool) =>
          remoteNames.has(tool.name),
        );
        if (collisions.length > 0) {
          throw new Error(
            `Remote tool collision: ${collisions.map((tool) => tool.name).join(", ")}`,
          );
        }
        writeToParent({
          jsonrpc: "2.0",
          id: message.id,
          result: { ...result, tools: [...remoteTools, ...LOCAL_TOOLS] },
        });
        return;
      }

      if (
        message.method === "tools/call" &&
        message.id !== undefined &&
        LOCAL_TOOLS.some((tool) => tool.name === message.params?.name)
      ) {
        let payload;
        if (message.params.name === "download_file_to_local") {
          payload = await downloadFileToLocal(
            message.params.arguments || {},
            callRemoteTool,
          );
        } else {
          payload = await exportProjectToLocal(
            message.params.arguments || {},
            callRemoteTool,
          );
        }
        writeToParent({
          jsonrpc: "2.0",
          id: message.id,
          result: localToolResult(payload),
        });
        return;
      }
      writeToChild(message);
    } catch (error) {
      if (
        message.method === "tools/call" &&
        LOCAL_TOOLS.some((tool) => tool.name === message.params?.name)
      ) {
        writeToParent({
          jsonrpc: "2.0",
          id: message.id ?? null,
          result: localToolError(error),
        });
      } else {
        writeToParent({
          jsonrpc: "2.0",
          id: message.id ?? null,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  });

  const rejectPending = (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  child.once("error", rejectPending);
  child.once("exit", () => {
    rejectPending(new Error("Remote Claude Design MCP stopped."));
    childLines.close();
    parentLines.close();
  });
  parentLines.once("close", () => {
    if (!child.stdin.destroyed) child.stdin.end();
  });
}

export async function startServer() {
  const existingStore = await readStore();
  if (!existingStore?.accessToken || !existingStore?.refreshToken) {
    process.stderr.write(
      "Claude Design is not yet connected. Opening the local login helper.\n",
    );
    await login();
  }
  const accessToken = await ensureAccessToken();
  const localBinary = resolveMcpRemote();
  const command = localBinary ? process.execPath : "npx";
  const commonArgs = [
    MCP_URL,
    "--silent",
    "--transport",
    "http-only",
    "--header",
    "Authorization:Bearer ${CODEX_CLAUDE_DESIGN_ACCESS_TOKEN}",
  ];
  const args = localBinary
    ? [localBinary, ...commonArgs]
    : ["-y", `mcp-remote@${MCP_REMOTE_VERSION}`, ...commonArgs];
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CODEX_CLAUDE_DESIGN_ACCESS_TOKEN: accessToken,
    },
  });

  child.stderr.on("data", (buffer) => {
    const text = String(buffer).replace(
      /Bearer\s+[A-Za-z0-9._~-]+/g,
      "Bearer [REDACTED]",
    );
    process.stderr.write(text);
  });
  startProtocolProxy(child);
  const stopChild = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once("SIGINT", () => stopChild("SIGINT"));
  process.once("SIGTERM", () => stopChild("SIGTERM"));

  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        resolve();
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`MCP proxy exited with code ${code ?? 1}`));
      }
    });
  });
}

async function main() {
  const command = process.argv[2] || "server";
  if (command === "server") {
    await startServer();
  } else if (command === "login") {
    await login({ launchBrowser: !process.argv.includes("--no-open") });
  } else if (command === "status") {
    await status();
  } else if (command === "logout") {
    await logout();
  } else {
    throw new Error("Usage: claude-design.mjs [server|login|status|logout]");
  }
}

const isMain =
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
