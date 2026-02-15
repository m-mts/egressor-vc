/**
 * TypeScript interfaces for the .egressor.yml configuration schema.
 */

/** HTTP methods that can be filtered */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

/** A single egress rule defining allowed outbound traffic */
export interface EgressRule {
    /** Host or domain pattern to allow (e.g., "registry.npmjs.org", "*.github.com") */
    host: string;
    /** Optional list of allowed HTTP methods. If omitted, all methods allowed. */
    methods?: HttpMethod[];
    /** Optional list of allowed path prefixes. If omitted, all paths allowed. */
    paths?: string[];
    /** Optional human-readable description */
    description?: string;
}

/** Secret type for Secretless Broker configuration */
export type SecretType = 'bearer_token' | 'header' | 'basic_auth' | 'postgresql' | 'mysql' | 'ssh';

/** A secret declaration in .egressor.yml */
export interface SecretDeclaration {
    /** Unique name for this secret */
    name: string;
    /** Type of secret / connector */
    type: SecretType;
    /** Target host or service this secret applies to */
    target: string;
    /** Listen port for database connectors (Secretless Broker listens here) */
    listenPort?: number;
    /** Header name for 'header' type secrets */
    headerName?: string;
    /** Description of what this secret is for */
    description?: string;
}

/** Preset names that expand to predefined rule sets */
export type PresetName =
    | 'node-fullstack'
    | 'python-data-science'
    | 'java-enterprise'
    | 'go-standard'
    | 'web-frontend';

/** Top-level .egressor.yml configuration */
export interface EgressorConfig {
    /** Schema version */
    version: string;
    /** Optional presets to include */
    presets?: PresetName[];
    /** Egress rules (allow-listed hosts) */
    rules: EgressRule[];
    /** Secret declarations for Secretless Broker */
    secrets?: SecretDeclaration[];
}

/** Parsed and resolved configuration (presets expanded) */
export interface ResolvedConfig {
    version: string;
    rules: EgressRule[];
    secrets: SecretDeclaration[];
}

/** Validation error from config parsing */
export interface ConfigValidationError {
    field: string;
    message: string;
}

/** Result of config parsing */
export type ConfigParseResult =
    | { ok: true; config: EgressorConfig }
    | { ok: false; errors: ConfigValidationError[] };
