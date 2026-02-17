# Dependency Health Check on Panel Open

## Overview
When the Egressor Traffic Panel is opened (resolved), run a dependency health check that verifies httpjail and CyberArk Secretless Broker are installed and running. If either is missing or not running, show a notification with an action button that opens the relevant setup documentation.

## Context
- Files involved:
  - `src/views/trafficPanel.ts` - TrafficPanelProvider.resolveWebviewView is the hook point
  - `src/jail/installer.ts` - existing detectHttpjail() function
  - `src/jail/manager.ts` - HttpjailManager with getState() and healthCheck()
  - `src/secrets/broker-manager.ts` - SecretlessBrokerManager with getState() and healthCheck()
  - `src/container/setup.ts` - EgressorSetup orchestrator that holds references to both managers
  - `src/extension.ts` - activation, wiring
  - `docs/httpjail-rules.md` - existing httpjail documentation
  - `docs/secretless-broker.md` - existing broker documentation
- Related patterns: The extension already uses vscode.window.showWarningMessage with action buttons (see installer.ts promptInstall). The TrafficPanelProvider already receives extensionUri for resource paths.
- Dependencies: None new - uses existing VS Code APIs and existing manager classes

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Add Secretless Broker binary detection

**Files:**
- Modify: `src/secrets/broker-manager.ts`

Currently SecretlessBrokerManager hardcodes `'secretless-broker'` with no detection. Add a static method `detectBroker()` that checks if `secretless-broker` is on PATH (similar pattern to `detectHttpjail()` in `src/jail/installer.ts`).

- [x] Add a `detectBrokerBinary()` function that uses `which`/`where` to check if `secretless-broker` is available on PATH
- [x] Return a simple `{ found: boolean; path?: string }` result
- [x] Write tests for detectBrokerBinary with mocked system operations
- [x] Run project test suite - must pass before task 2

### Task 2: Add dependency health check to TrafficPanelProvider

**Files:**
- Modify: `src/views/trafficPanel.ts`
- Modify: `src/container/setup.ts`
- Modify: `src/extension.ts`

When resolveWebviewView fires (panel opened), check:
1. Is httpjail binary installed? (use detectHttpjail from installer.ts)
2. Is secretless-broker binary installed? (use new detectBrokerBinary)
3. Are they currently running? (use manager.getState())

If not installed or not running, show a warning notification with a "View Setup Guide" button that opens the relevant doc file.

- [ ] Give TrafficPanelProvider access to HttpjailManager and SecretlessBrokerManager (pass via constructor or a callback)
- [ ] In resolveWebviewView, after setting up the webview, call an async check method
- [ ] Check httpjail: call detectHttpjail(). If not found, show warning with button to open docs/httpjail-rules.md. If found but manager state is not 'running', show info notification suggesting to run "Egressor: Start"
- [ ] Check secretless-broker: call detectBrokerBinary(). If not found, show warning with button to open docs/secretless-broker.md. If found but manager state is not 'running' and config has secrets, show info notification
- [ ] When user clicks "View Setup Guide", use vscode.commands.executeCommand('markdown.showPreview', docUri) to open the doc
- [ ] Update EgressorSetup to pass the managers to TrafficPanelProvider
- [ ] Update extension.ts if constructor changes require it
- [ ] Write tests for the health check logic
- [ ] Run project test suite - must pass before task 3

### Task 3: Verify acceptance criteria

- [ ] Manual test: open the Traffic Panel when httpjail is not installed - verify warning appears
- [ ] Manual test: open the Traffic Panel when secretless-broker is not installed - verify warning appears
- [ ] Manual test: click "View Setup Guide" - verify doc opens
- [ ] Manual test: open the Traffic Panel when both are installed and running - verify no warnings
- [ ] Run full test suite (`npm run test:unit`)
- [ ] Run linter (`npm run lint`)
- [ ] Verify test coverage meets 80%+

### Task 4: Update documentation

- [ ] Update README.md if user-facing changes
- [ ] Update CLAUDE.md if internal patterns changed
- [ ] Move this plan to `docs/plans/completed/`
