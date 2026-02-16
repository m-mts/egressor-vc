# Egressor - Project Conventions

## Architecture

VS Code extension (TypeScript) that orchestrates httpjail + Secretless Broker for container-based network security.

### Source Layout

```
src/
  extension.ts              Entry point: activation, command registration, EgressorSetup creation
  config/                   .egressor.yml parsing, validation, preset expansion, derived config generation
    types.ts                All config interfaces (EgressorConfig, EgressRule, SecretDeclaration, etc.)
    parser.ts               YAML parsing, validation, preset resolution
    watcher.ts              File watcher for .egressor.yml changes, triggers regeneration
    httpjail-rules-generator.ts  Converts rules to httpjail JS expressions
    secretless-generator.ts      Converts secrets to secretless.yml
  container/                Devcontainer detection and lifecycle orchestration
    detector.ts             Detects devcontainer context via vscode.env.remoteName
    setup.ts                EgressorSetup class - central orchestrator for all components
  jail/                     httpjail process management
    types.ts                TrafficEvent, JailProcessState, JailStartOptions
    manager.ts              Spawns/manages httpjail process, emits TrafficEvents
    events.ts               Parses httpjail stdout into structured TrafficEvent objects
    installer.ts            Detects/installs httpjail binary
  secrets/                  Secretless Broker integration
    types.ts                BrokerProcessState, SecretInjectionEvent, BrokerStartOptions
    broker-manager.ts       Spawns/manages Secretless Broker
    broker-events.ts        Parses broker logs into SecretInjectionEvent objects
    credential-provider.ts  Stores secrets in VS Code SecretStorage, writes secret files
    prompt.ts               Interactive UI for collecting missing secret values
  views/                    UI components
    trafficPanel.ts         WebviewViewProvider for live traffic sidebar
    trafficPanel.html/css/js  Webview resources
    statusBar.ts            Status bar with allowed/blocked counters
    diagnostics.ts          VS Code diagnostics for blocked requests
  audit/                    Audit trail
    types.ts                AuditEntry, serialization helpers
    logger.ts               SessionLogger - writes JSONL audit logs
    summary.ts              Session summary generation and formatting
  test/
    suite/                  All test files (*..test.ts)
    vscode-mock.ts          Mock VS Code APIs (window, workspace, commands, env, etc.)
    register.ts             Test setup: loads vscode mock into require cache
    runTest.ts              VS Code test electron runner
```

### Key Patterns

- Dependency injection throughout: managers accept injected fs, process spawner, etc. for testability
- Event-based architecture: httpjail and broker emit events consumed by views, audit, and diagnostics
- Config is the single source of truth: .egressor.yml generates both httpjail rules and secretless.yml
- All components are disposable (implement dispose pattern for cleanup)
- Preset rules merge with explicit rules; explicit rules win on host deduplication

## Build and Test

```bash
npm run compile        # TypeScript compilation
npm run test:unit      # Mocha unit tests (out/test/**/*.test.js)
npm run test:coverage  # Tests with NYC coverage
npm run lint           # ESLint
```

Tests use mocha with TDD UI (`suite`/`test`), sinon for mocking, and a custom vscode mock (`src/test/vscode-mock.ts`) loaded via `src/test/register.ts`. The vscode mock replaces `require('vscode')` in tests.

## Configuration

Extension config lives in `.egressor.yml` (workspace root). The schema is defined in `src/config/types.ts`. See README.md for the full configuration reference.

## Important Notes

- httpjail rules are JavaScript expressions (not JSON/YAML) - see `httpjail-rules-generator.ts`
- Secretless Broker config is YAML v2 format - see `secretless-generator.ts`
- Database secrets require `listenPort` (1-65535); HTTP secrets do not
- The `header` secret type requires `headerName`
- Wildcard hosts (`*.example.com`) also match the bare domain
- Strong mode (`--strong`) uses nftables for full traffic control including non-HTTP
