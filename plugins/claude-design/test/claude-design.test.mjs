import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const testDirectory = await mkdtemp(join(tmpdir(), "codex-claude-design-test-"));
delete process.env.CODEX_CLAUDE_DESIGN_CREDENTIALS;
process.env.CODEX_CLAUDE_DESIGN_CONFIG_DIR = testDirectory;

const {
  AUTHORISE_URL,
  DESIGN_CLIENT_ID,
  LOCAL_TOOLS,
  MANUAL_REDIRECT_URL,
  SCOPES,
  buildProjectFileUrl,
  buildAuthoriseUrl,
  configuredDefaultAccount,
  credentialPathForAccount,
  createPkce,
  decodeReadFilePayload,
  listAccountProfiles,
  parseCliArguments,
  parsePastedCode,
  renderLoginPage,
  renderRemoveAccountConfirmation,
  removeAccountCredentials,
  saveStore,
  setConfiguredDefaultAccount,
  toolsForAccountRouting,
  validateAccountName,
  validateRemoteFilePath,
  withoutAccountArgument,
} = await import("../scripts/claude-design.mjs");

test("authorisation URL uses the dedicated Design client and manual callback", () => {
  const url = new URL(
    buildAuthoriseUrl({ challenge: "challenge", state: "state" }),
  );
  assert.equal(url.origin + url.pathname, AUTHORISE_URL);
  assert.equal(url.searchParams.get("client_id"), DESIGN_CLIENT_ID);
  assert.equal(url.searchParams.get("redirect_uri"), MANUAL_REDIRECT_URL);
  assert.equal(url.searchParams.get("scope"), SCOPES.join(" "));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "state");
});

test("PKCE values use base64url characters", () => {
  const { verifier, challenge } = createPkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
});

test("manual code parser requires code and state", () => {
  assert.deepEqual(parsePastedCode("code#state"), {
    code: "code",
    state: "state",
  });
  assert.deepEqual(parsePastedCode("'code#state'"), {
    code: "code",
    state: "state",
  });
  assert.equal(parsePastedCode("code-only"), null);
  assert.equal(parsePastedCode("code#state#extra"), null);
});

test("manual login bridge lets the user name the local profile", () => {
  const html = renderLoginPage({
    authoriseUrl: "https://claude.example/authorize",
    formToken: "form-token",
    account: "personal",
    accountEditable: true,
  });
  assert.match(html, /Local profile name/);
  assert.match(html, /name="account" value="personal"/);
  assert.match(html, /pattern="\[a-z0-9\]\[a-z0-9_-\]\{0,31\}"/);
});

test("login bridge lists existing profiles without exposing credentials", () => {
  const html = renderLoginPage({
    authoriseUrl: "https://claude.example/authorize",
    formToken: "form-token",
    account: "personal",
    accountEditable: true,
    accounts: [
      { name: "default", default: true, status: "logged_in" },
      { name: "personal", default: false, status: "expired" },
    ],
  });
  assert.match(html, /Existing profiles/);
  assert.match(html, /<strong>default<\/strong> <span class="badge">default/);
  assert.match(html, /<strong>personal<\/strong>/);
  assert.match(html, /Logged in/);
  assert.match(html, /Expired/);
  assert.match(html, /action="\/remove-account"/);
  assert.doesNotMatch(html, /accessToken|refreshToken/);
});

test("account removal requires a separate confirmation form", () => {
  const html = renderRemoveAccountConfirmation({
    account: "personal",
    formToken: "form-token",
  });
  assert.match(html, /Remove local profile\?/);
  assert.match(html, /action="\/remove-account\/confirm"/);
  assert.match(html, /Remove personal/);
  assert.match(html, />Cancel</);
});

test("on-use login bridge locks the profile Codex requested", () => {
  const html = renderLoginPage({
    authoriseUrl: "https://claude.example/authorize",
    formToken: "form-token",
    account: "work",
  });
  assert.match(html, /Saving this connection as local profile <strong>work/);
  assert.doesNotMatch(html, /name="account"/);
});

test("credential store is written with owner-only permissions", async () => {
  await saveStore({
    accessToken: "test-token",
    refreshToken: "test-refresh",
    scopes: SCOPES,
  });
  const metadata = await stat(await credentialPathForAccount("default"));
  assert.equal(metadata.mode & 0o777, 0o600);
});

test("bridge publishes export and account routing tools", () => {
  assert.deepEqual(
    LOCAL_TOOLS.map((tool) => tool.name),
    [
      "download_file_to_local",
      "export_project_to_local",
      "list_accounts",
      "set_session_account",
    ],
  );
});

test("skill avoids read-only synced chats for native-agent handoff", async () => {
  const skill = await readFile(
    new URL("../skills/claude-design/SKILL.md", import.meta.url),
    "utf8",
  );
  assert.match(skill, /`claude auth status`/);
  assert.match(skill, /non-interactively with `claude -p`/);
  assert.match(skill, /Write the brief into the target project as `CODEX_HANDOFF\.md`/);
  assert.match(skill, /start a fresh Claude Design chat/);
  assert.match(skill, /`put_conversation` creates a synced chat that is read-only/);
  assert.doesNotMatch(skill, /type `Go`, and press Enter/);
});

test("named accounts use isolated credential files", async () => {
  await saveStore(
    {
      accessToken: "work-token",
      refreshToken: "work-refresh",
      scopes: SCOPES,
      expiresAt: Date.now() + 60_000,
    },
    { account: "work" },
  );
  await saveStore(
    {
      accessToken: "personal-token",
      refreshToken: "personal-refresh",
      scopes: SCOPES,
      expiresAt: Date.now() + 60_000,
    },
    { account: "personal" },
  );
  const workPath = await credentialPathForAccount("work");
  const personalPath = await credentialPathForAccount("personal");
  assert.notEqual(workPath, personalPath);
  assert.equal(JSON.parse(await readFile(workPath, "utf8")).accessToken, "work-token");
  assert.equal(
    JSON.parse(await readFile(personalPath, "utf8")).accessToken,
    "personal-token",
  );
  assert.equal((await stat(workPath)).mode & 0o777, 0o600);
  assert.equal((await stat(personalPath)).mode & 0o777, 0o600);
});

test("account removal deletes only the selected credential file", async () => {
  await saveStore(
    {
      accessToken: "remove-token",
      refreshToken: "remove-refresh",
      scopes: SCOPES,
      expiresAt: Date.now() + 60_000,
    },
    { account: "remove_me" },
  );
  const removePath = await credentialPathForAccount("remove_me");
  const workPath = await credentialPathForAccount("work");
  await removeAccountCredentials("remove_me");
  await assert.rejects(() => stat(removePath), { code: "ENOENT" });
  assert.equal((await stat(workPath)).mode & 0o777, 0o600);
});

test("configured default must name a logged-in account", async () => {
  assert.equal(await configuredDefaultAccount(), "default");
  await setConfiguredDefaultAccount("work");
  assert.equal(await configuredDefaultAccount(), "work");
  const profiles = await listAccountProfiles();
  assert.equal(profiles.find((profile) => profile.name === "work")?.default, true);
  await assert.rejects(() => setConfiguredDefaultAccount("missing"), /not logged in/);
});

test("account names reject traversal and ambiguous labels", () => {
  assert.equal(validateAccountName("work_2"), "work_2");
  assert.throws(() => validateAccountName("../work"));
  assert.throws(() => validateAccountName("Work"));
  assert.throws(() => validateAccountName("work account"));
});

test("unbound tool schemas accept per-call routing while pinned schemas do not", () => {
  const remoteTools = [
    {
      name: "list_projects",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { limit: { type: "number" } },
      },
    },
  ];
  const routed = toolsForAccountRouting(remoteTools);
  assert.ok(routed[0].inputSchema.properties.account);
  assert.ok(routed.some((tool) => tool.name === "set_session_account"));
  const pinned = toolsForAccountRouting(remoteTools, { pinned: true });
  assert.equal(pinned[0].inputSchema.properties.account, undefined);
  assert.equal(
    pinned.some((tool) => tool.name === "set_session_account"),
    false,
  );
  assert.deepEqual(remoteTools[0].inputSchema.properties, {
    limit: { type: "number" },
  });
});

test("local account labels are stripped before remote MCP calls", () => {
  assert.deepEqual(
    withoutAccountArgument({ account: "work", project_id: "project-id" }),
    { project_id: "project-id" },
  );
});

test("CLI account selection supports separate and inline flags", () => {
  assert.deepEqual(parseCliArguments(["--account", "work", "--no-open"]), {
    account: "work",
    all: false,
    noOpen: true,
    positional: [],
  });
  assert.equal(parseCliArguments(["--account=personal"]).account, "personal");
  assert.throws(() => parseCliArguments(["--account", "../work"]));
  assert.throws(() => parseCliArguments(["--unknown"]));
});

test("project asset URLs retain the scoped token and encode paths", () => {
  const url = buildProjectFileUrl(
    "https://project.claudeusercontent.com/v1/design/projects/id/serve/page.html?t=test-token&direct=1",
    "src/assets/Veridue logo.png",
  );
  assert.equal(
    url.pathname,
    "/v1/design/projects/id/serve/src/assets/Veridue%20logo.png",
  );
  assert.equal(url.searchParams.get("t"), "test-token");
  assert.equal(url.searchParams.get("direct"), "1");
});

test("project paths reject traversal and platform separators", () => {
  assert.equal(validateRemoteFilePath("src/assets/logo.png"), "src/assets/logo.png");
  assert.throws(() => validateRemoteFilePath("../logo.png"));
  assert.throws(() => validateRemoteFilePath("src\\logo.png"));
  assert.throws(() => validateRemoteFilePath("/logo.png"));
});

test("read_file wrappers decode exact text without collapsing literal entities", () => {
  const payload = [
    '<untrusted-project-content path="page.html" etag="etag-1" lines="1-2" total_lines="2">',
    "&lt;p&gt;&amp;lt;&lt;/p&gt;",
    "",
    "</untrusted-project-content>",
    "(wrapper note)",
  ].join("\n");
  assert.equal(
    decodeReadFilePayload(payload, "page.html", "etag-1"),
    "<p>&lt;</p>\n",
  );
});

test("read_file wrappers decode escaped paths", () => {
  const payload = [
    '<untrusted-project-content path="A &amp; B.html" etag="etag-2" lines="1-1" total_lines="1">',
    "content",
    "</untrusted-project-content>",
  ].join("\n");
  assert.equal(
    decodeReadFilePayload(payload, "A & B.html", "etag-2"),
    "content",
  );
});
