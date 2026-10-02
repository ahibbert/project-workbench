# Security policy

## Supported versions

Panels is pre-1.0 software. Security fixes are made on the current development
branch and the newest tagged release only. Older images should be upgraded or
taken off the network.

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** flow when it is
available. Include the affected version or commit, deployment shape,
reproduction steps, impact, and any proposed mitigation. Do not include real
passwords, session cookies, API keys, manga pages, or reading-history exports.

If private vulnerability reporting is unavailable, contact the repository
owner through their GitHub profile before sharing exploit details. Please do
not open a public issue for an unpatched authentication, proxy, or data-loss
vulnerability.

## Deployment boundary

Panels is a trusted single-user or household application, not a hardened
multi-tenant service. An authenticated Panels session can read from and write
to the configured Suwayomi account, update the shared Panels library, request
server-side downloads, and use a configured MangaBaka token.

Operators should:

- require Panels authentication with a long, unique password;
- set an independent random `PANEL_PILOT_SESSION_SECRET` of at least 32 bytes;
- expose Panels only through HTTPS and keep port 8013 bound to loopback or a
  private network;
- keep Suwayomi and the manga detector off the public internet;
- protect `.env`, `data/panels`, backups, reverse-proxy configuration, and
  logs as sensitive material;
- run production only from the built Docker image or `dist`, never with
  `PANEL_PILOT_ALLOW_SOURCE_STATIC=1`;
- update the base images and npm dependencies regularly, then run the full
  regression suite before deployment.

The reverse proxy must preserve `X-Forwarded-Proto: https` so the session
cookie receives its `Secure` attribute. Do not put a second Basic Auth prompt
in front of Panels. Conversely, do not expose the Panels port directly to
untrusted clients: Panels trusts this forwarded header because the supported
Compose deployment binds the port to loopback. A VPN or IP allow-list is
sensible additional protection for an internet-reachable personal instance.
Panels also throttles repeated sign-in failures, rejects explicit cross-origin
writes, and sends restrictive browser security headers, but these controls do
not turn it into a multi-tenant service.

## Client data

Library metadata, reader settings, pending progress, cached application files,
and downloaded chapters can be stored unencrypted in the browser profile.
Signing out prevents server access but does not promise to erase all local PWA
storage. Use a trusted device profile and remove device-local data from
**Settings → Storage** before giving the device or profile to someone else.
See [Privacy and data flows](docs/PRIVACY.md) for the complete storage and
service boundary.

## External services and content

Panels can make outbound requests to the operator's Suwayomi server,
MangaBaka, Comick, supported image CDNs, and the optional detector. Source
extensions and manga content have their own licenses and terms; none are
bundled with Panels. The optional model has separate attribution and data-set
terms in [`ml/MODEL-NOTICE.md`](ml/MODEL-NOTICE.md).

The supplied containers run as an unprivileged user with a read-only root
filesystem, all Linux capabilities dropped, and `no-new-privileges` enabled.
Mount only `data/panels`; never add host PID/network mode, privileged mode, or
the Docker socket.
