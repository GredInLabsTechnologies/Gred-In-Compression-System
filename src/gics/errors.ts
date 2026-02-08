export class GicsError extends Error {
    constructor(message: string, public originalError?: any) {
        super(message);
        this.name = 'GicsError';
    }
}

export class IntegrityError extends GicsError {
    constructor(message: string) {
        super(message);
        this.name = 'IntegrityError';
    }
}

export class IncompleteDataError extends GicsError {
    constructor(message: string) {
        super(message);
        this.name = 'IncompleteDataError';
    }
}

export class LimitExceededError extends GicsError {
    constructor(message: string) {
        super(message);
        this.name = 'LimitExceededError';
    }
}
