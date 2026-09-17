import { createHash, randomUUID } from "node:crypto";

export interface PendingReview {
	version: 1;
	reviewId: string;
	fingerprint: string;
	createdAt: string;
	lastAttemptAt: string;
	attempts: number;
}

export function contentHash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function reviewFingerprint(kind: "plan" | "draft", value: string): string {
	return contentHash(`${kind}\0${value}`);
}

export function createPendingReview(kind: "plan" | "draft", fingerprint: string): PendingReview {
	const now = new Date().toISOString();
	return {
		version: 1,
		reviewId: `${kind}-${randomUUID()}`,
		fingerprint,
		createdAt: now,
		lastAttemptAt: now,
		attempts: 1,
	};
}

export function retryPendingReview(review: PendingReview): PendingReview {
	return {
		...review,
		lastAttemptAt: new Date().toISOString(),
		attempts: review.attempts + 1,
	};
}

export function parsePendingReview(raw: unknown): PendingReview | null {
	if (!raw || typeof raw !== "object") return null;
	const value = raw as Record<string, unknown>;
	if (
		value.version !== 1 ||
		typeof value.reviewId !== "string" ||
		!value.reviewId ||
		typeof value.fingerprint !== "string" ||
		!value.fingerprint ||
		typeof value.createdAt !== "string" ||
		typeof value.lastAttemptAt !== "string" ||
		typeof value.attempts !== "number" ||
		!Number.isInteger(value.attempts) ||
		value.attempts < 1
	) return null;
	return {
		version: 1,
		reviewId: value.reviewId,
		fingerprint: value.fingerprint,
		createdAt: value.createdAt,
		lastAttemptAt: value.lastAttemptAt,
		attempts: value.attempts,
	};
}
