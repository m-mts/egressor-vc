/**
 * Types for Secretless Broker integration and secret management.
 */

import { SecretType } from '../config/types';

/** State of the Secretless Broker process */
export type BrokerProcessState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

/** Options for starting the Secretless Broker */
export interface BrokerStartOptions {
    /** Path to the generated secretless.yml config file */
    configFilePath: string;
    /** Path to the directory where secret files are written for the broker */
    secretsDir: string;
    /** Port for the broker health check endpoint */
    healthCheckPort?: number;
}

/** Health check result for the broker */
export interface BrokerHealthStatus {
    /** Whether the broker process is alive */
    alive: boolean;
    /** Current process state */
    state: BrokerProcessState;
    /** PID of the broker process */
    pid?: number;
    /** Uptime in milliseconds */
    uptimeMs?: number;
    /** Error message if in error state */
    error?: string;
}

/** A secret injection event from the Secretless Broker */
export interface SecretInjectionEvent {
    /** Timestamp of the event */
    timestamp: Date;
    /** Name of the secret that was injected */
    secretName: string;
    /** Type of secret */
    secretType: SecretType;
    /** Target host/service the secret was injected for */
    target: string;
    /** Whether injection succeeded */
    success: boolean;
    /** Raw log line from the broker */
    raw: string;
}

/** Callback for secret injection event listeners */
export interface SecretInjectionListener {
    (event: SecretInjectionEvent): void;
}

/** Stored secret metadata (value never exposed in types) */
export interface StoredSecretMetadata {
    /** Secret name */
    name: string;
    /** Secret type */
    type: SecretType;
    /** Target service */
    target: string;
    /** When the secret was stored */
    storedAt: string;
}

/** Fields required to store a secret value, varies by type */
export interface SecretFields {
    /** Primary value (token, password, etc.) */
    value?: string;
    /** Username for basic_auth and database types */
    username?: string;
    /** Password for basic_auth and database types */
    password?: string;
    /** Host for database types */
    host?: string;
    /** Port for database types */
    port?: string;
}
