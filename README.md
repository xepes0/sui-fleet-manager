# S-UI Fleet Manager + Komari

Independent fleet controller for multiple existing [S-UI](https://github.com/alireza0/s-ui) panels. It reads the modified Komari server in this workspace through its existing `/api/rpc2` interface and matches each S-UI panel to a Komari node UUID. It does not install another agent or change Komari's reporting path.

## Current functions

- Register S-UI panels with region, URL, API Token, and optional Komari node UUID.
- Probe homepage for every visible Komari node, including CPU, RAM, disk, load, network rates, connection counts, uptime, renewal information, and real one-hour Ping history. Registered S-UI panels are linked from their cards; the server-side API projects only display fields from Komari.
- Each registered server opens a detail view with Inbounds, Outbounds, route rules, users, and per-object edit actions. Its single-server editor reuses the preview, backup, version check, and execution flow with exactly that server selected.
- View each panel's Inbounds and clients with their IDs and traffic counters.
- Batch backup, restart sing-box, enable/disable an existing client, create a client, create Inbounds and Outbounds, edit an existing Inbound or Outbound, and insert, replace, or delete ordered route rules. The batch page uses visual forms and selectors; it generates the S-UI objects automatically.
- Preview per-panel changes. A preview is single-use and expires in five minutes. Client and Inbound edits check that the object has not changed before writing. Client creation checks for name conflicts and valid Inbound IDs. Every configuration write saves a database backup first. A failed panel does not stop the others. Recent execution results are in the audit page. Backups can be downloaded from the backup page.
- Save remote rule-set, Outbound, sing-box subscription, and Mihomo subscription templates. Template contents are encrypted in the controller database; list responses contain metadata only. The visual forms build common configurations, then use the existing per-panel preview, version check, and pre-write backup when applied.
- Inspect S-UI subscription users, traffic, and plain/sing-box/Mihomo links. Set the public subscription base URL and enable or disable a user through the preview workflow. The controller only presents public HTTPS subscription URLs.

The controller uses S-UI's documented `/apiv2` API. Its URL must include the panel's actual web path, for example `https://host:2095/app/`. S-UI API Tokens are stored encrypted with AES-GCM in a local SQLite database. The encryption key is supplied separately through `FLEET_MASTER_KEY`; keep a durable copy of it, because rotating or losing it makes stored panel Tokens unreadable.

## Run with Docker

1. Copy `.env.example` to `.env`. Set `FLEET_USER`, a random `FLEET_PASSWORD` of at least 16 characters, and `FLEET_MASTER_KEY` containing 32 random bytes encoded with base64. Set `KOMARI_URL` for the server-side RPC connection and `KOMARI_PUBLIC_URL` for the browser's Komari link. The public URL must be reachable from the user's phone. `KOMARI_API_KEY` is optional.
2. Run `docker compose up -d --build` in this directory.
3. Open `http://127.0.0.1:18780/` on the host and authenticate with the configured username and password. For remote access, place an HTTPS reverse proxy in front of the loopback listener. The Compose file does not expose the controller on public interfaces.

`KOMARI_API_KEY` is an existing Komari API key, sent as `Authorization: Bearer ...`. It is optional for public nodes; hidden nodes and private-site data require authentication. Komari data stays in Komari. The controller only stores the UUID link and fetches metrics when the page refreshes.

The probe card labels network totals as counters for the current boot. They are shown separately from the plan traffic limit; the two values do not necessarily describe the same billing period.

Each target S-UI panel needs its own API Token. Generate it in the S-UI panel and paste it when adding the panel. No panel login passwords are stored. The controller never follows S-UI redirects with a Token, and it verifies TLS by default. For S-UI over plain HTTP, use a trusted private network or tunnel because that hop carries the Token in cleartext.

## Run locally without Docker

With Go 1.25 installed, set the same environment variables and run `go run .`. By default it listens on `127.0.0.1:18780` and writes its SQLite database and backups under `./data`. Override with `FLEET_LISTEN` and `FLEET_DATA_DIR`.

## YT Hong Kong deployment

The standalone Linux binary runs as `sui-fleet-manager.service` on `203.0.113.10`. Its public URL is `https://fleet.example.com:18780/`. It serves HTTPS directly using a restricted copy of the server's certificate, uses `KOMARI_URL` for RPC and `KOMARI_PUBLIC_URL` for browser navigation, and stores its database and backups in `/var/lib/sui-fleet-manager`. The local, Git-ignored `data/hk-fleet.env` contains the login and the database encryption key; its installed copy is `/etc/sui-fleet-manager.env` with mode `0600`. Keep that file and the database together for recovery.

Read `FLEET_USER` and `FLEET_PASSWORD` from `data/hk-fleet.env` for login. The TLS certificate and key are copied from `/root/cert` to `/etc/sui-fleet-manager/tls` with restricted permissions. The `sui-fleet-cert-sync.timer` checks for renewed certificates daily and restarts the controller only when they change. The service refuses a public HTTP listener without TLS files.

To add panels, generate an API Token in each S-UI panel and enter the panel URL, Token, region, and optional Komari node UUID in the controller. No S-UI panel is auto-registered during deployment.

## Batch configuration forms

The main batch page now opens an object-first editor for all eight S-UI Token API configuration categories: users, Inbounds, Outbounds, Endpoints, Services, TLS, sing-box core configuration, and panel settings. Select target servers, a category, an object, and the fields to change. A field patch is merged with each panel's own object, matched by Tag or name; unselected fields and panel-specific IDs stay intact. The UI also supports adding and deleting objects, nested fields, and per-server previews. Panel settings submit only selected keys. The older maintenance and shortcut actions remain under the expandable section.

Batch user creation groups identity, available Inbounds, protocol credentials, and traffic/expiry controls. Existing user edits show the same sections, with individual credential fields instead of a raw `config` object. Selecting an additional Inbound protocol generates a missing credential entry for that protocol. Inbound associations are selected by Tag and resolved to each panel's own numeric ID during preview. Traffic is entered in GB and expiry as a date, while S-UI receives bytes and Unix seconds.

Batch Inbound creation offers a guided new listener or a per-panel copy of an existing Inbound Tag. A copy retains each panel's protocol-specific options and TLS assignment, but requires a new listening address or port. The copied object's additional protocol fields appear as normal controls; only fields changed in the form are patched over each panel's own source object. The guided form resolves a chosen TLS certificate by name on each panel and provides separate public subscription address fields for every target server. Existing Inbound edits expose listener and TLS settings alongside per-server public address edits. Changing a public address retains additional entries in that panel's address list; clearing it removes its published addresses. Preview reports missing Inbound Tags, TLS names, duplicate listeners, and mismatched source protocols before any write.

New Outbound forms show protocol-specific authentication fields. SOCKS and HTTP have optional username/password fields; password-based protocols require a password. The preview masks secret values. In S-UI, a subscriber's Inbound password or UUID belongs to a **client** record rather than the Inbound listener. The new Inbound form links to the client creation form, where a password or UUID can be entered explicitly or generated automatically.

The optional **Advanced parameters** disclosure adds raw sing-box fields by their exact keys. Ordinary S-UI-style forms do not require it; it stays collapsed by default and is meant for fields the visual form does not yet cover.

For one server, open **鍏ㄩ儴閰嶇疆椤圭洰** from its configuration dialog. This editor exposes all returned object fields through text, number, switch, object, and list controls, including nested structures. S-UI account password and API Token administration use separate session-only endpoints and are outside the Token API configuration categories.

Select one or more servers first. Existing users, Inbounds, Outbounds, TLS certificates, and route rules load into selectors from the first selected panel. The preview validates each target panel separately. The `鍒涘缓鐢ㄦ埛` form generates credentials for supported protocols and lets you choose Inbounds per server; traffic allowance and expiry are ordinary fields.

For Inbounds and Outbounds, choose a supported protocol and fill the displayed fields, or copy an existing object by Tag. Copying reads each panel's own source object, retains its protocol-specific settings, removes the database ID, and uses the new Tag. A copied Inbound must use a different listening address or port. Its users are assigned through the separate client form. More specialized sing-box settings can be prepared in S-UI first and then copied across panels.

For SOCKS5 Outbounds, the UDP over TCP control writes S-UI's structured setting, `{"enabled":true,"version":2}` by default. Version 1 is available in the form. The existing Outbound edit form can enable, disable, or keep this setting. A normal SOCKS5 server must also support the matching UDP over TCP protocol for UDP traffic to work.

The batch **鏂板鍑虹珯** form also shows SOCKS network selection and UDP over TCP (disabled, version 2, or version 1), plus an optional detour Tag and TLS server name for TLS-based protocols. Disabled or blank optional fields are omitted from the S-UI object; UDP over TCP is rejected for SOCKS4 or TCP-only network selection.

Route rules use match, action, target Outbound, and position controls. The rule list and order come from the first selected panel, so inspect the per-panel preview before executing when their rules differ. The preview displays full before and after configuration and checks for changes between preview and execution. A route target must exist on each selected panel. The controller retains unrelated `config` sections such as DNS and logs.

Configuration writes save a per-panel database backup before calling S-UI's `/apiv2/save`. S-UI may restart the sing-box core when it saves objects or core configuration, so review affected servers and rule order before executing.

## Template and subscription safety

The template library stores contents encrypted using the same `FLEET_MASTER_KEY` as panel Tokens. A rule-set template accepts only a public HTTPS hostname; applying it adds a remote rule-set to each selected S-UI core configuration. S-UI or sing-box downloads the rule-set after the change, so use a source you trust. Template application can restart sing-box.

S-UI identifies each subscription by its **client name**. Anyone with a working subscription URL can receive that client's node configuration, which may contain proxy credentials. Choose unguessable client names, protect copied URLs, and expose the S-UI subscription service over HTTPS. Changing a name invalidates the old subscription URL. This controller does not fetch or store generated subscription contents.

The Mihomo visual template covers a safe starting configuration: mixed port, local-network access, Fake-IP DNS, optional ad blocking, and a default route. S-UI inserts the actual client nodes and default Proxy/Auto groups. Advanced Mihomo YAML and specialized sing-box fields remain available in S-UI's native editor or the controller's full configuration editor.

## Backups and recovery

Backups are saved in `/data/backups` in Docker or `./data/backups` locally, using mode `0600`. The database is in the same data volume. Download individual backup files in the controller's `澶囦唤` tab. The automatic pre-change backup omits S-UI's traffic statistics and change log but retains configuration, clients, users, and Tokens. To restore one panel, use S-UI's own import flow after inspecting the backup. The controller does not automatically restore a panel after a partial batch failure.

## Validation

```sh
go test ./...
node --check web/app.js
node --check web/templates.js
node --test ui_form_test.cjs
node --test batch_config_form_test.cjs
```

Tests use simulated S-UI and Komari endpoints and cover Komari mapping, client, Inbound, Outbound, and route-rule preview with backup before write, stale-preview rejection, route order, one-time execution, backup download, authentication, and redirect Token isolation. No production panel is accessed by the test suite.

## Scope

This version covers panel registration, a combined Komari overview, inspection of S-UI objects and routing, single-server editing for all eight Token API configuration categories, batch field patches, creation, deletion, maintenance, backups, visual template management, and S-UI subscription management. It still uses S-UI's native subscription generator. Package management, certificate issuance, alert delivery, and automatic deployment to additional servers are not implemented.
