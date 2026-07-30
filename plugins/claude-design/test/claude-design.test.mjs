import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const testDirectory = await mkdtemp(join(tmpdir(), "codex-claude-design-test-"));
process.env.CODEX_CLAUDE_DESIGN_CREDENTIALS = join(
  testDirectory,
  "credentials.json",
);

const {
  AUTHORISE_URL,
  DESIGN_CLIENT_ID,
  LOCAL_TOOLS,
  MANUAL_REDIRECT_URL,
  SCOPES,
  STORE_PATH,
  buildProjectFileUrl,
  buildAuthoriseUrl,
  createPkce,
  decodeReadFilePayload,
  parsePastedCode,
  saveStore,
  validateRemoteFilePath,
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

test("credential store is written with owner-only permissions", async () => {
  await saveStore({
    accessToken: "test-token",
    refreshToken: "test-refresh",
    scopes: SCOPES,
  });
  const metadata = await stat(STORE_PATH);
  assert.equal(metadata.mode & 0o777, 0o600);
});

test("bridge publishes exact local file and project export tools", () => {
  assert.deepEqual(
    LOCAL_TOOLS.map((tool) => tool.name),
    ["download_file_to_local", "export_project_to_local"],
  );
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
