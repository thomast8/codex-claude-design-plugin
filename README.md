# Claude Design for Codex

A Codex plugin for working with and exporting live Claude Design projects and
prototypes.

Anthropic's Claude Design OAuth client uses a manual-code callback that is not
compatible with Codex's standard localhost MCP callback. This plugin bridges
that flow locally and forwards authenticated traffic to Anthropic's remote
Claude Design MCP server.

## Install from Codex

In Codex, add this GitHub repository as a plugin marketplace:

```text
thomast8/codex-claude-design-plugin
```

Then install **Claude Design** from the marketplace. The equivalent CLI
commands are:

```bash
codex plugin marketplace add thomast8/codex-claude-design-plugin
codex plugin add claude-design@claude-design
```

Start a new task after installation so Codex loads the plugin.

## Connector behaviour

When Claude Design is explicitly named, the plugin keeps the request on the
Claude Design connector. Verbs such as “open”, “read”, “download”, and “export”
do not route the task to a browser. Browser tooling is used only when requested
or for visual QA of the connector's short-lived preview URL.

The bridge adds two local tools to Anthropic's MCP surface:

- `download_file_to_local` downloads one project file as exact raw bytes,
  including PNG, JPEG, GIF, WebP, fonts, PDFs, and other binary assets.
- `export_project_to_local` creates a complete standalone local directory and
  a `.claude-design-export.json` manifest containing source etags, byte counts,
  content types, and SHA-256 hashes.

Both tools require a new absolute destination under the user's home or
temporary directory and refuse to overwrite existing paths.

## Multiple Claude accounts

Give each Claude account a short local name when you connect it. The local
browser helper shows an editable **Local profile name** field; `--account`
simply prefills it:

```bash
npm exec --yes \
  --package=github:thomast8/codex-claude-design-plugin \
  -- claude-design-codex login --account work

npm exec --yes \
  --package=github:thomast8/codex-claude-design-plugin \
  -- claude-design-codex login --account personal
```

Account names are local routing labels. During each login, check which Claude
account is active in the browser before approving access.

The same helper lists every saved profile with its login status and default
marker. **Remove** opens a separate confirmation page before deleting only that
profile's local credentials; the Claude account and its projects are untouched.

An unpinned Codex instance can route one call to a named account or change its
session route. For example, ask “List projects from my work Claude account” or
“Use my personal Claude account for the rest of this task.” The connector adds
an optional `account` field to each Claude Design tool and exposes
`set_session_account`; it never sends the local account label to Anthropic.

Set the account used by new unpinned instances:

```bash
npm exec --yes \
  --package=github:thomast8/codex-claude-design-plugin \
  -- claude-design-codex default work
```

Pin one Codex process so prompts cannot switch its account:

```bash
CODEX_CLAUDE_DESIGN_ACCOUNT=work codex
```

Manual MCP configurations can pin the bridge equivalently with
`claude-design-codex server --account work`. A pinned server does not publish
the session-switch tool or per-call account field.

## First-use authentication

The first Claude Design request opens a local browser helper. The helper keeps
the OAuth verifier on your machine while you:

1. Select **Authorise with Claude**.
2. Approve Claude Design in the new Claude tab.
3. Copy the short-lived `CODE#STATE` value Claude displays.
4. Return to the local helper tab and paste it there.

The helper exchanges the code directly with Anthropic, stores the resulting
credentials with owner-only permissions, and lets the pending Codex request
continue. Do not paste the code into chat.

Credentials are stored outside the plugin with one owner-only file per named
account:

```text
~/.config/codex-claude-design/accounts/<account>.json
```

Existing `~/.config/codex-claude-design/credentials.json` credentials continue
to work as the `default` account without migration.

To inspect or reset authentication without locating Codex's plugin cache:

```bash
npm exec --yes \
  --package=github:thomast8/codex-claude-design-plugin \
  -- claude-design-codex status --all

npm exec --yes \
  --package=github:thomast8/codex-claude-design-plugin \
  -- claude-design-codex logout --account personal
```

## Security notes

- The browser helper binds only to `127.0.0.1`, uses an unpredictable local
  form token, and shuts down after authentication or ten minutes.
- OAuth access and refresh tokens are never printed.
- Account labels are validated before they are used as file names, and one
  account can never read another account's credential file.
- Browser-based profile removal requires a form token and a second explicit
  confirmation; it never deletes Claude projects or remote account data.
- The access token is passed to the MCP bridge through a child-process
  environment variable, not a command-line argument.
- The remote endpoint is Anthropic's
  `https://api.anthropic.com/v1/design/mcp`.
- This is an independent community plugin and is not affiliated with or
  endorsed by Anthropic or OpenAI.

The bridge pins `mcp-remote` to version `0.1.37`. Its OAuth implementation is
adapted from `erdnj/claude-design-mcp` at commit
`5e50b691df5259668cf80fcd41766d4da17a80ce` under the MIT licence. See
[THIRD_PARTY_NOTICES.md](plugins/claude-design/THIRD_PARTY_NOTICES.md).

Documentation status: generated by Codex, last updated 10 August 2026, and not yet
human-reviewed.
