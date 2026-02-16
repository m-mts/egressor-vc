/**
 * Types for httpjail traffic events and process management.
 */

/** Status of a traffic request as determined by httpjail */
export type TrafficStatus = 'allowed' | 'blocked';

/** Category of traffic observed by httpjail */
export type TrafficCategory = 'http' | 'non-http' | 'dns';

/** A structured traffic event parsed from httpjail output */
export interface TrafficEvent {
    /** Timestamp of the event */
    timestamp: Date;
    /** HTTP method (for HTTP traffic) */
    method?: string;
    /** Target host */
    host: string;
    /** Request path (for HTTP traffic) */
    path?: string;
    /** Port number */
    port?: number;
    /** Whether the request was allowed or blocked */
    status: TrafficStatus;
    /** Category of traffic */
    category: TrafficCategory;
    /** Protocol (e.g., 'tcp', 'udp', 'http', 'https') */
    protocol?: string;
    /** Response time in milliseconds (if available) */
    durationMs?: number;
    /** Raw log line from httpjail */
    raw: string;
}

/** httpjail process state */
export type JailProcessState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

/** httpjail manager configuration */
export interface JailConfig {
    /** Path to the httpjail binary */
    binaryPath: string;
    /** Path to the generated rules JS file */
    rulesFilePath: string;
    /** Docker container ID or name (for --docker-run mode) */
    containerId?: string;
    /** Whether to enable strong mode (nftables-based full traffic control) */
    strongMode: boolean;
    /** Port for httpjail proxy to listen on */
    proxyPort?: number;
}

/** Options for starting httpjail */
export interface JailStartOptions {
    /** Path to the rules file */
    rulesFilePath: string;
    /** Container ID for --docker-run mode */
    containerId?: string;
    /** Enable strong mode with nftables */
    strongMode?: boolean;
    /** Proxy listen port */
    proxyPort?: number;
}

/** Health check result */
export interface JailHealthStatus {
    /** Whether httpjail process is alive */
    alive: boolean;
    /** Current process state */
    state: JailProcessState;
    /** PID of the httpjail process */
    pid?: number;
    /** Uptime in milliseconds */
    uptimeMs?: number;
    /** Error message if in error state */
    error?: string;
}

/** Callback interface for traffic event listeners */
export interface TrafficEventListener {
    (event: TrafficEvent): void;
}
