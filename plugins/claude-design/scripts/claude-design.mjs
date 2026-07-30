#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

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
const require = createRequire(import.meta.url);

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
      "User-Agent": "codex-claude-design/0.4.0",
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
    stdio: ["inherit", "inherit", "pipe"],
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
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
