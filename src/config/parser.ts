import * as yaml from 'js-yaml';
import {
    EgressorConfig,
    EgressRule,
    SecretDeclaration,
    ContainerConfig,
    ConfigParseResult,
    ConfigValidationError,
    ResolvedConfig,
    ResolvedContainerConfig,
    HttpMethod,
    SecretType,
    PresetName,
} from './types';

const VALID_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
const VALID_SECRET_TYPES: SecretType[] = ['bearer_token', 'header', 'basic_auth', 'postgresql', 'mysql', 'ssh'];
const VALID_PRESETS: PresetName[] = ['node-fullstack', 'python-data-science', 'java-enterprise', 'go-standard', 'web-frontend'];

/** Preset definitions: each preset expands to a set of common egress rules */
const PRESET_RULES: Record<PresetName, EgressRule[]> = {
    'node-fullstack': [
        { host: 'registry.npmjs.org', description: 'npm registry' },
        { host: '*.npmjs.org', description: 'npm CDN' },
        { host: '*.github.com', description: 'GitHub' },
        { host: 'github.com', description: 'GitHub' },
        { host: 'api.github.com', description: 'GitHub API' },
        { host: '*.googleapis.com', description: 'Google APIs' },
    ],
    'python-data-science': [
        { host: 'pypi.org', description: 'PyPI registry' },
        { host: 'files.pythonhosted.org', description: 'PyPI packages' },
        { host: '*.anaconda.org', description: 'Anaconda' },
        { host: 'conda.anaconda.org', description: 'Conda packages' },
        { host: 'github.com', description: 'GitHub' },
    ],
    'java-enterprise': [
        { host: 'repo1.maven.org', description: 'Maven Central' },
        { host: '*.maven.org', description: 'Maven repositories' },
        { host: 'plugins.gradle.org', description: 'Gradle plugins' },
        { host: 'github.com', description: 'GitHub' },
    ],
    'go-standard': [
        { host: 'proxy.golang.org', description: 'Go module proxy' },
        { host: 'sum.golang.org', description: 'Go checksum DB' },
        { host: 'storage.googleapis.com', description: 'Go module storage' },
        { host: 'github.com', description: 'GitHub' },
    ],
    'web-frontend': [
        { host: 'registry.npmjs.org', description: 'npm registry' },
        { host: '*.npmjs.org', description: 'npm CDN' },
        { host: 'cdn.jsdelivr.net', description: 'jsDelivr CDN' },
        { host: 'unpkg.com', description: 'unpkg CDN' },
        { host: '*.cdnjs.cloudflare.com', description: 'cdnjs' },
    ],
};

function validateRule(rule: unknown, index: number): ConfigValidationError[] {
    const errors: ConfigValidationError[] = [];
    const prefix = `rules[${index}]`;

    if (typeof rule !== 'object' || rule === null) {
        errors.push({ field: prefix, message: 'Rule must be an object' });
        return errors;
    }

    const r = rule as Record<string, unknown>;

    if (typeof r.host !== 'string' || r.host.trim() === '') {
        errors.push({ field: `${prefix}.host`, message: 'host is required and must be a non-empty string' });
    } else if (!/^(\*\.)?[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(r.host.trim())) {
        errors.push({ field: `${prefix}.host`, message: 'host must be a valid hostname pattern (alphanumeric, dots, hyphens, optional *. prefix)' });
    }

    if (r.methods !== undefined) {
        if (!Array.isArray(r.methods)) {
            errors.push({ field: `${prefix}.methods`, message: 'methods must be an array' });
        } else {
            for (const m of r.methods) {
                if (!VALID_METHODS.includes(m as HttpMethod)) {
                    errors.push({ field: `${prefix}.methods`, message: `Invalid method: ${m}. Valid: ${VALID_METHODS.join(', ')}` });
                }
            }
        }
    }

    if (r.paths !== undefined) {
        if (!Array.isArray(r.paths)) {
            errors.push({ field: `${prefix}.paths`, message: 'paths must be an array' });
        } else {
            for (const p of r.paths) {
                if (typeof p !== 'string') {
                    errors.push({ field: `${prefix}.paths`, message: 'Each path must be a string' });
                }
            }
        }
    }

    return errors;
}

function validateSecret(secret: unknown, index: number): ConfigValidationError[] {
    const errors: ConfigValidationError[] = [];
    const prefix = `secrets[${index}]`;

    if (typeof secret !== 'object' || secret === null) {
        errors.push({ field: prefix, message: 'Secret must be an object' });
        return errors;
    }

    const s = secret as Record<string, unknown>;

    if (typeof s.name !== 'string' || s.name.trim() === '') {
        errors.push({ field: `${prefix}.name`, message: 'name is required and must be a non-empty string' });
    } else if (!/^[a-zA-Z0-9_-]+$/.test(s.name.trim())) {
        errors.push({ field: `${prefix}.name`, message: 'name must contain only alphanumeric characters, hyphens, and underscores' });
    }

    if (!VALID_SECRET_TYPES.includes(s.type as SecretType)) {
        errors.push({ field: `${prefix}.type`, message: `type must be one of: ${VALID_SECRET_TYPES.join(', ')}` });
    }

    if (typeof s.target !== 'string' || s.target.trim() === '') {
        errors.push({ field: `${prefix}.target`, message: 'target is required and must be a non-empty string' });
    }

    if (s.type === 'ssh') {
        errors.push({ field: `${prefix}.type`, message: 'ssh secret type is not yet supported; use bearer_token, header, basic_auth, postgresql, or mysql' });
    }

    if (s.type === 'header' && (typeof s.headerName !== 'string' || s.headerName.trim() === '')) {
        errors.push({ field: `${prefix}.headerName`, message: 'headerName is required for header type secrets' });
    }

    if ((s.type === 'postgresql' || s.type === 'mysql') && (typeof s.listenPort !== 'number' || !Number.isInteger(s.listenPort) || s.listenPort < 1 || s.listenPort > 65535)) {
        errors.push({ field: `${prefix}.listenPort`, message: 'listenPort is required for database connectors and must be an integer 1-65535' });
    }

    return errors;
}

function validateContainerMatch(match: unknown, prefix: string): ConfigValidationError[] {
    const errors: ConfigValidationError[] = [];

    if (typeof match !== 'object' || match === null) {
        errors.push({ field: `${prefix}.match`, message: 'match must be an object' });
        return errors;
    }

    const m = match as Record<string, unknown>;

    if (m.name !== undefined && typeof m.name !== 'string') {
        errors.push({ field: `${prefix}.match.name`, message: 'match.name must be a string' });
    }

    if (m.image !== undefined && typeof m.image !== 'string') {
        errors.push({ field: `${prefix}.match.image`, message: 'match.image must be a string' });
    }

    if (m.label !== undefined) {
        if (typeof m.label !== 'object' || m.label === null || Array.isArray(m.label)) {
            errors.push({ field: `${prefix}.match.label`, message: 'match.label must be an object of key-value pairs' });
        } else {
            for (const [key, val] of Object.entries(m.label as Record<string, unknown>)) {
                if (typeof val !== 'string') {
                    errors.push({ field: `${prefix}.match.label.${key}`, message: 'label values must be strings' });
                }
            }
        }
    }

    // At least one match criterion must be specified
    if (m.name === undefined && m.image === undefined && m.label === undefined) {
        errors.push({ field: `${prefix}.match`, message: 'match must specify at least one criterion (name, image, or label)' });
    }

    return errors;
}

function validateContainerConfig(container: unknown, index: number): ConfigValidationError[] {
    const errors: ConfigValidationError[] = [];
    const prefix = `containers[${index}]`;

    if (typeof container !== 'object' || container === null) {
        errors.push({ field: prefix, message: 'Container config must be an object' });
        return errors;
    }

    const c = container as Record<string, unknown>;

    if (typeof c.name !== 'string' || c.name.trim() === '') {
        errors.push({ field: `${prefix}.name`, message: 'name is required and must be a non-empty string' });
    }

    errors.push(...validateContainerMatch(c.match, prefix));

    // Validate egress field
    if (c.egress !== undefined && typeof c.egress !== 'boolean') {
        if (!Array.isArray(c.egress)) {
            errors.push({ field: `${prefix}.egress`, message: 'egress must be a boolean or an array of rules' });
        } else {
            for (let i = 0; i < c.egress.length; i++) {
                errors.push(...validateRule(c.egress[i], i).map(e => ({
                    field: e.field.replace(/^rules/, `${prefix}.egress`),
                    message: e.message,
                })));
            }
        }
    }

    // Validate secrets field
    if (c.secrets !== undefined && typeof c.secrets !== 'boolean') {
        if (!Array.isArray(c.secrets)) {
            errors.push({ field: `${prefix}.secrets`, message: 'secrets must be a boolean or an array of secret declarations' });
        } else {
            for (let i = 0; i < c.secrets.length; i++) {
                errors.push(...validateSecret(c.secrets[i], i).map(e => ({
                    field: e.field.replace(/^secrets/, `${prefix}.secrets`),
                    message: e.message,
                })));
            }
        }
    }

    return errors;
}

/** Parse raw YAML string into an EgressorConfig with validation */
export function parseConfig(yamlContent: string): ConfigParseResult {
    const errors: ConfigValidationError[] = [];

    let parsed: unknown;
    try {
        parsed = yaml.load(yamlContent);
    } catch (e) {
        return { ok: false, errors: [{ field: 'yaml', message: `Invalid YAML: ${(e as Error).message}` }] };
    }

    if (typeof parsed !== 'object' || parsed === null) {
        return { ok: false, errors: [{ field: 'root', message: 'Config must be a YAML object' }] };
    }

    const doc = parsed as Record<string, unknown>;

    // Version
    if (typeof doc.version !== 'string') {
        errors.push({ field: 'version', message: 'version is required and must be a string' });
    }

    // Presets
    if (doc.presets !== undefined) {
        if (!Array.isArray(doc.presets)) {
            errors.push({ field: 'presets', message: 'presets must be an array' });
        } else {
            for (const p of doc.presets) {
                if (!VALID_PRESETS.includes(p as PresetName)) {
                    errors.push({ field: 'presets', message: `Invalid preset: ${p}. Valid: ${VALID_PRESETS.join(', ')}` });
                }
            }
        }
    }

    // Rules
    if (!Array.isArray(doc.rules)) {
        errors.push({ field: 'rules', message: 'rules is required and must be an array' });
    } else {
        for (let i = 0; i < doc.rules.length; i++) {
            errors.push(...validateRule(doc.rules[i], i));
        }
    }

    // Secrets
    if (doc.secrets !== undefined) {
        if (!Array.isArray(doc.secrets)) {
            errors.push({ field: 'secrets', message: 'secrets must be an array' });
        } else {
            for (let i = 0; i < doc.secrets.length; i++) {
                errors.push(...validateSecret(doc.secrets[i], i));
            }
        }
    }

    // Containers (optional)
    if (doc.containers !== undefined) {
        if (!Array.isArray(doc.containers)) {
            errors.push({ field: 'containers', message: 'containers must be an array' });
        } else {
            for (let i = 0; i < doc.containers.length; i++) {
                errors.push(...validateContainerConfig(doc.containers[i], i));
            }
        }
    }

    if (errors.length > 0) {
        return { ok: false, errors };
    }

    return {
        ok: true,
        config: {
            version: doc.version as string,
            presets: doc.presets as PresetName[] | undefined,
            rules: doc.rules as EgressRule[],
            secrets: doc.secrets as SecretDeclaration[] | undefined,
            containers: doc.containers as ContainerConfig[] | undefined,
        },
    };
}

/** Resolve presets in a config, expanding them into additional rules */
export function resolveConfig(config: EgressorConfig): ResolvedConfig {
    const presetRules: EgressRule[] = [];

    if (config.presets) {
        for (const preset of config.presets) {
            const rules = PRESET_RULES[preset];
            if (rules) {
                presetRules.push(...rules);
            }
        }
    }

    // Merge preset rules with explicit rules, deduplicating by host
    const seenHosts = new Set<string>();
    const mergedRules: EgressRule[] = [];

    // Explicit rules take priority
    for (const rule of config.rules) {
        seenHosts.add(rule.host);
        mergedRules.push(rule);
    }

    // Add preset rules that aren't already covered
    for (const rule of presetRules) {
        if (!seenHosts.has(rule.host)) {
            seenHosts.add(rule.host);
            mergedRules.push(rule);
        }
    }

    // Resolve per-container configs
    const resolvedContainers: ResolvedContainerConfig[] = [];
    if (config.containers) {
        for (const container of config.containers) {
            let containerRules: EgressRule[];
            if (container.egress === true) {
                containerRules = mergedRules;
            } else if (Array.isArray(container.egress)) {
                containerRules = container.egress;
            } else {
                containerRules = [];
            }

            let containerSecrets: SecretDeclaration[];
            if (container.secrets === true) {
                containerSecrets = config.secrets ?? [];
            } else if (Array.isArray(container.secrets)) {
                containerSecrets = container.secrets;
            } else {
                containerSecrets = [];
            }

            resolvedContainers.push({
                name: container.name,
                match: container.match,
                rules: containerRules,
                secrets: containerSecrets,
            });
        }
    }

    return {
        version: config.version,
        rules: mergedRules,
        secrets: config.secrets ?? [],
        containers: resolvedContainers,
    };
}

/** Get the rules for a given preset name */
export function getPresetRules(preset: PresetName): EgressRule[] {
    return PRESET_RULES[preset] ?? [];
}
