
import { StreamId, InnerCodecId, HealthTag } from './format.js';
import { BlockMetrics, Regime } from './metrics.js';

export interface BlockStats {
    stream_id: StreamId;
    codec: InnerCodecId;
    bytes: number;
    raw_bytes: number;
    header_bytes: number;
    payload_bytes: number;
    params: {
        decision: string;
        reason: string | null;
    };
    flags: number;
    health: HealthTag;
    ratio: number;
    trainBaseline: boolean;
    metrics: BlockMetrics;
    regime: Regime;
}
