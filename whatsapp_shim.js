import { webcrypto } from 'node:crypto';

// Provide globalThis.crypto for Baileys and other modern JS libs in Node environments
if (!globalThis.crypto) {
    Object.defineProperty(globalThis, 'crypto', {
        value: webcrypto,
        writable: false,
        configurable: true
    });
}
