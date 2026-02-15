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

function buildHttpService(secret: SecretDeclaration): SecretlessService {
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
                get: `/run/secrets/${secret.name}`,
            };
            break;
        case 'header':
            service.credentials[secret.headerName ?? 'Authorization'] = {
                from: 'file',
                get: `/run/secrets/${secret.name}`,
            };
            break;
        case 'basic_auth':
            service.credentials['username'] = {
                from: 'file',
                get: `/run/secrets/${secret.name}_username`,
            };
            service.credentials['password'] = {
                from: 'file',
                get: `/run/secrets/${secret.name}_password`,
            };
            break;
    }

    return service;
}

function buildDatabaseService(secret: SecretDeclaration): SecretlessService {
    const protocol = secret.type === 'postgresql' ? 'pg' : 'mysql';
    const defaultPort = secret.type === 'postgresql' ? 5432 : 3306;
    const listenPort = secret.listenPort ?? defaultPort;

    return {
        protocol,
        listenOn: `tcp://0.0.0.0:${listenPort}`,
        credentials: {
            host: { from: 'file', get: `/run/secrets/${secret.name}_host` },
            port: { from: 'file', get: `/run/secrets/${secret.name}_port` },
            username: { from: 'file', get: `/run/secrets/${secret.name}_username` },
            password: { from: 'file', get: `/run/secrets/${secret.name}_password` },
        },
        config: {
            address: secret.target,
        },
    };
}

/** Generate a Secretless Broker configuration from resolved Egressor config */
export function generateSecretlessConfig(config: ResolvedConfig): SecretlessConfig {
    const services: Record<string, SecretlessService> = {};

    for (const secret of config.secrets) {
        switch (secret.type) {
            case 'bearer_token':
            case 'header':
            case 'basic_auth':
                services[secret.name] = buildHttpService(secret);
                break;
            case 'postgresql':
            case 'mysql':
                services[secret.name] = buildDatabaseService(secret);
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

/** Generate secretless.yml content as a YAML string */
export function generateSecretlessYaml(config: ResolvedConfig): string {
    const secretlessConfig = generateSecretlessConfig(config);
    return yaml.dump(secretlessConfig, { lineWidth: 120, noRefs: true });
}
