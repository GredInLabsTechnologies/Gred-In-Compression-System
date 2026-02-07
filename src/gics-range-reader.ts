/**
 * GICS Range Reader - HTTP Range Request Support for Partial Downloads
 * 
 * @module gics
 * @version 1.1.0
 * @status FROZEN - Canonical implementation
 * @see docs/GICS_V1.1_SPEC.md
 * 
 * Enables efficient partial file downloads using HTTP Range Requests.
 * Client can download only the index (~4KB) and specific blocks (~50KB each)
 * instead of the entire file (~2MB+).
 * 
 * @author GICS Team
 */

import { CompressionAlgorithm } from './gics-types.js';

// ============================================================================
// Types
// ============================================================================

interface TemporalIndexEntry {
    blockId: number;
    startTimestamp: number;
    offset: number;
}

interface RangeReaderConfig {
    /** Fetch implementation (defaults to global fetch) */
    fetch?: typeof fetch;
    /** Size of footer to fetch for index discovery (default: 4096) */
    footerSize?: number;
}

// ============================================================================
// Constants
// ============================================================================

const MAGIC = new Uint8Array([0x47, 0x49, 0x43, 0x53]); // GICS
const DEFAULT_FOOTER_SIZE = 4096;
const HEADER_SIZE = 36; // Minimum header size

// ============================================================================
// GICSRangeReader
// ============================================================================

/**
 * HTTP Range-based GICS reader for efficient partial downloads.
 * 
 * Usage:
 * ```typescript
 * const reader = new GICSRangeReader('https://storage.example.com/source_1403_active.gics');
 * 
 * // 1. Fetch just the header to get file layout
 * const header = await reader.fetchHeader();
 * 
 * // 2. Fetch the temporal index
 * const index = await reader.fetchTemporalIndex(header);
 * 
 * // 3. Find the block containing target timestamp
 * const blockId = reader.findBlockForTimestamp(index, targetTimestamp);
 * 
 * // 4. Fetch only that block
 * const blockData = await reader.fetchBlock(blockId, index);
 * ```
 */
export class GICSRangeReader {
    private readonly url: string;
    private readonly config: Required<RangeReaderConfig>;
    private cachedFileSize?: number;

    constructor(url: string, config: RangeReaderConfig = {}) {
        this.url = url;
        this.config = {
            fetch: config.fetch ?? globalThis.fetch.bind(globalThis),
            footerSize: config.footerSize ?? DEFAULT_FOOTER_SIZE
        };
    }

    /**
     * Fetch the file header (first 36+ bytes)
     * Contains: magic, version, flags, block count, item count, offsets
     */
    async fetchHeader(): Promise<{
        version: number;
        compressionAlgorithm: CompressionAlgorithm;
        blockCount: number;
        itemCount: number;
        temporalIndexOffset: number;
        itemIndexOffset: number;
        dataOffset: number;
        fileSize: number;
    }> {
        // Fetch header + potential encryption extensions
        const response = await this.config.fetch(this.url, {
            headers: { 'Range': `bytes=0-${HEADER_SIZE + 64 - 1}` }
        });

        if (!response.ok && response.status !== 206) {
            throw new Error(`Failed to fetch header: ${response.status} ${response.statusText}`);
        }

        const buffer = new Uint8Array(await response.arrayBuffer());
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

        // Validate magic bytes
        if (buffer[0] !== MAGIC[0] || buffer[1] !== MAGIC[1] ||
            buffer[2] !== MAGIC[2] || buffer[3] !== MAGIC[3]) {
            throw new Error('Invalid GICS magic bytes');
        }

        let offset = 4;
        const version = buffer[offset++];
        const compressionAlgorithm = buffer[offset++] as CompressionAlgorithm;
        const blockCount = view.getUint16(offset, true); offset += 2;
        const itemCount = view.getUint32(offset, true); offset += 4;

        const temporalIndexOffset = view.getUint32(offset, true); offset += 8; // skip high bits
        const itemIndexOffset = view.getUint32(offset, true); offset += 8;
        const dataOffset = view.getUint32(offset, true);

        // Get file size from Content-Range header
        const contentRange = response.headers.get('Content-Range');
        let fileSize = 0;
        if (contentRange) {
            const match = /\/(\d+)/.exec(contentRange);
            if (match) {
                fileSize = Number.parseInt(match[1], 10);
                this.cachedFileSize = fileSize;
            }
        }

        return {
            version,
            compressionAlgorithm,
            blockCount,
            itemCount,
            temporalIndexOffset,
            itemIndexOffset,
            dataOffset,
            fileSize
        };
    }

    /**
     * Fetch only the temporal index section
     * @param header Previously fetched header info
     */
    async fetchTemporalIndex(header: {
        temporalIndexOffset: number;
        itemIndexOffset: number;
        blockCount: number;
    }): Promise<TemporalIndexEntry[]> {
        const indexSize = header.itemIndexOffset - header.temporalIndexOffset;

        const response = await this.config.fetch(this.url, {
            headers: {
                'Range': `bytes=${header.temporalIndexOffset}-${header.temporalIndexOffset + indexSize - 1}`
            }
        });

        if (!response.ok && response.status !== 206) {
            throw new Error(`Failed to fetch temporal index: ${response.status}`);
        }

        const buffer = new Uint8Array(await response.arrayBuffer());
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

        const entries: TemporalIndexEntry[] = [];
        const entrySize = 10; // blockId(2) + timestamp(4) + offset(4)

        for (let i = 0; i < header.blockCount && i * entrySize < buffer.length; i++) {
            const offset = i * entrySize;
            entries.push({
                blockId: view.getUint16(offset, true),
                startTimestamp: view.getUint32(offset + 2, true),
                offset: view.getUint32(offset + 6, true)
            });
        }

        return entries;
    }

    /**
     * Find the block ID that contains a given timestamp
     */
    findBlockForTimestamp(index: TemporalIndexEntry[], timestamp: number): number | null {
        if (index.length === 0) return null;

        // Binary search for the right block
        let left = 0;
        let right = index.length - 1;

        while (left < right) {
            const mid = Math.floor((left + right + 1) / 2);
            if (index[mid].startTimestamp <= timestamp) {
                left = mid;
            } else {
                right = mid - 1;
            }
        }

        return index[left].blockId;
    }

    /**
     * Fetch a specific block by ID
     * @param blockId Block ID to fetch
     * @param index Temporal index for offset lookup
     * @param header Header info for data offset
     */
    async fetchBlock(
        blockId: number,
        index: TemporalIndexEntry[],
        header: { dataOffset: number }
    ): Promise<Uint8Array> {
        const blockMeta = index.find(e => e.blockId === blockId);
        if (!blockMeta) {
            throw new Error(`Block ${blockId} not found in index`);
        }

        // Find next block offset to determine size (or use file end)
        const nextBlock = index.find(e => e.blockId === blockId + 1);
        let blockSize: number;

        if (nextBlock) {
            blockSize = nextBlock.offset - blockMeta.offset;
        } else {
            // Last block - fetch header to get size, or use estimated size
            // For simplicity, fetch 1MB max (should be more than enough)
            blockSize = 1024 * 1024;
        }

        const start = header.dataOffset + blockMeta.offset;
        const end = start + blockSize - 1;

        const response = await this.config.fetch(this.url, {
            headers: { 'Range': `bytes=${start}-${end}` }
        });

        if (!response.ok && response.status !== 206) {
            throw new Error(`Failed to fetch block ${blockId}: ${response.status}`);
        }

        return new Uint8Array(await response.arrayBuffer());
    }

    /**
     * Get estimated download savings compared to full file download
     */
    getDownloadStats(
        fullFileSize: number,
        blocksDownloaded: number,
        avgBlockSize: number = 50 * 1024
    ): {
        fullDownload: number;
        partialDownload: number;
        savings: number;
        savingsPercent: number;
    } {
        const headerSize = HEADER_SIZE + 64;
        const indexSize = blocksDownloaded * 10 + 1024; // Approximate
        const partialDownload = headerSize + indexSize + (blocksDownloaded * avgBlockSize);

        return {
            fullDownload: fullFileSize,
            partialDownload,
            savings: fullFileSize - partialDownload,
            savingsPercent: Math.round((1 - partialDownload / fullFileSize) * 100)
        };
    }
}

/**
 * Factory function for convenience
 */
export function createRangeReader(url: string, config?: RangeReaderConfig): GICSRangeReader {
    return new GICSRangeReader(url, config);
}
