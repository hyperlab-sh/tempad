# Self-hosting sqld on Coolify for push sync

`tempad sync` pushes to and pulls from one sqld (the libSQL server). This page covers running that server on Coolify and wiring each host to it. Design: `docs/specs/push-sync.md`.

Every claim below was checked against the `tursodatabase/libsql` sources unless it carries "(unverified)". Checked on 2026-10-16 against `main`. Claims marked "(tested)" are also exercised by `packages/core/test/sync/sqld.integration.test.ts` against `ghcr.io/tursodatabase/libsql-server@sha256:6dd3eb276d9d3604e4a48ac4a999a2e267814732d57d7e94c04ba71482333a67` (`latest` as pulled on 2026-10-16, image created 2026-08-23).

## 1. The server

| Item          | Value                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Image         | `ghcr.io/tursodatabase/libsql-server` (arm64 hosts: the `-arm` tags, per `docs/DOCKER.md`)                                         |
| HTTP / Hrana  | `8080` (`SQLD_HTTP_LISTEN_ADDR`, the image defaults it to `0.0.0.0:8080`). This is the only port tempad uses.                      |
| gRPC          | `5001`, for replica-to-primary traffic. tempad does not need it. `SQLD_NODE=standalone` stops the image opening it.                |
| Data          | `/var/lib/sqld`, declared as the image `VOLUME` and its working directory. Mount a persistent volume here.                         |
| Database path | `SQLD_DB_PATH`, default `iku.db`, relative to `/var/lib/sqld`. Inside, sqld keeps its own layout (unverified), not one `.db` file. |

**Pin the image.** The registry publishes `latest` plus short-git-SHA tags (for example `d6c75af`), listed at <https://github.com/tursodatabase/libsql/pkgs/container/libsql-server>. Pick the newest SHA tag that is not `latest`, run it, and write it in the compose file. For a stricter pin append the digest: `image: ghcr.io/tursodatabase/libsql-server:d6c75af@sha256:<digest>`; `docker buildx imagetools inspect <image>:<tag>` prints it. Upgrade on purpose, then run the smoke check in section 5. Tag-to-version mapping is not documented anywhere I found (unverified).

### Coolify resource

Create a **Docker Compose** resource (Empty or "raw compose"), not an Application: sqld is an image, there is nothing to build.

```yaml
services:
  sqld:
    image: ghcr.io/tursodatabase/libsql-server:d6c75af # pin; see above
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
- In the resource's **Domains** field enter `https://tempad-sync.example.com:8080` (protocol, hostname, internal port). Coolify's proxy obtains the certificate and terminates TLS, so clients use `https://` or `libsql://`.
- Coolify shows compose-owned volumes read-only under Persistent Storage; change them in the file. Take the volume's name from there when you back it up.
- The image has no healthcheck. Adding one needs a binary the image may not ship (unverified), so use the smoke check instead.
- Hrana over WebSocket must pass through the proxy. Coolify's Traefik/Caddy proxies forward WebSocket upgrades by default (unverified). If `libsql://` fails but `https://` works, use `https://` in `[sync].url`.

## 2. Authentication

**Never expose sqld without a JWT key.** Started with no auth option, I expect it to serve anyone who reaches it (unverified; the smoke check below proves it for your deployment). The spec requires `TEMPAD_SYNC_TOKEN` whenever `[sync]` is enabled, so there is no reason to skip it.

What sqld checks (from `libsql-server/src/auth/user_auth_strategies/jwt.rs`):

- Algorithm must be EdDSA (Ed25519). Anything else is rejected.
- `exp` is optional, so a token without it never expires.
- Every claim (`id`, `a`, `p`, `exp`) is optional. A token with none of them is accepted as a write token for the default namespace (tested).
- The public key is either an Ed25519 public key in PEM (PKCS#8-encoded per the sqld docs), or **the raw 32-byte key in URL-safe base64**. This page uses the second form: one line, safe in an environment variable. The JWK `x` value printed by the script below is exactly that form (tested).
- Key sources: `SQLD_AUTH_JWT_KEY` (the key itself) or `--auth-jwt-key-file` / `SQLD_AUTH_JWT_KEY_FILE` (a path). There is no `--auth-jwt-key` flag.
- A key file may hold several keys concatenated; sqld tries each against incoming tokens. How keys are delimited in the base64url form is not documented (unverified). Use PEM blocks if you need several.

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
- **One key pair per host.** Put each host's public key (PEM) into a key file and mount it with `SQLD_AUTH_JWT_KEY_FILE`; removing a host's key revokes exactly that host. The multi-key behaviour is documented in the sqld CLI help, but I have not run it with this setup (unverified). Coolify can create the file with a `content:` bind entry in the compose file.
- Add an `exp` claim to tokens if you want them to lapse on their own. You then re-mint periodically; tempad does not do it for you.

To rotate: generate a new key pair, change `SQLD_AUTH_JWT_KEY`, redeploy, update `TEMPAD_SYNC_TOKEN` on every host.

## 3. Network exposure

JWT auth is the floor, not the plan. The data is your full work history, including Claude session transcripts.

- **Best: tailnet only.** Do not assign a public domain. Run `tailscale serve` on the Coolify host so sqld is reachable at `https://<machine>.<tailnet>.ts.net` with a Tailscale-issued certificate, and publish the container port on loopback only (`ports: ["127.0.0.1:8080:8080"]`, the one exception to the no-`ports:` rule above). The exact `tailscale serve` syntax changes between releases; check `tailscale serve --help` (unverified here). That URL is what goes in `[sync].url`; tempad refuses plain `http://` to anything but loopback, so you need the HTTPS front.
- **Otherwise: public domain with a proxy allowlist.** Restrict source IPs in the Coolify proxy (a Traefik `ipAllowList` middleware via labels; unverified) if your hosts have stable addresses. TLS is still terminated by the proxy.
- Either way: after deployment confirm that a request without a token is refused (section 5).

## 4. Backups

sqld stores SQLite databases under `/var/lib/sqld`. What I verified and what I did not:

- **Verified:** the data lives under that one volume; `--enable-bottomless-replication` (`SQLD_ENABLE_BOTTOMLESS_REPLICATION`) exists and replicates to S3-compatible storage configured through `LIBSQL_BOTTOMLESS_ENDPOINT`, `LIBSQL_BOTTOMLESS_BUCKET` and the standard `AWS_*` variables; on boot, an empty main database is restored from the bucket (bottomless README).
- **Not verified:** whether the published image is built with bottomless, and whether it is still the maintained path (the code also has a `--migrate-bottomless` migration to a newer WAL format). I would not rely on it without a test restore.
- **Recommended, simple and safe:** stop the service in Coolify, copy the volume, start it again. For example `docker run --rm -v <volume>:/data -v $PWD:/out alpine tar czf /out/sqld-$(date +%F).tgz -C /data .`. Do it from a scheduled job on the Coolify host or use Coolify's scheduled backups for volumes if your version offers them (unverified). A live copy of a WAL-mode SQLite directory can be inconsistent; I did not verify what sqld guarantees (unverified), so do not skip the stop.
- Test a restore once: extract into a fresh volume, start the container, run the smoke check.

**The remote is not the only copy.** Each host's local `tempad.db` already holds a complete copy of the source tables, so losing the server loses no data permanently. A fresh or reset server repopulates itself: the server holds a random `server_id` in its `sync_meta` table, and each host remembers the id it last synced with. When the id differs, or the server's clock is behind what the host has already pulled (a restore from an older backup), the host's next `tempad sync --push` re-sends every row, event and tombstone it holds, dirty or not, including those other hosts wrote (with their original host and stamp), and pulls from the start. One surviving host is enough to make the server whole again, even when the others have been retired (tested). A `--pull`-only run against such a server resets its cursors but leaves the re-seed to the next push. A restore that keeps the same `server_id` and a clock at or ahead of the hosts' cursors is not detected; back up the volume anyway and, after a restore, run `tempad sync` on every host.

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

Accepted schemes are `libsql:`, `https:` and `wss:`. Plain `http:`/`ws:` work only for loopback hosts, so the token never crosses the network unencrypted. `libsql://` uses TLS in `@libsql/client` unless the URL carries `?tls=0` (checked in `@libsql/core` 0.18 `config.js`); with the Coolify setup above both `libsql://` and `https://` terminate at the proxy.

Every host must run identical `[[projects]]` rules in `tempad.toml`. Org, project and display name are computed from the local rules and synced as data, so hosts with different rules overwrite each other's values on every sync (see `docs/specs/push-sync.md`).

Two hosts started from a copy of the same pre-sync `tempad.db` stamp the shared legacy events with different `sync_host` values. That is harmless, because events deduplicate by uid.

### Smoke checks

1. Server up (sqld answers `GET /health` with 200; tested): `curl -i https://tempad-sync.example.com/health`.
2. Auth enforced. A request without a token must be refused, not served. Hrana-over-HTTP check: `curl -i -X POST https://tempad-sync.example.com/v2/pipeline -H 'content-type: application/json' -d '{"requests":[{"type":"close"}]}'` should return 401 (unverified endpoint shape). If it returns 200, stop: the key is not applied. Repeat with `-H "authorization: Bearer $TEMPAD_SYNC_TOKEN"` and expect 200.
3. End to end, from a host: `tempad sync --push`. The first run creates the remote tables and prints the one-line `sync: pushed events=<n> rows=<n> ...` summary (format per the spec); a second run with nothing new pushes zero. A bad token exits 1 with `SERVER_ERROR: Server returned HTTP status 401` (tested; the token never appears in the output), and so does a wrong key on the server. A missing token exits 1 before any connection with `TEMPAD_SYNC_TOKEN is required when [sync] is enabled`.
4. On a second host: `tempad sync --pull`, then compare `tempad report` output for the same day.

## Related

- `docs/specs/push-sync.md`: protocol, schema gate, conflict rule.
- sqld sources: <https://github.com/tursodatabase/libsql> (`docs/DOCKER.md`, `libsql-server/src/main.rs`, `libsql-server/src/auth/user_auth_strategies/jwt.rs`, `bottomless/README.md`).
- Coolify Docker Compose notes: <https://coolify.io/docs/knowledge-base/docker/compose>.
