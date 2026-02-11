export class FieldMath {
    /**
     * Compute delta-of-deltas for timestamps
     */
    static computeTimeDeltas(timestamps: number[], lastTimestamp: number, lastTimestampDelta: number): { deltas: number[], nextTimestamp: number, nextTimestampDelta: number } {
        const deltas: number[] = [];
        let prev = lastTimestamp;
        let prevDelta = lastTimestampDelta;

        for (const current of timestamps) {
            const currentDelta = current - prev;
            const deltaOfDelta = currentDelta - prevDelta;
            deltas.push(deltaOfDelta);
            prev = current;
            prevDelta = currentDelta;
        }

        return { deltas, nextTimestamp: prev, nextTimestampDelta: prevDelta };
    }

    /**
     * Decode delta-of-deltas for timestamps
     */
    static decodeTimeStream(deltas: number[], lastTimestamp: number, lastTimestampDelta: number): { timestamps: number[], nextTimestamp: number, nextTimestampDelta: number } {
        const timestamps: number[] = [];
        let prev = lastTimestamp;
        let prevDelta = lastTimestampDelta;

        for (const deltaOfDelta of deltas) {
            const currentDelta = prevDelta + deltaOfDelta;
            const current = prev + currentDelta;
            timestamps.push(current);
            prev = current;
            prevDelta = currentDelta;
        }

        return { timestamps, nextTimestamp: prev, nextTimestampDelta: prevDelta };
    }

    /**
     * Compute deltas for values (prices)
     */
    static computeValueDeltas(values: number[], lastValue: number): { deltas: number[], nextValue: number } {
        const deltas: number[] = [];
        let prev = lastValue;

        for (const current of values) {
            const diff = current - prev;
            deltas.push(diff);
            prev = current;
        }

        return { deltas, nextValue: prev };
    }

    /**
     * Decode deltas for values (prices)
     */
    static decodeValueStream(deltas: number[], lastValue: number, lastValueDelta: number, isDOD: boolean): { values: number[], nextValue: number, nextValueDelta: number } {
        const values: number[] = [];
        let prev = lastValue;
        let prevDelta = lastValueDelta;

        for (const rawChange of deltas) {
            let change = rawChange;
            if (isDOD) {
                const currentDelta = prevDelta + change;
                change = currentDelta;
                prevDelta = currentDelta;
            } else {
                prevDelta = change;
            }
            const current = prev + change;
            values.push(current);
            prev = current;
        }

        return { values, nextValue: prev, nextValueDelta: prevDelta };
    }
}
