# Multi-Container Egress and Secrets Control

## Overview

Extend egressor from single-container to multi-container support. The extension will auto-discover sibling containers via the Docker socket, and allow per-container configuration of egress rules and/or secrets protection. A new UI section in the traffic panel will show discovered containers with toggles for what protection each container gets.

## Context

- Files involved: src/config/types.ts, src/config/parser.ts, src/config/watcher.ts, src/config/httpjail-rules-generator.ts, src/container/detector.ts, src/container/setup.ts, src/jail/manager.ts, src/secrets/broker-manager.ts, src/views/trafficPanel.ts, src/views/trafficPanel.html, src/views/trafficPanel.js, src/views/trafficPanel.css
- Related patterns: existing single-container flow in EgressorSetup, httpjail --docker-run flag, ConfigWatcher reload pipeline
- Dependencies: Docker socket access (usually /var/run/docker.sock mounted into devcontainer), dockerode npm package for Docker API

## Development Approach

- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Add Docker container discovery module

**Files:**
- Create: `src/container/docker-discovery.ts`

- [x] Add dockerode as a dependency (npm install dockerode @types/dockerode)
- [x] Create DockerDiscovery class that connects to Docker socket (/var/run/docker.sock)
- [x] Implement listContainers() that returns running sibling containers (id, name, image, labels, network)
- [x] Filter out the current container (match by HOSTNAME env var) from the list
- [x] Implement watchContainers() that polls or uses Docker events to detect container start/stop
- [x] Handle Docker socket not available gracefully (fall back to single-container mode)
- [x] Write tests for DockerDiscovery with mocked dockerode

### Task 2: Extend config schema for per-container settings

**Files:**
- Modify: `src/config/types.ts`
- Modify: `src/config/parser.ts`

- [x] Add ContainerConfig interface: { name: string, match: { name?: string, image?: string, label?: Record<string,string> }, egress?: boolean | EgressRule[], secrets?: boolean | SecretDeclaration[] }
- [x] Add optional containers field to EgressorConfig: containers?: ContainerConfig[]
- [x] When containers field is absent, behavior is unchanged (current single-container mode for backward compatibility)
- [x] Add parsing and validation for the new containers field in parser.ts
- [x] Add ResolvedContainerConfig to ResolvedConfig with per-container resolved rules and secrets
- [x] Write tests for config parsing with the new containers field

### Task 3: Per-container rule and secretless config generation

**Files:**
- Modify: `src/config/httpjail-rules-generator.ts`
- Modify: `src/config/watcher.ts`
- Create: `src/config/secretless-generator.ts` (if not already generating per-container)

- [x] Modify httpjail rules generator to produce per-container rule files (one .js per container)
- [x] Modify ConfigWatcher.writeDerivedConfigs() to generate per-container output files
- [x] When a container config has egress: true, it inherits the top-level rules; when egress is an array, those specific rules apply
- [x] Same pattern for secrets: true inherits top-level, array overrides
- [x] Write tests for per-container rule file generation

### Task 4: Multi-container orchestration in EgressorSetup

**Files:**
- Modify: `src/container/setup.ts`
- Modify: `src/jail/manager.ts`

- [x] Create ContainerOrchestrator that manages a Map of containerId -> { httpjailManager?, brokerManager? }
- [x] On start(), use DockerDiscovery to list containers, match them against config, spawn per-container httpjail/broker instances
- [x] Each httpjail instance uses --docker-run <containerId> with its own rules file
- [x] Wire per-container traffic events with container identity (add containerId/containerName to TrafficEvent)
- [x] Handle container start/stop events: spin up/tear down enforcement for matching containers
- [x] On stop(), tear down all per-container managers
- [x] Write tests for multi-container orchestration with mocked managers

### Task 5: Add container identity to traffic and secret events

**Files:**
- Modify: `src/jail/types.ts`
- Modify: `src/secrets/types.ts`
- Modify: `src/audit/types.ts`

- [x] Add optional containerName and containerId fields to TrafficEvent
- [x] Add optional containerName and containerId fields to SecretInjectionEvent
- [x] Update AuditEntry to include container identity
- [x] Write tests for event types with container fields

### Task 6: Container management UI in traffic panel

**Files:**
- Modify: `src/views/trafficPanel.html`
- Modify: `src/views/trafficPanel.js`
- Modify: `src/views/trafficPanel.css`
- Modify: `src/views/trafficPanel.ts`

- [x] Add a "Containers" section above the event list showing discovered containers as cards/chips
- [x] Each container card shows: name, image, protection mode (egress/secrets/both/none)
- [x] Add a container filter dropdown to the toolbar so events can be filtered by container
- [x] Add container name column/badge to each event row
- [x] Color-code or icon-differentiate containers in the event list
- [x] Add postContainerStatus() message type from extension to webview for container discovery updates
- [x] Handle container appear/disappear events in the UI (add/remove container cards)
- [x] Write tests for the TrafficPanelProvider message handling with container data

### Task 7: Verify acceptance criteria

- [x] Manual test: create a docker-compose setup with 2+ containers, configure per-container rules, verify independent enforcement
- [x] Manual test: verify single-container mode still works when containers field is absent
- [x] Run full test suite
- [x] Run linter
- [x] Verify test coverage meets 80%+

### Task 8: Update documentation

- [ ] Update README.md with multi-container configuration examples
- [ ] Update CLAUDE.md if internal patterns changed
- [ ] Move this plan to `docs/plans/completed/`
