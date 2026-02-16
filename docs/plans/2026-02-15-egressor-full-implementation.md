# Egressor - VS Code Extension Implementation Plan

## Overview

Implement Egressor, a VS Code extension that provides traffic visibility, egress rule enforcement, secret injection, and audit trails for container-based development. Uses httpjail (by Coder) for all traffic control and filtering, and CyberArk Secretless Broker for secret management and injection. The extension orchestrates these tools and provides the VS Code UI layer.

## Context

- Files involved: Greenfield project - all files to be created
- Related patterns: VS Code Extension API, httpjail (Coder), CyberArk Secretless Broker
- Dependencies: vscode (extension API), httpjail binary (traffic control), secretless-broker (secret injection), js-yaml (config parsing), VS Code webview API (traffic panel)
- Key integration points:
  - httpjail: controls all egress traffic (HTTP/HTTPS filtered by rules, non-HTTP blocked by default), provides TLS interception, Docker container integration via --docker-run
  - Secretless Broker: runs as sidecar, intercepts connections to target services (HTTP APIs, databases, SSH), injects credentials from configured providers without exposing them to the container

## Development Approach

- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- Use TypeScript for the VS Code extension
- httpjail rules written as JavaScript expressions (its native rule format)
- Secretless Broker configured via secretless.yml
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Project Scaffolding and Build Setup

**Files:**
- Create: `package.json` (VS Code extension manifest + workspace config)
- Create: `tsconfig.json`
- Create: `src/extension.ts` (activation entry point)
- Create: `src/test/runTest.ts` (test harness)
- Create: `.vscodeignore`
- Create: `.eslintrc.json`

- [x] Initialize VS Code extension project with TypeScript
- [x] Configure package.json with extension metadata, activation events, and contributes (views, commands, configuration)
- [x] Set up TypeScript compilation
- [x] Set up ESLint and testing framework (mocha + VS Code test runner)
- [x] Create minimal extension.ts that activates and logs
- [x] Write smoke test that extension activates without error
- [x] Run project test suite - must pass before task 2

### Task 2: Configuration Parser (.egressor.yml)

**Files:**
- Create: `src/config/parser.ts` (YAML parsing and validation)
- Create: `src/config/types.ts` (TypeScript interfaces for config schema)
- Create: `src/config/watcher.ts` (file watcher for config changes)
- Create: `src/config/secretless-generator.ts` (generates secretless.yml from .egressor.yml)
- Create: `src/config/httpjail-rules-generator.ts` (generates httpjail JS rules from .egressor.yml)
- Create: `src/test/config.test.ts`

- [x] Define TypeScript interfaces for .egressor.yml schema (egress rules, secrets declarations, presets)
- [x] Implement YAML parser that reads and validates .egressor.yml
- [x] Implement preset resolution (e.g., node-fullstack expands to common Node.js hosts)
- [x] Implement secretless.yml generator: translate .egressor.yml secrets section into Secretless Broker service config (HTTP connectors with bearer_token, database connectors with listen ports)
- [x] Implement httpjail rule generator: translate .egressor.yml egress rules into httpjail JavaScript rule expressions (host matching, method filtering, path filtering)
- [x] Implement file watcher that detects config changes and regenerates derived configs
- [x] Write tests: valid config parsing, invalid config errors, preset expansion, secretless.yml generation, httpjail rule generation, file change detection
- [x] Run project test suite - must pass before task 3

### Task 3: httpjail Integration (Traffic Control)

**Files:**
- Create: `src/jail/manager.ts` (httpjail process lifecycle management)
- Create: `src/jail/events.ts` (parse httpjail output into structured traffic events)
- Create: `src/jail/installer.ts` (check for / install httpjail binary)
- Create: `src/jail/types.ts` (traffic event types)
- Create: `src/test/jail.test.ts`

- [x] Implement httpjail binary detection and installation helper (download from GitHub releases or prompt user)
- [x] Implement httpjail process manager: start httpjail with --docker-run for container sessions, pass generated JS rules file, configure strong mode with nftables for full traffic control
- [x] Parse httpjail stdout/stderr to extract structured traffic events (method, host, path, allowed/blocked, timing)
- [x] Implement httpjail lifecycle management (start, stop, restart, health check)
- [x] Handle httpjail's default behavior: all DNS (udp:53) permitted, all non-HTTP traffic blocked
- [x] Wire config watcher to reload httpjail rules on .egressor.yml changes
- [x] Write tests: process lifecycle, event parsing, rule file generation, config reload
- [x] Run project test suite - must pass before task 4

### Task 4: Secretless Broker Integration (Secret Injection)

**Files:**
- Create: `src/secrets/broker-manager.ts` (Secretless Broker process/container lifecycle)
- Create: `src/secrets/credential-provider.ts` (local credential provider that reads from VS Code SecretStorage)
- Create: `src/secrets/prompt.ts` (first-run secret value collection UI)
- Create: `src/secrets/types.ts` (secret config types)
- Create: `src/test/secrets.test.ts`

- [x] Implement Secretless Broker container/process manager: start broker with generated secretless.yml
- [x] Implement local credential provider: store secret values in VS Code SecretStorage API, serve them to Secretless Broker via its credential provider interface (file-based or environment variable provider)
- [x] Implement secret CRUD operations through VS Code commands (store, retrieve, delete, list)
- [x] Implement first-run detection: when .egressor.yml declares secrets the local store doesn't have, prompt user via VS Code input UI
- [x] Configure Secretless Broker services: HTTP connectors for API secret injection (bearer_token, custom headers), database connectors for DB credential injection (PostgreSQL, MySQL)
- [x] Wire Secretless Broker events into traffic event stream (secret injection events)
- [x] Write tests: broker lifecycle, credential storage/retrieval, secretless.yml service config, first-run prompting
- [x] Run project test suite - must pass before task 5

### Task 5: Traffic Panel (VS Code Webview)

**Files:**
- Create: `src/views/trafficPanel.ts` (webview provider)
- Create: `src/views/trafficPanel.html` (webview template)
- Create: `src/views/trafficPanel.css` (styling)
- Create: `src/views/trafficPanel.js` (webview client-side script)
- Create: `src/test/views.test.ts`

- [x] Implement VS Code WebviewViewProvider for the Traffic Panel sidebar
- [x] Display live traffic from httpjail events: method, host, path, status (allowed/blocked), timing
- [x] Display Secretless Broker events: secret-injected requests marked with lock icon
- [x] Display non-HTTP blocked traffic (from httpjail strong mode) as a separate category
- [x] Add color coding: green for allowed, red for blocked, lock icon for secret-injected, gray for non-HTTP blocked
- [x] Implement filtering (by host, method, status) and search
- [x] Wire panel to traffic events via extension messaging
- [x] Write tests: panel registration, message handling, data formatting
- [x] Run project test suite - must pass before task 6

### Task 6: Status Bar and Diagnostics

**Files:**
- Create: `src/views/statusBar.ts` (status bar item)
- Create: `src/views/diagnostics.ts` (VS Code diagnostics for blocked requests)
- Create: `src/test/statusBar.test.ts`

- [x] Implement status bar item showing live stats (requests allowed / blocked count)
- [x] Implement VS Code diagnostics that surface blocked requests as warnings
- [x] Add click handler on status bar to open Traffic Panel
- [x] Wire status bar and diagnostics to traffic events from httpjail
- [x] Write tests: status bar updates, diagnostic creation for blocked requests
- [x] Run project test suite - must pass before task 7

### Task 7: Audit Trail and Session Logging

**Files:**
- Create: `src/audit/logger.ts` (session log writer)
- Create: `src/audit/types.ts` (audit event types)
- Create: `src/audit/summary.ts` (session summary generator)
- Create: `src/test/audit.test.ts`

- [x] Implement session logger that writes structured JSON logs to a session file
- [x] Log all events: httpjail traffic (allowed/blocked HTTP, blocked non-HTTP), Secretless Broker injections, rule matches
- [x] Implement session summary generation (total requests, blocked count, non-HTTP blocked count, secret injection count, anomalies)
- [x] Add VS Code commands: "Egressor: Show Session Summary", "Egressor: Export Session Log"
- [x] Wire logger to traffic events from both httpjail and Secretless Broker
- [x] Write tests: log writing, summary generation, export functionality
- [x] Run project test suite - must pass before task 8

### Task 8: Container Integration and Extension Lifecycle

**Files:**
- Create: `src/container/detector.ts` (detect when devcontainer opens)
- Create: `src/container/setup.ts` (orchestrate httpjail + Secretless Broker for container)
- Modify: `src/extension.ts` (wire everything together)
- Create: `src/test/integration.test.ts`

- [x] Detect when a devcontainer opens (VS Code remote container context)
- [x] Orchestrate startup: parse .egressor.yml, generate httpjail rules + secretless.yml, start httpjail with --docker-run targeting the container, start Secretless Broker
- [x] Configure container networking to route through httpjail (handled by httpjail's --docker-run flag and strong mode nftables rules)
- [x] Wire all components together in extension.ts: config -> httpjail -> secretless broker -> views -> audit
- [x] Implement graceful shutdown: stop httpjail process, stop Secretless Broker, flush audit log
- [x] Write integration tests: full lifecycle from activation through request proxying
- [x] Run project test suite - must pass before task 9

### Task 9: Verify Acceptance Criteria

- [ ] Manual test: open a devcontainer project with .egressor.yml, verify Traffic Panel shows requests
- [ ] Manual test: verify a request to an unlisted host is blocked and appears red in panel
- [ ] Manual test: verify non-HTTP traffic is blocked by httpjail strong mode
- [ ] Manual test: verify secret injection works via Secretless Broker (request leaves container without creds, arrives at destination with creds)
- [ ] Manual test: verify database connection works through Secretless Broker (app connects to localhost, Secretless injects real DB credentials)
- [ ] Manual test: verify session summary shows correct counts
- [ ] Run full test suite
- [ ] Run linter
- [ ] Verify test coverage meets 80%+

### Task 10: Update Documentation

- [ ] Create README.md with installation (including httpjail and Secretless Broker prerequisites), configuration (.egressor.yml reference), usage guide
- [ ] Create CLAUDE.md with project conventions, architecture overview, key file paths
- [ ] Create example .egressor.yml files for common setups
- [ ] Document httpjail rule format and how .egressor.yml maps to httpjail JS rules
- [ ] Document Secretless Broker setup and how .egressor.yml secrets map to secretless.yml services
- [ ] Move this plan to `docs/plans/completed/`
