/**
 * Discovers sibling containers via the Docker socket.
 * Falls back gracefully when Docker socket is not available.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import Dockerode = require('dockerode');

/** Information about a discovered container */
export interface DiscoveredContainer {
    id: string;
    name: string;
    image: string;
    labels: Record<string, string>;
    networkMode: string;
}

/** Events emitted by container watching */
export type ContainerEvent =
    | { type: 'started'; container: DiscoveredContainer }
    | { type: 'stopped'; containerId: string };

/** Listener for container events */
export type ContainerEventListener = (event: ContainerEvent) => void;

/** Options for DockerDiscovery */
export interface DockerDiscoveryOptions {
    /** Path to Docker socket. Defaults to /var/run/docker.sock */
    socketPath?: string;
    /** Poll interval in ms for container watching. Defaults to 5000 */
    pollIntervalMs?: number;
    /** Override for Dockerode instance (for testing) */
    docker?: Dockerode;
}

/**
 * Discovers and watches sibling Docker containers.
 */
export class DockerDiscovery {
    private readonly docker: Dockerode;
    private readonly pollIntervalMs: number;
    private readonly currentHostname: string | undefined;
    private pollTimer: ReturnType<typeof setInterval> | undefined;
    private listeners: ContainerEventListener[] = [];
    private knownContainerIds = new Set<string>();
    private available: boolean | undefined;

    constructor(options: DockerDiscoveryOptions = {}) {
        this.docker = options.docker ?? new Dockerode({
            socketPath: options.socketPath ?? '/var/run/docker.sock',
        });
        this.pollIntervalMs = options.pollIntervalMs ?? 5000;
        this.currentHostname = process.env.HOSTNAME;
    }

    /**
     * Check if the Docker socket is available.
     */
    async isAvailable(): Promise<boolean> {
        if (this.available !== undefined) {
            return this.available;
        }
        try {
            await this.docker.ping();
            this.available = true;
        } catch {
            this.available = false;
        }
        return this.available;
    }

    /**
     * List running sibling containers, excluding the current container.
     * Returns empty array if Docker socket is not available.
     */
    async listContainers(): Promise<DiscoveredContainer[]> {
        if (!(await this.isAvailable())) {
            return [];
        }

        const containers = await this.docker.listContainers({ all: false });
        const discovered: DiscoveredContainer[] = [];

        for (const info of containers) {
            // Filter out the current container by matching HOSTNAME
            if (this.isCurrentContainer(info.Id)) {
                continue;
            }

            discovered.push(this.toDiscoveredContainer(info));
        }

        return discovered;
    }

    /**
     * Start watching for container start/stop events via polling.
     * Calls listeners when containers appear or disappear.
     */
    async watchContainers(): Promise<void> {
        if (!(await this.isAvailable())) {
            return;
        }

        // Initialize known containers
        const current = await this.listContainers();
        this.knownContainerIds = new Set(current.map(c => c.id));

        this.pollTimer = setInterval(async () => {
            try {
                await this.poll();
            } catch {
                // Ignore poll errors - Docker may have become unavailable
            }
        }, this.pollIntervalMs);
    }

    /**
     * Stop watching for container events.
     */
    stopWatching(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
        this.listeners = [];
        this.knownContainerIds.clear();
    }

    /**
     * Register a listener for container events.
     */
    onContainerEvent(listener: ContainerEventListener): void {
        this.listeners.push(listener);
    }

    /**
     * Check if a container ID matches the current container.
     */
    private isCurrentContainer(containerId: string): boolean {
        if (!this.currentHostname) {
            return false;
        }
        // Docker container IDs are full 64-char hex; HOSTNAME is typically the first 12 chars
        return containerId.startsWith(this.currentHostname)
            || this.currentHostname.startsWith(containerId.substring(0, 12));
    }

    /**
     * Convert Docker API container info to our DiscoveredContainer type.
     */
    private toDiscoveredContainer(info: Dockerode.ContainerInfo): DiscoveredContainer {
        const name = (info.Names?.[0] ?? '').replace(/^\//, '');
        return {
            id: info.Id,
            name,
            image: info.Image,
            labels: info.Labels ?? {},
            networkMode: info.HostConfig?.NetworkMode ?? 'default',
        };
    }

    /**
     * Poll for container changes and emit events.
     */
    private async poll(): Promise<void> {
        const current = await this.listContainers();
        const currentIds = new Set(current.map(c => c.id));

        // Detect new containers
        for (const container of current) {
            if (!this.knownContainerIds.has(container.id)) {
                this.emit({ type: 'started', container });
            }
        }

        // Detect removed containers
        for (const knownId of this.knownContainerIds) {
            if (!currentIds.has(knownId)) {
                this.emit({ type: 'stopped', containerId: knownId });
            }
        }

        this.knownContainerIds = currentIds;
    }

    private emit(event: ContainerEvent): void {
        for (const listener of this.listeners) {
            listener(event);
        }
    }
}
