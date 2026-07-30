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
  MANUAL_REDIRECT_URL,
  SCOPES,
  STORE_PATH,
  buildAuthoriseUrl,
  createPkce,
  parsePastedCode,
  saveStore,
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
