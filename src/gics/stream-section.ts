import { StreamId, OuterCodecId, InnerCodecId } from './format.js';

export interface BlockManifestEntry {
    innerCodecId: InnerCodecId;
    nItems: number;
    payloadLen: number;
    flags: number;
}

export class StreamSection {
    private _deserializedSize: number | null = null;

    constructor(
        public readonly streamId: StreamId,
        public readonly outerCodecId: OuterCodecId,
        public readonly blockCount: number,
        public readonly uncompressedLen: number,
        public readonly compressedLen: number,
        public readonly sectionHash: Uint8Array,
        public readonly manifest: BlockManifestEntry[],
        public readonly payload: Uint8Array,
        public readonly authTag: Uint8Array | null = null
    ) { }

    static serializeManifest(manifest: BlockManifestEntry[]): Uint8Array {
        const buffer = new Uint8Array(manifest.length * 10);
        const view = new DataView(buffer.buffer);
        let offset = 0;
        for (const entry of manifest) {
            view.setUint8(offset++, entry.innerCodecId);
            view.setUint32(offset, entry.nItems, true); offset += 4;
            view.setUint32(offset, entry.payloadLen, true); offset += 4;
            view.setUint8(offset++, entry.flags);
        }
        return buffer;
    }

    /**
     * Serializes the StreamSection to bytes.
     */
    serialize(): Uint8Array {
        const manifestSize = this.manifest.length * 10;
        const tagSize = this.authTag ? 16 : 0;
        const totalSize = 1 + 1 + 2 + 4 + 4 + 32 + tagSize + manifestSize + this.payload.length;
        const buffer = new Uint8Array(totalSize);
        const view = new DataView(buffer.buffer);

        let pos = 0;
        view.setUint8(pos++, this.streamId);
        view.setUint8(pos++, this.outerCodecId);
        view.setUint16(pos, this.blockCount, true); pos += 2;
        view.setUint32(pos, this.uncompressedLen, true); pos += 4;
        view.setUint32(pos, this.compressedLen, true); pos += 4;
        buffer.set(this.sectionHash, pos); pos += 32;

        if (this.authTag) {
            buffer.set(this.authTag, pos);
            pos += 16;
        }

        for (const entry of this.manifest) {
            view.setUint8(pos++, entry.innerCodecId);
            view.setUint32(pos, entry.nItems, true); pos += 4;
            view.setUint32(pos, entry.payloadLen, true); pos += 4;
            view.setUint8(pos++, entry.flags);
        }

        buffer.set(this.payload, pos);
        return buffer;
    }

    static deserialize(data: Uint8Array, offset: number, isEncrypted: boolean = false): StreamSection {
        if (offset + 12 > data.length) throw new Error("Truncated Section Header");
        const view = new DataView(data.buffer, data.byteOffset + offset);
        let pos = 0;

        const streamId = view.getUint8(pos++);
        const outerCodecId = view.getUint8(pos++);
        const blockCount = view.getUint16(pos, true); pos += 2;
        const uncompressedLen = view.getUint32(pos, true); pos += 4;
        const compressedLen = view.getUint32(pos, true); pos += 4;

        if (offset + pos + 32 > data.length) throw new Error("Truncated Section Hash");
        const sectionHash = data.slice(offset + pos, offset + pos + 32); pos += 32;

        let authTag: Uint8Array | null = null;
        if (isEncrypted) {
            if (offset + pos + 16 > data.length) throw new Error("Truncated Section Auth Tag");
            authTag = data.slice(offset + pos, offset + pos + 16);
            pos += 16;
        }

        const manifest: BlockManifestEntry[] = [];
        for (let i = 0; i < blockCount; i++) {
            if (offset + pos + 10 > data.length) throw new Error("Truncated Section Manifest");
            const innerCodecId = view.getUint8(pos++);
            const nItems = view.getUint32(pos, true); pos += 4;
            const payloadLen = view.getUint32(pos, true); pos += 4;
            const flags = view.getUint8(pos++);
            manifest.push({ innerCodecId, nItems, payloadLen, flags });
        }

        if (offset + pos + compressedLen > data.length) throw new Error("Truncated Section Payload");
        const payload = data.slice(offset + pos, offset + pos + compressedLen);

        const section = new StreamSection(
            streamId,
            outerCodecId,
            blockCount,
            uncompressedLen,
            compressedLen,
            sectionHash,
            manifest,
            payload,
            authTag
        );
        section._deserializedSize = pos + compressedLen;
        return section;
    }

    get totalSize(): number {
        return this._deserializedSize ?? (1 + 1 + 2 + 4 + 4 + 32 + (this.authTag ? 16 : 0) + this.manifest.length * 10 + this.payload.length);
    }
}
