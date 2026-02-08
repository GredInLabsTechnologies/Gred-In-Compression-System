
import { HybridReader, HybridWriter } from './src/gics-hybrid.js';

async function test() {
    try {
        console.log("Starting test...");
        const writer = new HybridWriter();
        const items = new Map();
        for (let j = 0; j < 100; j++) items.set(j, { price: 1000 + j, quantity: 50 });
        writer.addSnapshot({ timestamp: Date.now(), items });
        console.log("Snapshot added");
        const data = await writer.finish();
        console.log("Finish called, data length:", data.length);
        const reader = new HybridReader(data);
        console.log("Reader created");
        const snapshot = await reader.getSnapshotAt(1000);
        console.log("Snapshot retrieved:", snapshot ? "Yes" : "No");
        if (snapshot) {
            console.log("Timestamp:", snapshot.timestamp);
            console.log("Price:", snapshot.items.get(1)?.price);
        }
    } catch (e) {
        console.error("FAILED:", e);
    }
}

test();
