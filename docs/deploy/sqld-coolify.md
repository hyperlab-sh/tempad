# Self-hosting sqld on Coolify for push sync

`tempad sync` pushes to and pulls from one sqld (the libSQL server). This page covers running that server on Coolify and wiring each host to it. Design: `docs/specs/push-sync.md`.

The server behaviour below was checked against the `tursodatabase/libsql` sources on 2026-10-16 (`main`). Claims marked "(tested)" are also exercised by `packages/core/test/sync/sqld.integration.test.ts` against `ghcr.io/tursodatabase/libsql-server@sha256:6dd3eb276d9d3604e4a48ac4a999a2e267814732d57d7e94c04ba71482333a67` (`latest` as pulled on 2026-10-16, image created 2026-08-23).

## 1. The server

| Item          | Value                                                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Image         | `ghcr.io/tursodatabase/libsql-server`. The digest below is a multi-arch index (amd64 and arm64), so one reference works on either host.       |
| HTTP / Hrana  | `8080` (`SQLD_HTTP_LISTEN_ADDR`, the image defaults it to `0.0.0.0:8080`). This is the only port tempad uses.                                 |
| gRPC          | `5001`, for replica-to-primary traffic. tempad does not need it. `SQLD_NODE=standalone` stops the image opening it.                           |
| Data          | `/var/lib/sqld`, declared as the image `VOLUME` and its working directory. Mount a persistent volume here.                                    |
| Database path | `SQLD_DB_PATH`, default `iku.db`, relative to `/var/lib/sqld`. Treat the whole directory as the database; never copy a single file out of it. |

**Pin the image.** The registry publishes `latest`, version tags and short-git-SHA tags, listed at <https://github.com/tursodatabase/libsql/pkgs/container/libsql-server>. This page pins `d6c75af@sha256:6dd3eb276d9d3604e4a48ac4a999a2e267814732d57d7e94c04ba71482333a67`. On 2026-10-16 the `d6c75af` tag, `latest` and that digest were the same image, and it is the one `sqld.integration.test.ts` runs against, so the tag and the digest agree. When a reference carries both, the digest decides and the tag is a label for humans. To upgrade, resolve the new tag's digest (`docker buildx imagetools inspect <image>:<tag>`, or `docker manifest inspect`), change both together, run the integration test against the new digest, then run the smoke check in section 5.

### Coolify resource

Create a **Docker Compose** resource (Empty or "raw compose"), not an Application: sqld is an image, there is nothing to build.

```yaml
services:
  sqld:
    image: ghcr.io/tursodatabase/libsql-server:d6c75af@sha256:6dd3eb276d9d3604e4a48ac4a999a2e267814732d57d7e94c04ba71482333a67 # pin; see above
    restart: unless-stopped
    environment:
      - SERVICE_FQDN_SQLD_8080 # Coolify generates the domain and routes it to container port 8080
      - SQLD_NODE=standalone
      - SQLD_AUTH_JWT_KEY=${SQLD_AUTH_JWT_KEY} # set in Coolify's Environment Variables, never in git
    volumes:
      - sqld-data:/var/lib/sqld

volumes:
  sqld-data:
```

- Do not add a `ports:` entry. A published host port bypasses the proxy and its TLS (Coolify docs). The proxy reaches the container over the compose network.
- In the resource's **Domains** field enter `https://tempad-sync.example.com:8080` (protocol, hostname, internal port). Coolify's proxy obtains the certificate and terminates TLS, so clients use `https://` or `libsql://`. The domain must already resolve to the Coolify host (a wildcard record is enough). Coolify displays the stored domain without the `:8080`, but routing to container port 8080 works (verified on a real deploy).
- Coolify shows compose-owned volumes read-only under Persistent Storage; change them in the file. Take the volume's name from there when you back it up.
- The image has no healthcheck. The Dockerfile declares no `HEALTHCHECK`, so Coolify reports the service as `running:unknown`, which is normal here. Use the smoke check instead.
- `SQLD_AUTH_JWT_KEY` appears under Environment Variables as soon as the compose file is saved, with an empty value. Fill it in before the first start. sqld reads the variable through clap, which treats an empty value as unset, so an empty `SQLD_AUTH_JWT_KEY=` starts sqld with auth **disabled**: full access for anyone who can reach the URL (section 2). Run the smoke checks (section 5) after every deploy.
- Hrana over WebSocket must pass through the proxy. If `libsql://` fails but `https://` works, the proxy is not forwarding WebSocket upgrades: use `https://` in `[sync].url`.

**Without the UI.** The `coolify` CLI's `service create` only takes one-click service types, so for a raw compose file call the API (token from `coolify context`): `POST /api/v1/services` with `project_uuid`, `server_uuid`, `environment_name`, `name`, `docker_compose_raw` (the compose file, base64), `urls: [{"name": "sqld", "url": "https://tempad-sync.example.com:8080"}]` and `instant_deploy: false`; then `PATCH /api/v1/services/<uuid>/envs` with `{"key": "SQLD_AUTH_JWT_KEY", "value": "<public key>"}`; then `POST /api/v1/services/<uuid>/start` (a `GET` is refused). `coolify service restart <uuid>` restarts it. Set the key before the first `start`, so the service never runs unauthenticated.

## 2. Authentication

**Never expose sqld without a JWT key.** Always set `SQLD_AUTH_JWT_KEY` (or `SQLD_AUTH_JWT_KEY_FILE`). Started with neither (and no legacy `SQLD_HTTP_AUTH`), sqld installs the `Disabled` auth strategy, which returns full access to every caller without looking at any credential (`make_user_auth_strategy` in `libsql-server/src/main.rs`, `user_auth_strategies/disabled.rs`). Note that `SQLD_HTTP_AUTH` (legacy basic auth) is checked first and, when set, replaces JWT auth entirely: do not set it. tempad requires `TEMPAD_SYNC_TOKEN` whenever `[sync]` is enabled.

What sqld checks (from `libsql-server/src/auth/user_auth_strategies/jwt.rs`):

- Algorithm must be EdDSA (Ed25519). Anything else is rejected.
- `exp` is optional, so a token without it never expires.
- Every claim (`id`, `a`, `p`, `exp`) is optional. A token with none of them is accepted as a write token for the default namespace (tested).
- The public key is either an Ed25519 public key in PEM (PKCS#8-encoded per the sqld docs), or **the raw 32-byte key in URL-safe base64**. This page uses the second form: one line, safe in an environment variable. The JWK `x` value printed by the script below is exactly that form (tested).
- Key sources: `SQLD_AUTH_JWT_KEY` (the key itself) or `--auth-jwt-key-file` / `SQLD_AUTH_JWT_KEY_FILE` (a path). There is no `--auth-jwt-key` flag.
- A key file may hold several keys only as concatenated PEM blocks, and sqld tries each against incoming tokens. The base64url form parses to exactly one key (`parse_jwt_keys` in `libsql-server/src/auth/parsers.rs`), so use PEM blocks if you need several.

### Generate the key and mint a token

Run this on your own machine, never on the server. Save it as `jwt.ts` outside the repo. It needs only `bun`.

```ts
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [command, ...args] = process.argv.slice(2);
const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

if (command === "keygen") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(args[0], privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  console.log(publicKey.export({ format: "jwk" }).x); // raw public key, base64url
} else if (command === "mint") {
  const key = createPrivateKey(readFileSync(args[0]));
  const header = b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ sub: args[1], iat: Math.floor(Date.now() / 1000) }));
  const signature = sign(null, Buffer.from(`${header}.${payload}`), key);
  console.log(`${header}.${payload}.${b64url(signature)}`);
}
```

1. `bun jwt.ts keygen ~/.config/tempad-sqld/signing.pem` writes the private key (mode 0600) and prints the public key. Keep the private key in your password manager or an encrypted vault. It never goes on the server and never into any repo.
2. Paste the printed public key into Coolify as the environment variable `SQLD_AUTH_JWT_KEY`, then redeploy.
3. For each host run `bun jwt.ts mint ~/.config/tempad-sqld/signing.pem <HOST_SLUG>`. The output is that host's `TEMPAD_SYNC_TOKEN`. `sub` only labels the token; sqld ignores it (extra claims are tolerated: tested).

Equivalent with OpenSSL, if you prefer: `openssl genpkey -algorithm ed25519 -out signing.pem`, then `openssl pkey -in signing.pem -pubout -outform DER | tail -c 32 | basenc --base64url | tr -d '='` gives the same raw public key (`basenc` is GNU coreutils; on macOS use `base64 | tr '+/' '-_' | tr -d '='`). Signing a JWT with `openssl pkeyutl -rawin` needs OpenSSL 3 or newer, which is why the script above is the recommended path.

### Revocation: be honest about it

sqld has **no token revocation list and no per-token identity**. A token stays valid until its signature stops verifying, so rotating the key invalidates every token at once. Options:

- **One token per host, one shared key.** Tokens are labelled by `sub` for your own bookkeeping, but revoking one host means rotating the key and re-minting for all the others. Fine for a handful of machines.
- **One key pair per host.** Put each host's public key (PEM) into a key file and mount it with `SQLD_AUTH_JWT_KEY_FILE`; removing a host's key revokes exactly that host. Several keys need PEM form (see section 2); the integration test runs with a single key. Coolify can create the file with a `content:` bind entry in the compose file.
- Add an `exp` claim to tokens if you want them to lapse on their own. You then re-mint periodically; tempad does not do it for you.

To rotate: generate a new key pair, change `SQLD_AUTH_JWT_KEY`, redeploy, update `TEMPAD_SYNC_TOKEN` on every host.

## 3. Network exposure

JWT auth is the floor, not the plan. The data is your full work history, including Claude session transcripts.

- **Best: tailnet only.** Do not assign a public domain. Run `tailscale serve` on the Coolify host so sqld is reachable at `https://<machine>.<tailnet>.ts.net` with a Tailscale-issued certificate, and publish the container port on loopback only (`ports: ["127.0.0.1:8080:8080"]`, the one exception to the no-`ports:` rule above). The exact `tailscale serve` syntax changes between releases; check `tailscale serve --help`. That URL is what goes in `[sync].url`; tempad refuses plain `http://` to anything but loopback, so you need the HTTPS front.
- **Otherwise: public domain with a proxy allowlist.** Restrict source IPs in the Coolify proxy (a Traefik `ipAllowList` middleware via labels) if your hosts have stable addresses. TLS is still terminated by the proxy.
- Either way: after deployment confirm that a request without a token is refused (section 5).

## 4. Backups

sqld stores SQLite databases under `/var/lib/sqld`.

- The data lives under that one volume. `--enable-bottomless-replication` (`SQLD_ENABLE_BOTTOMLESS_REPLICATION`) exists and replicates to S3-compatible storage configured through `LIBSQL_BOTTOMLESS_ENDPOINT`, `LIBSQL_BOTTOMLESS_BUCKET` and the standard `AWS_*` variables; on boot, an empty main database is restored from the bucket (bottomless README).
- This page does not use bottomless: the code also carries a `--migrate-bottomless` migration to a newer WAL format, and tempad's recovery relies on the volume copy below, which you can test end to end.
- **Recommended:** stop the service in Coolify, copy the volume, start it again. For example `docker run --rm -v <volume>:/data -v $PWD:/out alpine tar czf /out/sqld-$(date +%F).tgz -C /data .`. Do it from a scheduled job on the Coolify host or use Coolify's scheduled backups for volumes if your version offers them. Always stop the service first: a copy of a live WAL-mode SQLite directory can be inconsistent.
- Test a restore once: extract into a fresh volume, start the container, run the smoke check.

**The remote is not the only copy.** Each host's local `tempad.db` already holds a complete copy of the source tables, so losing the server loses no data permanently. A fresh or reset server repopulates itself: the server holds a random `server_id` in its `sync_meta` table, and each host remembers the id it last synced with. A host treats the server as unknown in any of these cases: the id differs; the server's clock is behind what the host has already pulled; or the last event or row this host pushed is gone (a restore from an older backup). It then marks itself `reseed_pending` locally and drops its pull cursors. From then on, every run pulls from the start, and every push re-sends every row, event and tombstone the host holds, dirty or not, including those other hosts wrote (with their original host and stamp). The marker survives `--pull`-only runs, a push that dies part-way and crashes. Only a re-seed push that completes clears it. A host that detects lost writes also rotates the server's `server_id`, so every other host re-seeds too. One surviving host is enough to make the server whole again, even when the others have been retired (tested). The reverse works too: a host whose own `tempad.db` is restored from an older backup notices that the server holds its newer writes and pulls them back on the next sync, without re-seeding.

**After restoring a backup:** run `DELETE FROM sync_meta WHERE key = 'server_id'` on the server, so every host mints a fresh identity. Then run `tempad sync` on every host. Without this step, a restore is detected only once a host that pushed after the backup was taken syncs again.

## 5. Client side

On every host, in `TEMPAD_HOME/tempad.toml`:

```toml
[sync]
url = "libsql://tempad-sync.example.com" # or https://..., wss://...
```

In `TEMPAD_HOME/.env` (tempad has no default for this and throws at startup when `[sync]` is enabled and the token is missing):

```sh
TEMPAD_SYNC_TOKEN=eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9...
```

Accepted schemes are `libsql:`, `https:` and `wss:`. Plain `http:`/`ws:` work only for loopback hosts, so the token never crosses the network unencrypted. `libsql://` always uses TLS. `@libsql/client` would turn TLS off for `?tls=0` and read a token from `?authToken=` (checked in `@libsql/core` 0.18 `config.js`), so tempad rejects any query string or fragment in `[sync].url`, and any `user:pass@` userinfo, backslash, whitespace or control character. The client is handed a URL rebuilt from the checked parse, never the string as written. The token comes only from `TEMPAD_SYNC_TOKEN`. With the Coolify setup above, both `libsql://` and `https://` terminate at the proxy.

Every host must run identical `[[projects]]` rules in `tempad.toml`. Org, project and display name are computed from the local rules and synced as data, so hosts with different rules overwrite each other's values on every sync (see `docs/specs/push-sync.md`).

Two hosts started from a copy of the same pre-sync `tempad.db` stamp the shared legacy events with different `sync_host` values. That is harmless, because events deduplicate by uid.

### Smoke checks

1. Server up (sqld answers `GET /health` with 200; tested): `curl -i https://tempad-sync.example.com/health`.
2. Auth enforced. A request without a token must be refused, not served. Hrana-over-HTTP check: `curl -i -X POST https://tempad-sync.example.com/v2/pipeline -H 'content-type: application/json' -d '{"requests":[{"type":"close"}]}'` should return 401 (`/v2/pipeline` is the Hrana-over-HTTP route in `libsql-server/src/http/user/mod.rs`, and an auth error maps to `401 Unauthorized` in `libsql-server/src/error.rs`). If it returns 200, stop: the key is not applied. Repeat with `-H "authorization: Bearer $TEMPAD_SYNC_TOKEN"` and expect 200.
3. End to end, from a host: `tempad sync --push`. The first run creates the remote tables and prints the one-line `sync: pushed events=<n> rows=<n> ...` summary (format per the spec); a second run with nothing new pushes zero. A bad token exits 1 with `SERVER_ERROR: Server returned HTTP status 401` (tested; the token never appears in the output), and so does a wrong key on the server. A missing token exits 1 before any connection with `TEMPAD_SYNC_TOKEN is required when [sync] is enabled`.
4. On a second host: `tempad sync --pull`, then compare `tempad report` output for the same day.

## Related

- `docs/specs/push-sync.md`: protocol, schema gate, conflict rule.
- sqld sources: <https://github.com/tursodatabase/libsql> (`docs/DOCKER.md`, `libsql-server/src/main.rs`, `libsql-server/src/auth/user_auth_strategies/jwt.rs`, `bottomless/README.md`).
- Coolify Docker Compose notes: <https://coolify.io/docs/knowledge-base/docker/compose>.
