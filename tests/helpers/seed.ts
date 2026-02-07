import { HybridWriter } from '../../src/gics-hybrid.js';
import * as path from 'node:path';
import * as fs from 'node:fs';

export const SeedKit = {
    /**
     * Generate deterministic items
     */
    generateMockItems(count: number, startId = 1000) {
        return Array.from({ length: count }, (_, i) => ({
            id: startId + i,
            name: `Mock Item ${startId + i}`,
            quality: 'COMMON'
        }));
    },

    /**
     * Generate deterministic history
     */
    generateMockHistory(itemId: number, days = 7) {
        const now = Math.floor(Date.now() / 1000);
        return Array.from({ length: days }, (_, i) => ({
            timestamp: now - (i * 86400),
            price: 10000 + (Math.sin(i) * 1000),
            quantity: 100 + i
        }));
    },

    /**
     * Create a valid .gics file in the specified directory
     * @param timestamp Optional timestamp for strictly deterministic output
     */
    async createGICSFile(dir: string, sourceId: number, items: Array<{ id: number, price: number }>, timestamp: number = Math.floor(Date.now() / 1000)) {
        const writer = new HybridWriter();

        // Convert input array to Map as required by HybridWriter
        const itemsMap = new Map<number, { price: number, quantity: number }>();
        items.forEach(i => {
            itemsMap.set(i.id, { price: i.price, quantity: 100 });
        });

        await writer.addSnapshot({
            timestamp,
            items: itemsMap
        });

        const buffer = await writer.finish();

        // Format filename using the provided timestamp
        const dateStr = new Date(timestamp * 1000).toISOString().slice(0, 7);
        const filename = `source_${sourceId}_${dateStr}.gics`;
        const fullPath = path.join(dir, filename);

        // Ensure directory exists
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(fullPath, buffer);
        console.log(`[SeedKit] Created deterministic GICS file: ${fullPath}`);
        return fullPath;
    }
};
