# Application diagnostics and problem reports

The application manifest sets `diagnostics.reportUrl` to `https://canvastty.deploychan.webcam/canvastty/reports`. The collector runs as `canvastty-reports.service`, behind HTTPS, with private storage at `/var/lib/canvastty-reports`. On 2026-10-03 the requested local development launch compiled successfully, a report sent from the application received a matching acknowledgement, and the owner supplied the saved server document with the same UUID, description, context and event log. Image attachments were added afterwards and still need a user-driven round trip.

## What is collected

The main process writes timestamped JSONL events under Electron's `userData/logs`: startup milestones, application warnings and errors, terminal status transitions and exit codes, renderer exceptions, failed IPC calls, update states and shutdown. Each app run has a separate identifier. Four rotating files are capped at 1 MiB each, individual entries at 64 KiB, and the write queue at 256 entries. Dropped entries and storage failures are recorded in the report. Logging does not subscribe to PTY output or keyboard input.

Reports contain the user's description, app version, OS/architecture/runtime versions, locale, keyboard preset, UI scale, session restore mode, provider/status summaries, enabled plugin identifiers/versions and the recent event files. They do not automatically include saved settings files, credential stores, terminal buffers, conversations, browser history, screenshots or project files. Error messages and stacks can contain application paths and other context supplied by services; home paths are replaced and existing CanvasTTY secret masking is applied before writing and again before sending. Masking is best effort: users should avoid pasting credentials into their description.

The report form also accepts one explicitly selected PNG or JPEG image up to 2 MiB, with a preview and replace/remove actions. The original filename is displayed locally but is not uploaded. The image is sent unchanged as `report.attachment: { mimeType, base64 }`; its contents and metadata are not masked. It is stored inside the same private compressed report and follows the report's retention and storage limits. The main process and updated collector check the MIME type, canonical base64, decoded size and PNG/JPEG signature. The client also enforces the existing 5 MiB compressed report limit. A failed upload keeps both the description and image in the form.

Sending requires the **Send description and diagnostics** action. There is no background report upload. The trusted main process sends gzip-compressed JSON over HTTPS and checks that the server acknowledges this report's UUID. An error preserves the description and image for retry. The UI identifies the recipients as the CanvasTTY developers and displays the accepted report reference; the technical collector address is a maintainer setting.

Disk writes are asynchronous; an abrupt process kill or fatal main-process crash may lose the last queued events. This journal is application diagnostics, not a native crash dump.

## Prepare the collector

The standalone collector uses Node.js built-in modules and does not need `npm install`. Use Node.js 22 or newer. Copy `server/diagnostics/collector.mjs` to the server. For a foreground run with an existing writable private directory:

```sh
REPORTS_DIRECTORY=/path/to/private/reports PORT=8787 node /path/to/collector.mjs
```

The HTTP listener binds only to `127.0.0.1`. Put it behind an HTTPS reverse proxy; do not expose port 8787 publicly. It accepts `POST /reports`, and `GET /health` is available locally. There are no report browsing or download endpoints. Report files are created with mode `0600`, inside a directory created with mode `0700`.

The collector accepts at most 5 MiB compressed / 12 MiB inflated per report, two simultaneous requests and five reports per IP per minute. It removes reports older than 30 days and the oldest reports when storage would exceed 512 MiB or 1,000 files. These limits provide bounded storage, not user authentication; the submission endpoint is public and distributable app credentials would not make it private. Existing files must also be kept private by the server administrator.

An example systemd unit, after creating a dedicated `canvastty-reports` account and placing the script at `/opt/canvastty-reports/collector.mjs`:

```ini
[Unit]
Description=CanvasTTY diagnostic report collector
After=network.target

[Service]
Type=simple
User=canvastty-reports
Group=canvastty-reports
StateDirectory=canvastty-reports
StateDirectoryMode=0700
Environment=REPORTS_DIRECTORY=/var/lib/canvastty-reports
Environment=PORT=8787
ExecStart=/usr/bin/node /opt/canvastty-reports/collector.mjs
Restart=on-failure
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

This file is an example; no accounts, services or DNS records are created by the repository.

## Attach a personal domain

A domain name alone is not a server. You need a machine or hosting service that runs the collector, an HTTPS certificate, and a reverse proxy. A small existing server is sufficient for initial reports; provisioning and any hosting costs remain the owner's choice.

In the existing HTTPS Nginx `server` for your domain, add a location such as:

```nginx
location = /canvastty/reports {
    client_max_body_size 5m;
    proxy_pass http://127.0.0.1:8787/reports;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_connect_timeout 5s;
    proxy_read_timeout 30s;
    proxy_send_timeout 30s;
}
```

The proxy must **overwrite** `X-Real-IP` rather than accept a client-supplied value. If another proxy/CDN precedes Nginx, configure its trusted address handling first. Keep the reports directory outside any web root. Existing HTTPS and certificate renewal configuration remains responsible for TLS.

After deploying the collector, set `diagnostics.reportUrl` in `package.json` to the actual URL, for example `https://YOUR-DOMAIN/canvastty/reports`, before building the app. The endpoint is a maintainer setting; users do not have to configure servers. For an explicitly requested local development run, `CANVASTTY_DIAGNOSTICS_URL=http://127.0.0.1:8787/reports` overrides it; plain HTTP is allowed only for loopback in unpackaged development builds.

## Read a complaint

Ask the user for the report reference shown in the app. On the server, an administrator with filesystem access can read that report (use `sudo` for the deployed private directory):

```sh
gzip -dc /var/lib/canvastty-reports/REPORT-UUID.json.gz
```

The saved document contains `receivedAt` and `report`; `report.description` is the complaint, `report.context` describes the installation, and `report.logs` contains recent timestamped events. Match session IDs and run IDs when tracing a failure. No reports are automatically published to GitHub or sent to other people.

To extract an attached image into the current directory without printing the base64 payload:

```sh
sudo gzip -dc /var/lib/canvastty-reports/REPORT-UUID.json.gz | node --input-type=module -e '
import { writeFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { report } = JSON.parse(input);
const image = report.attachment;
if (!image || !["image/png", "image/jpeg"].includes(image.mimeType)) throw new Error("No supported attached image");
const path = `${report.reportId}.${image.mimeType === "image/png" ? "png" : "jpg"}`;
writeFileSync(path, Buffer.from(image.base64, "base64"), { flag: "wx", mode: 0o600 });
console.log(`Image saved: ${path}`);
'
```

## Update the existing collector for attachment validation

The initial collector preserves additional JSON fields, so it can store an attachment from the updated application. Deploy the updated collector to enforce the image-specific checks server-side as well. Copy both `server/diagnostics/collector.mjs` and `server/diagnostics/apply-collector.sh` into the same server directory, then run:

```sh
sudo bash /PATH/TO/PACKAGE/apply-collector.sh
```

This one-time installer checks the reviewed original collector hash, creates a private backup, checks JavaScript syntax, replaces only the collector script, restarts its service and checks local health. A failure attempts to restore the original script and restart the service. Nginx configuration, systemd resource limits, certificates and unrelated services are preserved. If the deployed source hash differs, stop and review it instead of bypassing the check.

## Verification still required

The server agent reported successful synthetic HTTPS upload, matching acknowledgement and saved contents, request-size and format rejection, private file permissions, service recovery and certificate renewal. After endpoint hardening, public synthetic upload and the owner's development-app report succeeded; the saved app report showed no storage failure or dropped events and a masked home path. Automated tests and the full release build were not run. Before shipping, exercise attachment upload and extraction, offline/rejected upload, description/image retention, log rotation and secret masking. Updater verification requires real packaged version A → B runs on each supported platform; running the dev app cannot prove installation works. The first updater-enabled release is installed manually, and subsequent macOS releases need the owner's Sparkle signing key as described in [installing and security](installing-and-security.md).
