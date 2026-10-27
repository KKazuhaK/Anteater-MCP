# MCPHub: direct shared and personal Anteater processes

`mcp_settings.example.json` is a settings-file/API configuration. The deployed
Hub v1.1.10 batch import UI rejects personal-template fields, even though the
Add/Edit form supports them. Use Advanced Options > Per-user credential slots
for the personal entry, or merge the full definition into the actual settings
file. Do not strip the personal template to work around an import error.

The primary `mcp_settings.example.json` launches Anteater over **stdio inside
MCPHub**, with no independent HTTP container or custom Hub image required. It
uses `npx` with a pinned GitHub source archive plus a pinned Node 24 package. This
avoids depending on the Hub's default Node 22 or an unpublished npm package.
The stock Hub image includes npm/npx and Git; first startup downloads packages,
so retain outbound access and writable package caches.

For a custom Hub image bundling source checkouts instead of runtime downloads,
use `mcp_settings.bundled.example.json` together with the Canvas checkout's
`deploy/mcphub/Dockerfile.hub` and Compose example. That optional configuration
expects `/opt/mcp/anteater/anteater-mcp.mjs` and `/opt/mcp/bin/node24`.

## Shared and personal entries

The server names `anteater-shared` and `anteater-personal` are stable identifiers that
clients and Hub bindings may key on; do not rename them. Each entry carries a
one-line `description` stating that it serves public UCI course data and stores no
personal data. Tool failures use the stable codes in the repository README's
"Errors" section, so a client can distinguish a rejected personal key
(`CREDENTIAL_INVALID`) from an outage (`SOURCE_UNAVAILABLE`).

- **anteater-shared** passes the Hub's `ANTEATER_SHARED_API_KEY` into the child's
  `ANTEATER_API_KEY`. Users share the upstream quota. Leave the Hub variable empty
  for anonymous upstream access. This is deliberately a separate server entry.
- **anteater-personal** declares a required `env.ANTEATER_API_KEY` credential
  slot. Every user binds their own secret key in Hub Credentials. The Hub starts
  and recycles one process per user; missing credentials do not fall back to the
  shared entry. Personal keys are not stored in the shared server definition.
  The personal stdio entries set `ANTEATER_API_KEY_SCOPE=user`, so a rejection of that
  key is reported as `CREDENTIAL_INVALID` (the user should update their key). The shared
  entry keeps the default `operator` scope: its rejection is `SOURCE_UNAVAILABLE`.

Clients use their own user-level Hub key or user OAuth authorization. Keep Hub
authentication enabled and ordinary users non-admin. `visibility: public` means
visible to authenticated Hub users, not anonymous internet access. Group/share
entries explicitly if only selected friends should see them. The host/operator
is trusted with credentials. Keep the entire Hub data directory and encryption
key across container replacements. Runtime file permissions and cache directories
must allow the Hub user to execute these bundled files.

No `ANTEATER_MCP_TOKEN` is needed for these stdio children: Hub authenticates the
remote clients. Existing HTTP deployments still require that token. Keep an old
HTTP container only if other clients still use its URL; verify the new stdio
connections before retiring anything.

## Market draft

`market-manifest.json` follows MCPM's public catalog schema. It uses `npx` with
an explicit Node 24 package and a pinned Git source revision. The npm package
`anteater-mcp` was not available in the public registry when this configuration
was prepared, so the draft does not reference an unpublishable package version.
It installs the pinned source, not uncommitted local HTTP changes. Those changes
are not required for personal/shared **stdio** processes.

MCPHub's Docker build downloads the catalog from `mcpm.sh/api/servers.json`.
Public submission should add `anteater-mcp.json` under
`pathintegral-institute/mcpm.sh/mcp-registry/servers/` and run that project's
`scripts/validate_manifest.py`. The schema requires name, display name,
description, repository, license and an installation method. Do not mark this as
an official UCI service. Acceptance remains the directory maintainers' decision.

The Market install UI currently seeds command/args/env but does not automatically
transfer our personal credential template. An admin must add the personal env
slot after installation, or import the prepared multi-user settings. Never fill
an operator's shared API key into the personal entry's static environment.
A private Market can merge the draft into its complete `servers.json` and mount
that catalog at `/app/servers.json`; retain existing entries.

## Alternative: keep the HTTP service

The earlier HTTP configuration is retained as `mcp_settings.http.example.json`.
It requires a separate Anteater deployment. Both entries send
`Authorization: Bearer <ANTEATER_MCP_TOKEN>`; the personal entry additionally
binds the `X-Anteater-Api-Key` header. Deploy the new HTTP source before enabling
that personal entry: an older image may ignore the header and use its default key.

From the Anteater repository root, the existing source-build override is:

```sh
docker compose -f compose.yaml -f deploy/mcphub/compose.build.yaml up -d --build
```

This override is for a standalone Anteater HTTP container, not the direct Hub
mode. The HTTP gate secret is different from both the Hub user key and the
upstream Anteater API key. Do not forward client Authorization headers as this
transport secret. Personal HTTP keys are never sent in query strings; a rejected
personal key is not retried with the shared key. Local HTTP tests cover concurrency,
credential-separated caches, transport auth and error behavior.

Preparing these files does not deploy, publish a package or submit a catalog PR.
Confirm the actual Hub build, each user's binding and a read-only call before
retiring the old deployment.

## Verified deployed behavior

On the deployed Hub v1.1.10, the npm Git fetcher failed with
`GitFetcher requires an Arborist constructor to pack a tarball`. The configuration
therefore uses GitHub's `codeload.github.com/.../tar.gz/<commit>` archive for
Anteater, preserving the exact source revision without npm's Git pack step.
The public Anteater entry connected with 20 tools, 6 prompts and 4 resources.
The Credentials page exposed the required Canvas URL/token and Anteater API-key
slots. Actual personal calls still require each user's own binding. No live
Canvas credentials were entered during configuration.

## Version labels for pinned source installations

The stock Hub updater selects the first explicit npx package. Put the pinned
Anteater source archive before the Node runtime package so Node's version is not
reported as the server's version. The source archive is not an npm registry
package, so the Hub omits the registry update badge instead of inventing an
Anteater upgrade. Record the application version and source revision in the
server note. For Canvas, the existing published pin retains its named Git-package spec,
which correctly identifies the installed 1.14.0 but can show an unrelated upstream
PyPI update. A local server fix now explicitly reports the application version
in the MCP handshake. After publishing that fix, an unnamed VCS `--from` spec
with `[documents]` can avoid the unrelated registry comparison. Without the
server fix, that fallback would incorrectly show the FastMCP framework version. Do not relabel the fork as upstream 1.16 without porting the matching code.

Prepare and test launcher corrections before changing live entries. Preserve
the server name and env-slot declarations and verify binding status afterwards.
Renaming while changing connection fields, or changing a personal OAuth server
definition, can require authorization again; never assume bindings survived.
