/**
 * Types for audit trail and session logging.
 */

import { TrafficEvent } from '../jail/types';
import { SecretInjectionEvent } from '../secrets/types';

/** Types of audit events */
export type AuditEventType = 'traffic' | 'secret_injection';

/** Base audit event with common fields */
export interface AuditEntry {
    /** Unique event ID */
    id: string;
    /** ISO timestamp string */
    timestamp: string;
    /** Type of audit event */
    type: AuditEventType;
    /** The traffic event data (when type is 'traffic') */
    trafficEvent?: SerializedTrafficEvent;
    /** The secret injection event data (when type is 'secret_injection') */
    secretInjectionEvent?: SerializedSecretInjectionEvent;
    /** Container ID (set in multi-container mode) */
    containerId?: string;
    /** Container name (set in multi-container mode) */
    containerName?: string;
}

/** Serializable version of TrafficEvent (Date -> string) */
export interface SerializedTrafficEvent {
    timestamp: string;
    method?: string;
    host: string;
    path?: string;
    port?: number;
    status: 'allowed' | 'blocked';
    category: 'http' | 'non-http' | 'dns';
    protocol?: string;
    durationMs?: number;
    raw: string;
    containerId?: string;
    containerName?: string;
}

/** Serializable version of SecretInjectionEvent (Date -> string) */
export interface SerializedSecretInjectionEvent {
    timestamp: string;
    secretName: string;
    secretType: string;
    target: string;
    success: boolean;
    raw: string;
    containerId?: string;
    containerName?: string;
}

/** Session summary statistics */
export interface SessionSummary {
    /** Session start time (ISO string) */
    sessionStart: string;
    /** Session end time (ISO string) */
    sessionEnd: string;
    /** Duration in milliseconds */
    durationMs: number;
    /** Total number of events */
    totalEvents: number;
    /** Traffic statistics */
    traffic: {
        total: number;
        allowed: number;
        blocked: number;
        httpAllowed: number;
        httpBlocked: number;
        nonHttpBlocked: number;
        dnsAllowed: number;
    };
    /** Secret injection statistics */
    secretInjections: {
        total: number;
        successful: number;
        failed: number;
    };
    /** Top hosts by request count */
    topHosts: Array<{ host: string; count: number }>;
    /** Anomalies detected */
    anomalies: string[];
}

/** Options for the session logger */
export interface SessionLoggerOptions {
    /** Directory to write log files to */
    logDir: string;
    /** Maximum number of top hosts to include in summary */
    maxTopHosts?: number;
    /** Maximum number of entries to keep in memory (default: 10000) */
    maxEntries?: number;
}

/** Convert a TrafficEvent to a serializable form */
export function serializeTrafficEvent(event: TrafficEvent): SerializedTrafficEvent {
    return {
        timestamp: event.timestamp.toISOString(),
        method: event.method,
        host: event.host,
        path: event.path,
        port: event.port,
        status: event.status,
        category: event.category,
        protocol: event.protocol,
        durationMs: event.durationMs,
        raw: event.raw,
        containerId: event.containerId,
        containerName: event.containerName,
    };
}

/** Convert a SecretInjectionEvent to a serializable form */
export function serializeSecretInjectionEvent(event: SecretInjectionEvent): SerializedSecretInjectionEvent {
    return {
        timestamp: event.timestamp.toISOString(),
        secretName: event.secretName,
        secretType: event.secretType,
        target: event.target,
        success: event.success,
        raw: event.raw,
        containerId: event.containerId,
        containerName: event.containerName,
    };
}
