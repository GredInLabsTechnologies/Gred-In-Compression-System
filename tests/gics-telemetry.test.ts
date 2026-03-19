import { GICSv2Encoder } from '../src/gics/encode.js';
import { GICSv2Decoder } from '../src/gics/decode.js';
import { TelemetryCollector } from '../src/telemetry/collector.js';

function metricNames(snapshot: ReturnType<TelemetryCollector['snapshot']>): string[] {
    return snapshot.metrics.map((metric) => metric.name);
}

describe('GICS telemetry contract', () => {
    it('emits core/query/verify telemetry through a shared collector', async () => {
        const telemetry = new TelemetryCollector();
        const schema = {
            id: 'telemetry_schema',
            version: 1,
            itemIdType: 'string' as const,
            fields: [
                { name: 'value', type: 'numeric' as const, codecStrategy: 'value' as const },
            ],
        };

        const encoder = new GICSv2Encoder({ schema, telemetry });
        await encoder.addSnapshot({
            timestamp: 1000,
            items: new Map([
                ['alpha', { value: 10 }],
                ['beta', { value: 20 }],
            ]),
        });
        await encoder.addSnapshot({
            timestamp: 2000,
            items: new Map([
                ['alpha', { value: 11 }],
                ['beta', { value: 22 }],
            ]),
        });

        const packed = await encoder.finish();
        const decoder = new GICSv2Decoder(packed, { telemetry });

        const queried = await decoder.queryGeneric('alpha');
        expect(queried.length).toBeGreaterThan(0);

        const verified = await decoder.verifyIntegrityOnly();
        expect(verified).toBe(true);

        const names = metricNames(telemetry.snapshot());
        expect(names).toContain('gics_codec_selection_total');
        expect(names).toContain('gics_compression_ratio');
        expect(names).toContain('gics_query_total');
        expect(names).toContain('gics_query_segments_considered_total');
        expect(names).toContain('gics_verify_total');
    });
});
