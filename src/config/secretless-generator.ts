import * as yaml from 'js-yaml';
import { ResolvedConfig, SecretDeclaration } from './types';

/** Secretless Broker service configuration */
interface SecretlessService {
    protocol: string;
    listenOn: string;
    credentials: Record<string, { from: string; get: string }>;
    config?: Record<string, string>;
}

interface SecretlessConfig {
    version: string;
    services: Record<string, SecretlessService>;
}

function buildHttpService(secret: SecretDeclaration, secretsDir: string): SecretlessService {
    const service: SecretlessService = {
        protocol: 'http',
        listenOn: `tcp://0.0.0.0:0`,
        credentials: {},
        config: {
            pattern: secret.target,
        },
    };

    switch (secret.type) {
        case 'bearer_token':
            service.credentials['accessToken'] = {
                from: 'file',
                get: `${secretsDir}/${secret.name}`,
            };
            break;
        case 'header':
            service.credentials[secret.headerName ?? 'Authorization'] = {
                from: 'file',
                get: `${secretsDir}/${secret.name}`,
            };
            break;
        case 'basic_auth':
            service.credentials['username'] = {
                from: 'file',
                get: `${secretsDir}/${secret.name}_username`,
            };
            service.credentials['password'] = {
                from: 'file',
                get: `${secretsDir}/${secret.name}_password`,
            };
            break;
    }

    return service;
}

function buildDatabaseService(secret: SecretDeclaration, secretsDir: string): SecretlessService {
    const protocol = secret.type === 'postgresql' ? 'pg' : 'mysql';
    const defaultPort = secret.type === 'postgresql' ? 5432 : 3306;
    const listenPort = secret.listenPort ?? defaultPort;

    return {
        protocol,
        listenOn: `tcp://0.0.0.0:${listenPort}`,
        credentials: {
            host: { from: 'file', get: `${secretsDir}/${secret.name}_host` },
            port: { from: 'file', get: `${secretsDir}/${secret.name}_port` },
            username: { from: 'file', get: `${secretsDir}/${secret.name}_username` },
            password: { from: 'file', get: `${secretsDir}/${secret.name}_password` },
        },
        config: {
            address: secret.target,
        },
    };
}

/** Build a SecretlessConfig from a secrets array */
function buildSecretlessConfig(secrets: SecretDeclaration[], secretsDir: string): SecretlessConfig {
    const services: Record<string, SecretlessService> = {};

    for (const secret of secrets) {
        switch (secret.type) {
            case 'bearer_token':
            case 'header':
            case 'basic_auth':
                services[secret.name] = buildHttpService(secret, secretsDir);
                break;
            case 'postgresql':
            case 'mysql':
                services[secret.name] = buildDatabaseService(secret, secretsDir);
                break;
            case 'ssh':
                // SSH handled separately, not via Secretless Broker services
                break;
        }
    }

    return {
        version: '2',
        services,
    };
}

/** Generate a Secretless Broker configuration from resolved Egressor config */
export function generateSecretlessConfig(config: ResolvedConfig, secretsDir: string): SecretlessConfig {
    return buildSecretlessConfig(config.secrets, secretsDir);
}

/** Generate secretless.yml content as a YAML string */
export function generateSecretlessYaml(config: ResolvedConfig, secretsDir: string): string {
    const secretlessConfig = generateSecretlessConfig(config, secretsDir);
    return yaml.dump(secretlessConfig, { lineWidth: 120, noRefs: true });
}

/** Generate secretless.yml content from a secrets array */
export function generateSecretlessYamlFromArray(secrets: SecretDeclaration[], secretsDir: string): string {
    const secretlessConfig = buildSecretlessConfig(secrets, secretsDir);
    return yaml.dump(secretlessConfig, { lineWidth: 120, noRefs: true });
}

/** Generate per-container secretless YAML files. Returns Map of container name -> YAML content. */
export function generatePerContainerSecretlessYaml(config: ResolvedConfig, secretsDir: string): Map<string, string> {
    const result = new Map<string, string>();
    for (const container of config.containers) {
        if (container.secrets.length > 0) {
            result.set(container.name, generateSecretlessYamlFromArray(container.secrets, secretsDir));
        }
    }
    return result;
}
