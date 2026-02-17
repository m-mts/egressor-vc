/**
 * Manages per-container httpjail and broker instances for multi-container mode.
 * Matches discovered Docker containers against config and spawns enforcement.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { DockerDiscovery, DiscoveredContainer, ContainerEvent } from './docker-discovery';
import { ResolvedConfig, ResolvedContainerConfig, ContainerMatch } from '../config/types';
import { HttpjailManager } from '../jail/manager';
import { SecretlessBrokerManager } from '../secrets/broker-manager';
import { TrafficEvent } from '../jail/types';
import { SecretInjectionEvent } from '../secrets/types';

/** Per-container enforcement state */
export interface ContainerEnforcement {
    containerId: string;
    containerName: string;
    configName: string;
    httpjailManager?: HttpjailManager;
    brokerManager?: SecretlessBrokerManager;
    disposables: vscode.Disposable[];
}

/** Listener for traffic events enriched with container identity */
export type ContainerTrafficListener = (event: TrafficEvent, containerId: string, containerName: string) => void;

/** Listener for secret events enriched with container identity */
export type ContainerSecretListener = (event: SecretInjectionEvent, containerId: string, containerName: string) => void;

/** Factory for creating managers, enabling testability */
export interface ManagerFactory {
    createHttpjailManager(outputChannel: vscode.OutputChannel): HttpjailManager;
    createBrokerManager(outputChannel: vscode.OutputChannel): SecretlessBrokerManager;
}

/** Default factory that creates real managers */
const defaultManagerFactory: ManagerFactory = {
    createHttpjailManager(outputChannel: vscode.OutputChannel): HttpjailManager {
        return new HttpjailManager(outputChannel);
    },
    createBrokerManager(outputChannel: vscode.OutputChannel): SecretlessBrokerManager {
        return new SecretlessBrokerManager(outputChannel);
    },
};

/**
 * Orchestrates per-container enforcement by matching discovered containers
 * against configuration and managing httpjail/broker instances for each.
 */
export class ContainerOrchestrator implements vscode.Disposable {
    private readonly enforcements = new Map<string, ContainerEnforcement>();
    private readonly outputChannel: vscode.OutputChannel;
    private readonly discovery: DockerDiscovery;
    private readonly managerFactory: ManagerFactory;
    private readonly outputDir: string;
    private readonly secretsDir: string;
    private currentConfig: ResolvedConfig | undefined;
    private trafficListeners: ContainerTrafficListener[] = [];
    private secretListeners: ContainerSecretListener[] = [];
    private watching = false;
    private disposed = false;

    constructor(options: {
        outputChannel: vscode.OutputChannel;
        discovery: DockerDiscovery;
        outputDir: string;
        secretsDir: string;
        managerFactory?: ManagerFactory;
    }) {
        this.outputChannel = options.outputChannel;
        this.discovery = options.discovery;
        this.outputDir = options.outputDir;
        this.secretsDir = options.secretsDir;
        this.managerFactory = options.managerFactory ?? defaultManagerFactory;
    }

    /** Register a listener for per-container traffic events */
    onTrafficEvent(listener: ContainerTrafficListener): vscode.Disposable {
        this.trafficListeners.push(listener);
        return {
            dispose: () => {
                const idx = this.trafficListeners.indexOf(listener);
                if (idx >= 0) { this.trafficListeners.splice(idx, 1); }
            },
        };
    }

    /** Register a listener for per-container secret injection events */
    onSecretEvent(listener: ContainerSecretListener): vscode.Disposable {
        this.secretListeners.push(listener);
        return {
            dispose: () => {
                const idx = this.secretListeners.indexOf(listener);
                if (idx >= 0) { this.secretListeners.splice(idx, 1); }
            },
        };
    }

    /** Get the current enforcement map (for testing/inspection) */
    getEnforcements(): ReadonlyMap<string, ContainerEnforcement> {
        return this.enforcements;
    }

    /**
     * Start orchestration: discover containers, match against config,
     * spawn per-container enforcement, and begin watching for changes.
     */
    async start(config: ResolvedConfig): Promise<void> {
        this.currentConfig = config;

        if (config.containers.length === 0) {
            this.outputChannel.appendLine('ContainerOrchestrator: no container configs defined, skipping');
            return;
        }

        const available = await this.discovery.isAvailable();
        if (!available) {
            this.outputChannel.appendLine('ContainerOrchestrator: Docker not available, skipping multi-container mode');
            return;
        }

        // List current containers and match against config
        const containers = await this.discovery.listContainers();
        this.outputChannel.appendLine(`ContainerOrchestrator: discovered ${containers.length} sibling containers`);

        for (const container of containers) {
            await this.setupContainerIfMatched(container, config);
        }

        // Start watching for container start/stop
        this.discovery.onContainerEvent((event: ContainerEvent) => {
            this.handleContainerEvent(event).catch(err => {
                this.outputChannel.appendLine(`ContainerOrchestrator: error handling container event: ${err}`);
            });
        });
        await this.discovery.watchContainers();
        this.watching = true;
    }

    /**
     * Stop all per-container enforcement and clean up.
     */
    async stop(): Promise<void> {
        if (this.watching) {
            this.discovery.stopWatching();
            this.watching = false;
        }

        const stopPromises: Promise<void>[] = [];
        for (const [containerId, enforcement] of this.enforcements) {
            stopPromises.push(this.teardownEnforcement(containerId, enforcement));
        }
        await Promise.all(stopPromises);
        this.enforcements.clear();
    }

    /**
     * Update config and re-evaluate container matches.
     * Tears down enforcements that no longer match, sets up new ones.
     */
    async updateConfig(config: ResolvedConfig): Promise<void> {
        this.currentConfig = config;

        // Tear down enforcements whose config no longer matches
        for (const [containerId, enforcement] of [...this.enforcements]) {
            const stillMatches = config.containers.some(cc =>
                cc.name === enforcement.configName
            );
            if (!stillMatches) {
                await this.teardownEnforcement(containerId, enforcement);
                this.enforcements.delete(containerId);
            }
        }

        // Re-check containers for new matches
        if (await this.discovery.isAvailable()) {
            const containers = await this.discovery.listContainers();
            for (const container of containers) {
                if (!this.enforcements.has(container.id)) {
                    await this.setupContainerIfMatched(container, config);
                }
            }
        }
    }

    /**
     * Match a discovered container against config and set up enforcement if matched.
     */
    private async setupContainerIfMatched(
        container: DiscoveredContainer,
        config: ResolvedConfig
    ): Promise<void> {
        const matchedConfig = this.findMatchingConfig(container, config.containers);
        if (!matchedConfig) {
            return;
        }

        this.outputChannel.appendLine(
            `ContainerOrchestrator: matched container "${container.name}" (${container.id.substring(0, 12)}) to config "${matchedConfig.name}"`
        );

        await this.setupEnforcement(container, matchedConfig);
    }

    /**
     * Find the first container config that matches a discovered container.
     */
    private findMatchingConfig(
        container: DiscoveredContainer,
        configs: ResolvedContainerConfig[]
    ): ResolvedContainerConfig | undefined {
        for (const config of configs) {
            if (this.matchesContainer(container, config.match)) {
                return config;
            }
        }
        return undefined;
    }

    /**
     * Check if a discovered container matches the given criteria.
     */
    private matchesContainer(container: DiscoveredContainer, match: ContainerMatch): boolean {
        if (match.name !== undefined) {
            if (!this.globMatch(container.name, match.name)) {
                return false;
            }
        }

        if (match.image !== undefined) {
            if (!this.globMatch(container.image, match.image)) {
                return false;
            }
        }

        if (match.label !== undefined) {
            for (const [key, value] of Object.entries(match.label)) {
                if (container.labels[key] !== value) {
                    return false;
                }
            }
        }

        // At least one criterion must be specified
        if (match.name === undefined && match.image === undefined && match.label === undefined) {
            return false;
        }

        return true;
    }

    /**
     * Simple glob matching: supports * (any chars) and exact match.
     */
    private globMatch(value: string, pattern: string): boolean {
        if (pattern === '*') {
            return true;
        }
        if (pattern.startsWith('*')) {
            return value.endsWith(pattern.substring(1));
        }
        if (pattern.endsWith('*')) {
            return value.startsWith(pattern.substring(0, pattern.length - 1));
        }
        return value === pattern;
    }

    /**
     * Set up httpjail and/or broker enforcement for a matched container.
     */
    private async setupEnforcement(
        container: DiscoveredContainer,
        config: ResolvedContainerConfig
    ): Promise<void> {
        const enforcement: ContainerEnforcement = {
            containerId: container.id,
            containerName: container.name,
            configName: config.name,
            disposables: [],
        };

        // Set up httpjail if container has egress rules
        if (config.rules.length > 0) {
            const manager = this.managerFactory.createHttpjailManager(this.outputChannel);
            enforcement.httpjailManager = manager;

            // Wire traffic events with container identity
            const sub = manager.onTrafficEvent((event: TrafficEvent) => {
                for (const listener of [...this.trafficListeners]) {
                    listener(event, container.id, container.name);
                }
            });
            enforcement.disposables.push(sub);

            // Start httpjail with container-specific rules file
            const rulesFilePath = path.join(this.outputDir, `httpjail-rules-${config.name}.js`);
            await manager.start({
                rulesFilePath,
                containerId: container.id,
                strongMode: true,
            });
        }

        // Set up broker if container has secrets
        if (config.secrets.length > 0) {
            const manager = this.managerFactory.createBrokerManager(this.outputChannel);
            enforcement.brokerManager = manager;

            // Wire secret events with container identity
            const sub = manager.onSecretInjection((event: SecretInjectionEvent) => {
                for (const listener of [...this.secretListeners]) {
                    listener(event, container.id, container.name);
                }
            });
            enforcement.disposables.push(sub);

            // Start broker with container-specific config
            const configFilePath = path.join(this.outputDir, `secretless-${config.name}.yml`);
            await manager.start({
                configFilePath,
                secretsDir: this.secretsDir,
            });
        }

        this.enforcements.set(container.id, enforcement);
    }

    /**
     * Handle a container start/stop event from DockerDiscovery.
     */
    private async handleContainerEvent(event: ContainerEvent): Promise<void> {
        if (!this.currentConfig) {
            return;
        }

        if (event.type === 'started') {
            // New container appeared - check if it matches any config
            if (!this.enforcements.has(event.container.id)) {
                await this.setupContainerIfMatched(event.container, this.currentConfig);
            }
        } else if (event.type === 'stopped') {
            // Container disappeared - tear down its enforcement
            const enforcement = this.enforcements.get(event.containerId);
            if (enforcement) {
                this.outputChannel.appendLine(
                    `ContainerOrchestrator: container "${enforcement.containerName}" stopped, tearing down enforcement`
                );
                await this.teardownEnforcement(event.containerId, enforcement);
                this.enforcements.delete(event.containerId);
            }
        }
    }

    /**
     * Tear down enforcement for a single container.
     */
    private async teardownEnforcement(containerId: string, enforcement: ContainerEnforcement): Promise<void> {
        const stopPromises: Promise<void>[] = [];

        if (enforcement.httpjailManager) {
            stopPromises.push(
                enforcement.httpjailManager.stop().catch(err => {
                    this.outputChannel.appendLine(
                        `ContainerOrchestrator: error stopping httpjail for ${containerId}: ${err}`
                    );
                })
            );
        }

        if (enforcement.brokerManager) {
            stopPromises.push(
                enforcement.brokerManager.stop().catch(err => {
                    this.outputChannel.appendLine(
                        `ContainerOrchestrator: error stopping broker for ${containerId}: ${err}`
                    );
                })
            );
        }

        await Promise.all(stopPromises);

        for (const d of enforcement.disposables) {
            d.dispose();
        }
        enforcement.disposables.length = 0;
    }

    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;

        if (this.watching) {
            this.discovery.stopWatching();
            this.watching = false;
        }

        for (const [, enforcement] of this.enforcements) {
            enforcement.httpjailManager?.dispose();
            enforcement.brokerManager?.dispose();
            for (const d of enforcement.disposables) {
                d.dispose();
            }
        }
        this.enforcements.clear();
        this.trafficListeners = [];
        this.secretListeners = [];
    }
}
