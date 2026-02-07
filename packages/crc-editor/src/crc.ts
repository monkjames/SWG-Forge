/**
 * SWG CRC-32 Implementation
 *
 * SWG uses the MPEG-2 CRC-32 algorithm with polynomial 0x04C11DB7
 * This is a "normal" (non-reflected) CRC-32:
 * - Polynomial: 0x04C11DB7
 * - Initial value: 0xFFFFFFFF
 * - Final XOR: 0xFFFFFFFF
 * - Input/output NOT reflected
 *
 * The path is converted to lowercase before calculating the CRC.
 */

/**
 * Calculate SWG CRC-32 for a string
 */
export function calculateCRC(input: string): number {
    // SWG lowercases paths for CRC calculation
    const normalized = input.toLowerCase();

    let crc = 0xFFFFFFFF;

    for (let i = 0; i < normalized.length; i++) {
        const byte = normalized.charCodeAt(i) & 0xFF;
        crc ^= (byte << 24);

        for (let j = 0; j < 8; j++) {
            if (crc & 0x80000000) {
                crc = ((crc << 1) ^ 0x04C11DB7) >>> 0;
            } else {
                crc = (crc << 1) >>> 0;
            }
        }
    }

    return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Format CRC as hex string (8 characters, uppercase)
 */
export function formatCRC(crc: number): string {
    return crc.toString(16).toUpperCase().padStart(8, '0');
}

/**
 * Parse CRC from hex string
 */
export function parseCRC(hex: string): number {
    return parseInt(hex, 16) >>> 0;
}
