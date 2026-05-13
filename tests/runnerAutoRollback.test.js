import assert from "node:assert/strict";
import test from "node:test";

import {
	createUpdateValidationState,
	evaluateUpdateValidationExit,
} from "../src/runnerLogic.js";

test("update validation does not rollback on first crash within healthy window", () => {
	const state = createUpdateValidationState({ targetVersion: "v3.0.0" });
	const result = evaluateUpdateValidationExit({
		validationState: state,
		exitCode: 1,
		runtimeMs: 20_000,
		healthyWindowMs: 120_000,
	});

	assert.equal(result.shouldAttemptRollback, false);
	assert.equal(result.validationState.crashCount, 1);
	assert.equal(result.validationState.rollbackAttempted, false);
});

test("update validation requests rollback on second crash within healthy window", () => {
	const state = createUpdateValidationState({ targetVersion: "v3.0.0" });
	const first = evaluateUpdateValidationExit({
		validationState: state,
		exitCode: 1,
		runtimeMs: 20_000,
		healthyWindowMs: 120_000,
	});
	const second = evaluateUpdateValidationExit({
		validationState: first.validationState,
		exitCode: 1,
		runtimeMs: 30_000,
		healthyWindowMs: 120_000,
	});

	assert.equal(second.shouldAttemptRollback, true);
	assert.equal(second.validationState.crashCount, 2);
	assert.equal(second.validationState.rollbackAttempted, true);
	assert.equal(second.reason, "rollback-threshold");
});

test("update validation clears state after healthy runtime threshold", () => {
	const state = createUpdateValidationState({ targetVersion: "v3.0.0" });
	const result = evaluateUpdateValidationExit({
		validationState: state,
		exitCode: 1,
		runtimeMs: 120_000,
		healthyWindowMs: 120_000,
	});

	assert.equal(result.shouldAttemptRollback, false);
	assert.equal(result.validationState, null);
	assert.equal(result.reason, "healthy-runtime");
});

test("manual/non-update restarts never request rollback when validation is inactive", () => {
	const result = evaluateUpdateValidationExit({
		validationState: null,
		exitCode: 1,
		runtimeMs: 10_000,
		healthyWindowMs: 120_000,
	});

	assert.equal(result.shouldAttemptRollback, false);
	assert.equal(result.reason, "inactive");
});
