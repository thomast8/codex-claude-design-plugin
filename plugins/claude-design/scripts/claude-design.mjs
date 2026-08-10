#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
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
export const CONFIG_DIR =
  process.env.CODEX_CLAUDE_DESIGN_CONFIG_DIR ||
  join(homedir(), ".config", "codex-claude-design");
export const STORE_PATH =
  process.env.CODEX_CLAUDE_DESIGN_CREDENTIALS ||
  join(CONFIG_DIR, "credentials.json");
export const ACCOUNTS_DIR = join(CONFIG_DIR, "accounts");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const DEFAULT_ACCOUNT = "default";

const REFRESH_SKEW_MS = 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const MCP_REMOTE_VERSION = "0.1.37";
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_EXPORT_BYTES = 512 * 1024 * 1024;
const MAX_EXPORT_FILES = 20_000;
const EXPORT_MANIFEST = ".claude-design-export.json";
const require = createRequire(import.meta.url);

const ACCOUNT_PROPERTY = {
  type: "string",
  pattern: "^[a-z0-9][a-z0-9_-]{0,31}$",
  description:
    "Optional named Claude account for this call. Omit it to use the session route.",
};

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
        account: ACCOUNT_PROPERTY,
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
        account: ACCOUNT_PROPERTY,
      },
    },
  },
  {
    name: "list_accounts",
    description:
      "List configured Claude Design account profiles and show the current session route. Never returns credentials or tokens.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "set_session_account",
    description:
      "Route subsequent Claude Design calls in this Codex instance to a named account. This changes only the running session and does not change the persistent default.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["account"],
      properties: {
        account: {
          ...ACCOUNT_PROPERTY,
          description: "Named Claude account to use for subsequent calls.",
        },
      },
    },
  },
];

export function validateAccountName(account) {
  if (
    typeof account !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(account)
  ) {
    throw new Error(
      "Account names must be 1-32 lowercase letters, numbers, underscores, or hyphens, and must start with a letter or number.",
    );
  }
  return account;
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function credentialPathForAccount(account = DEFAULT_ACCOUNT) {
  const safeAccount = validateAccountName(account);
  if (process.env.CODEX_CLAUDE_DESIGN_CREDENTIALS) {
    if (safeAccount !== DEFAULT_ACCOUNT) {
      throw new Error(
        "CODEX_CLAUDE_DESIGN_CREDENTIALS fixes this process to the default account. Use CODEX_CLAUDE_DESIGN_CONFIG_DIR for named accounts.",
      );
    }
    return STORE_PATH;
  }
  const accountPath = join(ACCOUNTS_DIR, `${safeAccount}.json`);
  if (
    safeAccount === DEFAULT_ACCOUNT &&
    !(await pathExists(accountPath)) &&
    (await pathExists(STORE_PATH))
  ) {
    return STORE_PATH;
  }
  return accountPath;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readConfig() {
  return (await readJson(CONFIG_PATH)) || {};
}

async function saveConfig(config) {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await chmod(CONFIG_DIR, 0o700);
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(CONFIG_PATH, 0o600);
}

export async function configuredDefaultAccount() {
  const config = await readConfig();
  return config.defaultAccount
    ? validateAccountName(config.defaultAccount)
    : DEFAULT_ACCOUNT;
}

export async function setConfiguredDefaultAccount(account) {
  const safeAccount = validateAccountName(account);
  const store = await readAccountStore(safeAccount);
  if (!store?.accessToken || !store?.refreshToken) {
    throw new Error(
      `Claude Design account '${safeAccount}' is not logged in. Run login --account ${safeAccount} first.`,
    );
  }
  const config = await readConfig();
  await saveConfig({ ...config, defaultAccount: safeAccount });
  return safeAccount;
}

export async function listAccountProfiles() {
  const names = new Set();
  if (await pathExists(STORE_PATH)) names.add(DEFAULT_ACCOUNT);
  try {
    for (const entry of await readdir(ACCOUNTS_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const name = entry.name.slice(0, -5);
      try {
        names.add(validateAccountName(name));
      } catch {
        // Ignore unrelated files in the credentials directory.
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const configuredDefault = await configuredDefaultAccount();
  const profiles = [];
  for (const name of [...names].sort()) {
    const store = await readAccountStore(name);
    profiles.push({
      name,
      default: name === configuredDefault,
      status:
        store?.accessToken && store?.refreshToken
          ? !store.expiresAt || Date.now() >= store.expiresAt
            ? "expired"
            : "logged_in"
          : "logged_out",
      expiresAt: store?.expiresAt || null,
    });
  }
  return profiles;
}

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

async function readAccountStore(account = DEFAULT_ACCOUNT) {
  return readJson(await credentialPathForAccount(account));
}

export async function saveStore(
  data,
  { account = DEFAULT_ACCOUNT, storePath } = {},
) {
  const targetPath = storePath || (await credentialPathForAccount(account));
  const storeDirectory = dirname(targetPath);
  await mkdir(storeDirectory, { recursive: true, mode: 0o700 });
  await chmod(storeDirectory, 0o700);
  await writeFile(targetPath, `${JSON.stringify(data, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(targetPath, 0o600);
}

async function requestTokens(body, label) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "codex-claude-design/0.6.1",
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

async function refreshStore(store, { account, storePath }) {
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
  await saveStore(next, { account, storePath });
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

export async function ensureAccessToken({
  forceRefresh = false,
  account = DEFAULT_ACCOUNT,
} = {}) {
  const safeAccount = validateAccountName(account);
  const storePath = await credentialPathForAccount(safeAccount);
  let store = await readJson(storePath);
  if (!store?.accessToken || !store?.refreshToken) {
    throw new Error(
      `Claude Design account '${safeAccount}' is not logged in. Run the plugin login command with --account ${safeAccount}.`,
    );
  }
  const shouldRefresh =
    forceRefresh ||
    !store.expiresAt ||
    Date.now() >= store.expiresAt - REFRESH_SKEW_MS;
  if (shouldRefresh) {
    store = await refreshStore(store, { account: safeAccount, storePath });
  }
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

export function renderLoginPage({
  authoriseUrl,
  formToken,
  account = DEFAULT_ACCOUNT,
  accountEditable = false,
  accounts = [],
  error = "",
  notice = "",
}) {
  const accountRows = accounts
    .map((profile) => {
      const status =
        profile.status === "logged_in"
          ? "Logged in"
          : profile.status === "expired"
            ? "Expired"
            : "Logged out";
      return `<li>
        <span><strong>${escapeHtml(profile.name)}</strong>${profile.default ? " <span class=\"badge\">default</span>" : ""}<br><span class="fine">${status}</span></span>
        <form method="post" action="/remove-account">
          <input type="hidden" name="form_token" value="${escapeHtml(formToken)}">
          <input type="hidden" name="account" value="${escapeHtml(profile.name)}">
          <button class="danger" type="submit">Remove</button>
        </form>
      </li>`;
    })
    .join("\n");
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
    button.danger { background: transparent; color: #c33; border: 1px solid currentColor; padding: .45rem .7rem; }
    label { display: block; margin: 1.5rem 0 .5rem; font-weight: 650; }
    input { box-sizing: border-box; width: 100%; padding: .75rem; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); border-radius: .5rem; font: inherit; }
    .error { color: #c33; }
    .notice { color: #287a3e; }
    .fine { font-size: .875rem; opacity: .75; }
    .accounts { margin-top: 2rem; padding-top: 1.5rem; border-top: 1px solid color-mix(in srgb, CanvasText 20%, transparent); }
    .accounts ul { list-style: none; padding: 0; }
    .accounts li { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: .75rem 0; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent); }
    .accounts form { margin: 0; }
    .badge { display: inline-block; padding: .1rem .4rem; border-radius: 999px; background: color-mix(in srgb, CanvasText 12%, transparent); font-size: .75rem; font-weight: 650; }
  </style>
</head>
<body>
  <main>
    <h1>Connect Claude Design</h1>
    <p>Make sure Claude is signed in to the account you want to connect, then approve Design access. Claude will display a short-lived <code>CODE#STATE</code> value.</p>
    <p><a href="${escapeHtml(authoriseUrl)}" target="_blank" rel="noreferrer">Authorise with Claude</a></p>
    ${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    <form method="post" action="/complete">
      <input type="hidden" name="form_token" value="${escapeHtml(formToken)}">
      ${
        accountEditable
          ? `<label for="account">Local profile name</label>
      <input id="account" name="account" value="${escapeHtml(account)}" pattern="[a-z0-9][a-z0-9_-]{0,31}" maxlength="32" autocomplete="off" spellcheck="false" required>
      <p class="fine">Use 1–32 lowercase letters, numbers, underscores, or hyphens. This name stays on your machine.</p>`
          : `<p>Saving this connection as local profile <strong>${escapeHtml(account)}</strong>.</p>`
      }
      <label for="code">Paste the full CODE#STATE value</label>
      <input id="code" name="code" autocomplete="off" spellcheck="false" required>
      <p><button type="submit">Finish connection</button></p>
    </form>
    <p class="fine">This helper is running only on 127.0.0.1. The code is sent directly to Anthropic and is not added to Codex chat.</p>
    <section class="accounts">
      <h2>Existing profiles</h2>
      ${accountRows ? `<ul>${accountRows}</ul>` : '<p class="fine">No saved Claude Design profiles.</p>'}
    </section>
  </main>
</body>
</html>`;
}

export function renderRemoveAccountConfirmation({ account, formToken }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Remove Claude Design profile</title></head>
<body style="font-family:system-ui,sans-serif;margin:3rem;max-width:38rem">
  <h1>Remove local profile?</h1>
  <p>This will delete the stored Claude Design credentials for <strong>${escapeHtml(account)}</strong> from this machine. Other profiles are not affected, and you can reconnect this account later.</p>
  <form method="post" action="/remove-account/confirm">
    <input type="hidden" name="form_token" value="${escapeHtml(formToken)}">
    <input type="hidden" name="account" value="${escapeHtml(account)}">
    <button type="submit" style="border:0;border-radius:.6rem;padding:.75rem 1rem;background:#c33;color:white;font:inherit;font-weight:650;cursor:pointer">Remove ${escapeHtml(account)}</button>
    <a href="/" style="margin-left:1rem">Cancel</a>
  </form>
</body></html>`;
}

function renderSuccessPage(account = DEFAULT_ACCOUNT) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Claude Design connected</title></head>
<body style="font-family:system-ui,sans-serif;margin:3rem"><h1>Claude Design connected</h1><p>Profile <strong>${escapeHtml(account)}</strong> is ready. You can close this tab and return to Codex.</p></body></html>`;
}

async function readForm(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new Error("Form response is too large.");
  }
  return new URLSearchParams(body);
}

export async function login({
  launchBrowser = true,
  account = DEFAULT_ACCOUNT,
  allowAccountRename = true,
} = {}) {
  const safeAccount = validateAccountName(account);
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
    const profilesForPage = async () => {
      try {
        return await listAccountProfiles();
      } catch {
        return [];
      }
    };
    const sendLoginPage = async (
      status,
      { error = "", notice = "" } = {},
    ) => {
      send(
        status,
        renderLoginPage({
          authoriseUrl,
          formToken,
          account: safeAccount,
          accountEditable: allowAccountRename,
          accounts: await profilesForPage(),
          error,
          notice,
        }),
      );
    };

    try {
      if (request.method === "GET" && request.url === "/") {
        await sendLoginPage(200);
        return;
      }
      if (
        request.method !== "POST" ||
        ![
          "/complete",
          "/remove-account",
          "/remove-account/confirm",
        ].includes(request.url)
      ) {
        send(404, "<h1>Not found</h1>");
        return;
      }

      const form = await readForm(request);
      if (form.get("form_token") !== formToken) {
        throw new Error("The local login form has expired. Start the flow again.");
      }
      if (request.url === "/remove-account") {
        const accountToRemove = validateAccountName(form.get("account") || "");
        const profiles = await listAccountProfiles();
        if (!profiles.some((profile) => profile.name === accountToRemove)) {
          throw new Error(`Local profile '${accountToRemove}' was not found.`);
        }
        send(
          200,
          renderRemoveAccountConfirmation({
            account: accountToRemove,
            formToken,
          }),
        );
        return;
      }
      if (request.url === "/remove-account/confirm") {
        const accountToRemove = validateAccountName(form.get("account") || "");
        const profiles = await listAccountProfiles();
        if (!profiles.some((profile) => profile.name === accountToRemove)) {
          throw new Error(`Local profile '${accountToRemove}' was not found.`);
        }
        await removeAccountCredentials(accountToRemove);
        await sendLoginPage(200, {
          notice: `Removed local profile '${accountToRemove}'.`,
        });
        return;
      }
      const submittedAccount = allowAccountRename
        ? validateAccountName(form.get("account") || "")
        : safeAccount;
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
      await saveStore(store, { account: submittedAccount });
      send(200, renderSuccessPage(submittedAccount));
      settled = true;
      resolveLogin({ ...store, account: submittedAccount });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await sendLoginPage(400, { error: message });
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
  process.stderr.write(`Claude Design login (${safeAccount}): ${localUrl}\n`);
  if (launchBrowser) openBrowser(localUrl);

  const timeout = setTimeout(() => {
    if (!settled) rejectLogin(new Error("Claude Design login timed out."));
  }, LOGIN_TIMEOUT_MS);
  try {
    const store = await completion;
    process.stderr.write(`Claude Design account '${store.account}' authorised.\n`);
    return store;
  } finally {
    clearTimeout(timeout);
    server.close();
  }
}

export async function status(account = DEFAULT_ACCOUNT) {
  const safeAccount = validateAccountName(account);
  const storePath = await credentialPathForAccount(safeAccount);
  const store = await readJson(storePath);
  console.log(`account: ${safeAccount}`);
  if (!store) {
    console.log("status: logged_out");
    console.log(`credentials: ${storePath}`);
    return;
  }
  const expired = !store.expiresAt || Date.now() >= store.expiresAt;
  console.log(`status: ${expired ? "expired" : "logged_in"}`);
  console.log(`credentials: ${storePath}`);
  console.log(`scopes: ${(store.scopes || []).join(" ")}`);
  console.log(
    `expires: ${store.expiresAt ? new Date(store.expiresAt).toISOString() : "unknown"}`,
  );
}

export async function logout(account = DEFAULT_ACCOUNT) {
  const safeAccount = validateAccountName(account);
  const storePath = await removeAccountCredentials(safeAccount);
  console.log(`Removed Claude Design account '${safeAccount}' at ${storePath}`);
}

export async function removeAccountCredentials(account) {
  const safeAccount = validateAccountName(account);
  const storePath = await credentialPathForAccount(safeAccount);
  await rm(storePath, { force: true });
  return storePath;
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
    headers: { "User-Agent": "codex-claude-design/0.6.1" },
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

export function withoutAccountArgument(arguments_ = {}) {
  const { account: _account, ...remoteArguments } = arguments_;
  return remoteArguments;
}

function toolWithAccountRoute(tool) {
  const inputSchema = tool.inputSchema || { type: "object", properties: {} };
  if (inputSchema.type !== "object") return tool;
  if (inputSchema.properties?.account) {
    throw new Error(`Remote tool '${tool.name}' already defines account.`);
  }
  return {
    ...tool,
    inputSchema: {
      ...inputSchema,
      properties: {
        ...(inputSchema.properties || {}),
        account: ACCOUNT_PROPERTY,
      },
    },
  };
}

function toolWithoutAccountRoute(tool) {
  if (tool.name === "set_session_account") return null;
  const inputSchema = tool.inputSchema;
  if (inputSchema?.type !== "object" || !inputSchema.properties?.account) {
    return tool;
  }
  const { account: _account, ...properties } = inputSchema.properties;
  return { ...tool, inputSchema: { ...inputSchema, properties } };
}

export function toolsForAccountRouting(remoteTools, { pinned = false } = {}) {
  const collision = remoteTools.find((remoteTool) =>
    LOCAL_TOOLS.some((localTool) => localTool.name === remoteTool.name),
  );
  if (collision) throw new Error(`Remote tool collision: ${collision.name}`);
  if (pinned) {
    return [...remoteTools, ...LOCAL_TOOLS]
      .map(toolWithoutAccountRoute)
      .filter(Boolean);
  }
  return [
    ...remoteTools.map(toolWithAccountRoute),
    ...LOCAL_TOOLS,
  ];
}

function spawnRemote(accessToken) {
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
  return child;
}

class RemoteConnection {
  constructor(account, accessToken, onUnhandledMessage, onClose) {
    this.account = account;
    this.closed = false;
    this.child = spawnRemote(accessToken);
    this.pending = new Map();
    this.nextInternalId = 1;
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        process.stderr.write(
          `Claude Design bridge ignored non-JSON output from '${account}'.\n`,
        );
        return;
      }
      const waiter = this.pending.get(message.id);
      if (waiter) {
        this.pending.delete(message.id);
        if (message.error) {
          waiter.reject(
            new Error(message.error.message || "Remote MCP request failed."),
          );
        } else {
          waiter.resolve(message.result);
        }
        return;
      }
      onUnhandledMessage(this, message);
    });
    const rejectPending = (error) => {
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
    };
    const close = (error) => {
      if (this.closed) return;
      this.closed = true;
      rejectPending(error);
      onClose(this);
    };
    this.child.once("error", (error) => close(error));
    this.child.once("exit", () => {
      close(new Error(`Claude Design account '${account}' stopped.`));
      this.lines.close();
    });
  }

  send(message) {
    if (this.closed || this.child.stdin.destroyed) {
      throw new Error(`Claude Design account '${this.account}' is not running.`);
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    return new Promise((resolveRequest, rejectRequest) => {
      const id = `claude-design-bridge-${this.nextInternalId++}`;
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        rejectRequest(error);
      }
    });
  }

  stop(signal = "SIGTERM") {
    if (!this.child.killed) this.child.kill(signal);
  }
}

function startProtocolProxy({ initialAccount, pinned }) {
  const connections = new Map();
  const startingConnections = new Map();
  const serverRequests = new Map();
  let currentAccount = initialAccount;
  let initialiseParams;
  let initialised = false;
  let nextServerRequestId = 1;
  const parentLines = createInterface({ input: process.stdin });

  const writeToParent = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  const handleUnhandledMessage = (connection, message) => {
    if (message.method && message.id !== undefined) {
      const parentId = `claude-design-server-${nextServerRequestId++}`;
      serverRequests.set(parentId, { connection, childId: message.id });
      writeToParent({ ...message, id: parentId });
      return;
    }
    writeToParent(message);
  };

  const ensureConnection = async (account) => {
    const safeAccount = validateAccountName(account);
    if (connections.has(safeAccount)) return connections.get(safeAccount);
    if (startingConnections.has(safeAccount)) {
      return startingConnections.get(safeAccount);
    }
    const starting = (async () => {
      try {
        await ensureAccessToken({ account: safeAccount });
      } catch (error) {
        if (!String(error?.message || error).includes("is not logged in")) {
          throw error;
        }
        process.stderr.write(
          `Claude Design account '${safeAccount}' is not connected. Opening the local login helper.\n`,
        );
        await login({ account: safeAccount, allowAccountRename: false });
      }
      const accessToken = await ensureAccessToken({ account: safeAccount });
      const connection = new RemoteConnection(
        safeAccount,
        accessToken,
        handleUnhandledMessage,
        (closedConnection) => {
          if (connections.get(safeAccount) === closedConnection) {
            connections.delete(safeAccount);
          }
        },
      );
      try {
        if (initialiseParams) {
          await connection.request("initialize", initialiseParams);
          if (initialised) {
            connection.send({
              jsonrpc: "2.0",
              method: "notifications/initialized",
            });
          }
        }
      } catch (error) {
        connection.stop();
        throw error;
      }
      connections.set(safeAccount, connection);
      return connection;
    })();
    startingConnections.set(safeAccount, starting);
    try {
      return await starting;
    } finally {
      startingConnections.delete(safeAccount);
    }
  };

  const accountForArguments = (arguments_ = {}) => {
    const requested = arguments_.account;
    if (!requested) return currentAccount;
    const safeRequested = validateAccountName(requested);
    if (pinned && safeRequested !== currentAccount) {
      throw new Error(
        `This Codex instance is pinned to Claude Design account '${currentAccount}'.`,
      );
    }
    return safeRequested;
  };

  parentLines.on("line", async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write("Claude Design bridge ignored non-JSON input.\n");
      return;
    }

    try {
      if (!message.method && message.id !== undefined) {
        const serverRequest = serverRequests.get(message.id);
        if (serverRequest) {
          serverRequests.delete(message.id);
          serverRequest.connection.send({
            ...message,
            id: serverRequest.childId,
          });
        }
        return;
      }

      if (message.method === "initialize" && message.id !== undefined) {
        const params = message.params || {};
        const connection = await ensureConnection(currentAccount);
        const result = await connection.request("initialize", params);
        initialiseParams = params;
        writeToParent({ jsonrpc: "2.0", id: message.id, result });
        return;
      }

      if (message.method === "notifications/initialized") {
        initialised = true;
        for (const connection of connections.values()) connection.send(message);
        return;
      }

      if (message.method === "tools/list" && message.id !== undefined) {
        const connection = await ensureConnection(currentAccount);
        const result = await connection.request(
          "tools/list",
          message.params || {},
        );
        const remoteTools = Array.isArray(result?.tools) ? result.tools : [];
        writeToParent({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            ...result,
            tools: toolsForAccountRouting(remoteTools, { pinned }),
          },
        });
        return;
      }

      if (message.method === "tools/call" && message.id !== undefined) {
        const toolName = message.params?.name;
        const arguments_ = message.params?.arguments || {};
        let payload;
        if (toolName === "list_accounts") {
          payload = {
            current_account: currentAccount,
            pinned,
            accounts: await listAccountProfiles(),
          };
        } else if (toolName === "set_session_account") {
          if (pinned) {
            throw new Error(
              `This Codex instance is pinned to Claude Design account '${currentAccount}'.`,
            );
          }
          const nextAccount = validateAccountName(arguments_.account);
          await ensureConnection(nextAccount);
          currentAccount = nextAccount;
          payload = { current_account: currentAccount, pinned: false };
        } else if (toolName === "download_file_to_local") {
          const account = accountForArguments(arguments_);
          const connection = await ensureConnection(account);
          payload = await downloadFileToLocal(
            withoutAccountArgument(arguments_),
            (name, remoteArguments) =>
              connection.request("tools/call", {
                name,
                arguments: remoteArguments,
              }),
          );
        } else if (toolName === "export_project_to_local") {
          const account = accountForArguments(arguments_);
          const connection = await ensureConnection(account);
          payload = await exportProjectToLocal(
            withoutAccountArgument(arguments_),
            (name, remoteArguments) =>
              connection.request("tools/call", {
                name,
                arguments: remoteArguments,
              }),
          );
        } else {
          const account = accountForArguments(arguments_);
          const connection = await ensureConnection(account);
          const result = await connection.request("tools/call", {
            ...message.params,
            arguments: withoutAccountArgument(arguments_),
          });
          writeToParent({ jsonrpc: "2.0", id: message.id, result });
          return;
        }
        writeToParent({
          jsonrpc: "2.0",
          id: message.id,
          result: localToolResult(payload),
        });
        return;
      }

      const connection = await ensureConnection(currentAccount);
      if (message.id !== undefined) {
        const result = await connection.request(
          message.method,
          message.params || {},
        );
        writeToParent({ jsonrpc: "2.0", id: message.id, result });
      } else {
        connection.send(message);
      }
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

  parentLines.once("close", () => {
    for (const connection of connections.values()) connection.stop();
  });
  return {
    stop(signal = "SIGTERM") {
      parentLines.close();
      for (const connection of connections.values()) connection.stop(signal);
    },
  };
}

export async function startServer({ account, pinned = false } = {}) {
  const initialAccount = account || (await configuredDefaultAccount());
  validateAccountName(initialAccount);
  const proxy = startProtocolProxy({ initialAccount, pinned });
  await new Promise((resolve) => {
    let finished = false;
    const finish = (signal = "SIGTERM") => {
      if (finished) return;
      finished = true;
      proxy.stop(signal);
      resolve();
    };
    process.once("SIGINT", () => finish("SIGINT"));
    process.once("SIGTERM", () => finish("SIGTERM"));
    process.stdin.once("end", () => finish());
  });
}

export function parseCliArguments(argv) {
  const positional = [];
  let account;
  let noOpen = false;
  let all = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--account") {
      if (account !== undefined || index + 1 >= argv.length) {
        throw new Error("--account requires one account name.");
      }
      account = validateAccountName(argv[++index]);
    } else if (argument.startsWith("--account=")) {
      if (account !== undefined) throw new Error("--account was provided twice.");
      account = validateAccountName(argument.slice("--account=".length));
    } else if (argument === "--no-open") {
      noOpen = true;
    } else if (argument === "--all") {
      all = true;
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  return { account, all, noOpen, positional };
}

async function main() {
  const command = process.argv[2] || "server";
  const parsed = parseCliArguments(process.argv.slice(3));
  const environmentAccount = process.env.CODEX_CLAUDE_DESIGN_ACCOUNT
    ? validateAccountName(process.env.CODEX_CLAUDE_DESIGN_ACCOUNT)
    : undefined;
  const selectedAccount =
    parsed.account || environmentAccount || (await configuredDefaultAccount());
  if (command === "server") {
    if (parsed.positional.length || parsed.all || parsed.noOpen) {
      throw new Error("Usage: claude-design-codex server [--account NAME]");
    }
    await startServer({
      account: selectedAccount,
      pinned: Boolean(parsed.account || environmentAccount),
    });
  } else if (command === "login") {
    if (parsed.positional.length || parsed.all) {
      throw new Error(
        "Usage: claude-design-codex login [--account NAME] [--no-open]",
      );
    }
    await login({ launchBrowser: !parsed.noOpen, account: selectedAccount });
  } else if (command === "status") {
    if (
      parsed.positional.length ||
      parsed.noOpen ||
      (parsed.all && parsed.account)
    ) {
      throw new Error(
        "Usage: claude-design-codex status [--account NAME | --all]",
      );
    }
    if (parsed.all) {
      const profiles = await listAccountProfiles();
      if (profiles.length === 0) console.log("No Claude Design accounts found.");
      for (const profile of profiles) {
        console.log(
          `${profile.name}${profile.default ? " (default)" : ""}: ${profile.status}`,
        );
      }
    } else {
      await status(selectedAccount);
    }
  } else if (command === "logout") {
    if (parsed.positional.length || parsed.all || parsed.noOpen) {
      throw new Error("Usage: claude-design-codex logout [--account NAME]");
    }
    await logout(selectedAccount);
  } else if (command === "accounts") {
    if (parsed.positional.length || parsed.account || parsed.all || parsed.noOpen) {
      throw new Error("Usage: claude-design-codex accounts");
    }
    const profiles = await listAccountProfiles();
    if (profiles.length === 0) console.log("No Claude Design accounts found.");
    for (const profile of profiles) {
      console.log(
        `${profile.name}${profile.default ? " (default)" : ""}: ${profile.status}`,
      );
    }
  } else if (command === "default") {
    if (parsed.account || parsed.all || parsed.noOpen || parsed.positional.length > 1) {
      throw new Error("Usage: claude-design-codex default [ACCOUNT]");
    }
    if (parsed.positional.length === 0) {
      console.log(await configuredDefaultAccount());
    } else {
      const account = await setConfiguredDefaultAccount(parsed.positional[0]);
      console.log(`Default Claude Design account: ${account}`);
    }
  } else {
    throw new Error(
      "Usage: claude-design-codex [server|login|status|logout|accounts|default]",
    );
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
