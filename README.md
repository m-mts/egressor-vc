# Egressor

Traffic visibility, egress rule enforcement, secret injection, and audit trails for container-based development in VS Code.

Egressor combines [httpjail](https://github.com/coder/httpjail) for traffic control with [CyberArk Secretless Broker](https://github.com/cyberark/secretless-broker) for credential injection, providing a unified security layer for devcontainer environments.

## Features

- **Egress filtering** - Allow-list model for outbound HTTP/HTTPS traffic using httpjail
- **Secret injection** - Transparent credential injection via Secretless Broker (API tokens, DB credentials)
- **Live traffic panel** - Real-time sidebar showing all outbound requests with allow/block status
- **Audit trail** - Structured JSONL session logs with summary generation
- **Status bar** - Live allowed/blocked request counters
- **VS Code diagnostics** - Blocked requests surfaced as warnings
- **Auto-start** - Detects devcontainers and activates automatically

## Prerequisites

### httpjail

httpjail controls all egress traffic. Install from [Coder's httpjail releases](https://github.com/coder/httpjail/releases).

The extension auto-detects the binary on your PATH, or you can set the path in settings:

```
egressor.httpjailPath: "/usr/local/bin/httpjail"
```

### Secretless Broker

Required only if you use the `secrets` section in your config. Install from [CyberArk Secretless Broker](https://github.com/cyberark/secretless-broker).

## Quick Start

1. Install the Egressor extension in VS Code
2. Create a `.egressor.yml` file in your workspace root
3. Open your project in a devcontainer - Egressor starts automatically

Minimal config example:

```yaml
version: "1.0"
presets:
  - node-fullstack
rules: []
```

## Configuration Reference

Egressor is configured via `.egressor.yml` in the workspace root.

### Schema

```yaml
version: "1.0"                    # Required: schema version

presets:                           # Optional: predefined rule sets
  - node-fullstack
  - python-data-science

rules:                             # Required: egress allow-list
  - host: api.example.com         # Required: hostname or wildcard (*.example.com)
    methods: [GET, POST]           # Optional: restrict to specific HTTP methods
    paths: [/api/v1]              # Optional: restrict to path prefixes
    description: Example API       # Optional: human-readable note

secrets:                           # Optional: secrets for Secretless Broker
  - name: my_token                 # Required: unique identifier
    type: bearer_token             # Required: secret type
    target: api.example.com        # Required: target host/service
    description: API token         # Optional: description
```

### Rules

Each rule defines an allowed outbound destination. Traffic not matching any rule is blocked.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `host` | string | yes | Hostname or wildcard pattern (`*.github.com`) |
| `methods` | string[] | no | Allowed HTTP methods: GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS |
| `paths` | string[] | no | Allowed URL path prefixes |
| `description` | string | no | Human-readable note |

Wildcard hosts: `*.github.com` matches `api.github.com`, `raw.github.com`, etc. It also matches the bare domain `github.com`.

### Presets

Presets expand to predefined sets of common egress rules:

| Preset | Hosts |
|--------|-------|
| `node-fullstack` | registry.npmjs.org, *.npmjs.org, *.github.com, github.com, api.github.com, *.googleapis.com |
| `python-data-science` | pypi.org, files.pythonhosted.org, *.anaconda.org, conda.anaconda.org, github.com |
| `java-enterprise` | repo1.maven.org, *.maven.org, plugins.gradle.org, github.com |
| `go-standard` | proxy.golang.org, sum.golang.org, storage.googleapis.com, github.com |
| `web-frontend` | registry.npmjs.org, *.npmjs.org, cdn.jsdelivr.net, unpkg.com, *.cdnjs.cloudflare.com |

Explicit rules take priority over preset rules. Duplicate hosts are deduplicated.

### Secret Types

| Type | Fields | Description |
|------|--------|-------------|
| `bearer_token` | name, target | Injects Authorization: Bearer header |
| `header` | name, target, headerName | Injects custom header |
| `basic_auth` | name, target | Injects Basic auth (prompts for username + password) |
| `postgresql` | name, target, listenPort | Proxies PostgreSQL connections with injected credentials |
| `mysql` | name, target, listenPort | Proxies MySQL connections with injected credentials |
| `ssh` | name, target | SSH key management |

For database types, `listenPort` is required (1-65535). Your application connects to `localhost:<listenPort>`, and the broker forwards to `target` with real credentials.

## Commands

| Command | Description |
|---------|-------------|
| `Egressor: Start` | Start traffic monitoring and secret injection |
| `Egressor: Stop` | Stop all Egressor processes |
| `Egressor: Show Session Summary` | Display audit summary with traffic stats |
| `Egressor: Export Session Log` | Export session log as JSON file |
| `Egressor: Store Secret` | Store a secret value |
| `Egressor: Delete Secret` | Remove a stored secret |
| `Egressor: List Secrets` | List all stored secret names |

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `egressor.httpjailPath` | string | (auto-detect) | Path to httpjail binary |
| `egressor.autoStart` | boolean | true | Auto-start when .egressor.yml is detected in a devcontainer |
| `egressor.logLevel` | string | info | Log verbosity: debug, info, warn, error |

## How It Works

### Traffic Flow

1. Egressor reads `.egressor.yml` and generates httpjail JavaScript rules
2. httpjail starts with `--docker-run` targeting the devcontainer and `--strong` mode (nftables)
3. All outbound HTTP/HTTPS traffic is evaluated against the rules
4. Allowed traffic passes through; blocked traffic is rejected
5. Non-HTTP traffic is blocked by default (DNS on udp:53 is always permitted)
6. All events stream to the Traffic Panel, status bar, diagnostics, and audit log

### Secret Injection

1. Egressor reads the `secrets` section and generates `secretless.yml`
2. Secretless Broker starts with the generated config
3. For HTTP secrets: the broker intercepts requests to target hosts and injects credentials
4. For DB secrets: your app connects to `localhost:<listenPort>`, the broker proxies to the real DB with credentials
5. Secrets are stored in VS Code's secure storage (OS keychain) and never exposed to the container

## Development

```bash
npm install          # Install dependencies
npm run compile      # Compile TypeScript
npm run test:unit    # Run unit tests
npm run test:coverage # Run tests with coverage
npm run lint         # Run ESLint
```

## License

MIT
