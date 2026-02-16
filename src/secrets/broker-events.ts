/**
 * Parse Secretless Broker log output into structured secret injection events.
 */

import { SecretType } from '../config/types';
import { SecretInjectionEvent, SecretInjectionListener } from './types';

/**
 * Pattern for Secretless Broker injection log lines.
 * Example: "INJECT bearer_token my-api-token api.example.com SUCCESS"
 * Example: "INJECT postgresql my-db db.example.com:5432 SUCCESS"
 * Example: "INJECT basic_auth my-creds api.internal.com FAILED"
 */
const INJECT_PATTERN = /^INJECT\s+(\S+)\s+(\S+)\s+(\S+)\s+(SUCCESS|FAILED)/;

/**
 * Pattern for Secretless Broker connection log lines.
 * Example: "CONNECT my-db-service postgresql db.example.com:5432"
 */
const CONNECT_PATTERN = /^CONNECT\s+(\S+)\s+(\S+)\s+(\S+)/;

/** Valid secret types for matching */
const VALID_SECRET_TYPES = new Set<string>([
    'bearer_token', 'header', 'basic_auth', 'postgresql', 'mysql', 'ssh',
]);

/**
 * Parse a single log line from Secretless Broker output.
 * Returns a SecretInjectionEvent if the line matches a known pattern, undefined otherwise.
 */
export function parseBrokerLogLine(line: string): SecretInjectionEvent | undefined {
    const trimmed = line.trim();
    if (!trimmed) {
        return undefined;
    }

    // Try INJECT pattern
    const injectMatch = trimmed.match(INJECT_PATTERN);
    if (injectMatch) {
        const typeStr = injectMatch[1];
        if (!VALID_SECRET_TYPES.has(typeStr)) {
            return undefined;
        }

        return {
            timestamp: new Date(),
            secretName: injectMatch[2],
            secretType: typeStr as SecretType,
            target: injectMatch[3],
            success: injectMatch[4] === 'SUCCESS',
            raw: trimmed,
        };
    }

    // Try CONNECT pattern (treat as successful injection event)
    const connectMatch = trimmed.match(CONNECT_PATTERN);
    if (connectMatch) {
        const typeStr = connectMatch[2];
        if (!VALID_SECRET_TYPES.has(typeStr)) {
            return undefined;
        }

        return {
            timestamp: new Date(),
            secretName: connectMatch[1],
            secretType: typeStr as SecretType,
            target: connectMatch[3],
            success: true,
            raw: trimmed,
        };
    }

    return undefined;
}

/**
 * Create a stream parser that buffers partial lines and emits events for complete lines.
 * Same pattern as the httpjail stream parser.
 */
export function createBrokerStreamParser(onEvent: SecretInjectionListener): {
    push: (chunk: string) => void;
    flush: () => void;
} {
    let buffer = '';

    return {
        push(chunk: string): void {
            buffer += chunk;
            const lines = buffer.split('\n');
            // Keep the last element (possibly incomplete line) in the buffer
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                const event = parseBrokerLogLine(line);
                if (event) {
                    onEvent(event);
                }
            }
        },

        flush(): void {
            if (buffer.trim()) {
                const event = parseBrokerLogLine(buffer);
                if (event) {
                    onEvent(event);
                }
            }
            buffer = '';
        },
    };
}
