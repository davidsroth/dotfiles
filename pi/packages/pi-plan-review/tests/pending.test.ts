import { describe, expect, it } from "vitest";
import {
	createPendingReview,
	parsePendingReview,
	retryPendingReview,
	reviewFingerprint,
} from "../extensions/_review/pending";

describe("pending review identity", () => {
	it("fingerprints kind and exact input deterministically", () => {
		expect(reviewFingerprint("plan", "same")).toBe(reviewFingerprint("plan", "same"));
		expect(reviewFingerprint("plan", "same")).not.toBe(reviewFingerprint("draft", "same"));
		expect(reviewFingerprint("draft", "same")).not.toBe(reviewFingerprint("draft", "changed"));
	});

	it("keeps one review ID across retries", () => {
		const original = createPendingReview("plan", "fingerprint");
		const retried = retryPendingReview(original);
		expect(retried.reviewId).toBe(original.reviewId);
		expect(retried.fingerprint).toBe(original.fingerprint);
		expect(retried.attempts).toBe(2);
	});

	it("fails closed when durable state is malformed", () => {
		expect(parsePendingReview(null)).toBeNull();
		expect(parsePendingReview({ version: 1, reviewId: "x" })).toBeNull();
		expect(parsePendingReview({
			version: 1,
			reviewId: "plan-id",
			fingerprint: "hash",
			createdAt: "now",
			lastAttemptAt: "now",
			attempts: 1,
		})).toMatchObject({ reviewId: "plan-id", attempts: 1 });
	});
});
