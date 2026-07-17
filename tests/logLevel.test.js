import assert from "node:assert/strict";
import test from "node:test";

import { resolveLogLevel } from "../src/logLevel.js";

test("resolveLogLevel returns info when WA2DC_LOG_LEVEL is unset", () => {
	const original = process.env.WA2DC_LOG_LEVEL;
	delete process.env.WA2DC_LOG_LEVEL;
	try {
		assert.equal(resolveLogLevel(), "info");
	} finally {
		if (original === undefined) {
			delete process.env.WA2DC_LOG_LEVEL;
		} else {
			process.env.WA2DC_LOG_LEVEL = original;
		}
	}
});

test("resolveLogLevel returns the value of WA2DC_LOG_LEVEL when set", () => {
	const original = process.env.WA2DC_LOG_LEVEL;
	process.env.WA2DC_LOG_LEVEL = "debug";
	try {
		assert.equal(resolveLogLevel(), "debug");
	} finally {
		if (original === undefined) {
			delete process.env.WA2DC_LOG_LEVEL;
		} else {
			process.env.WA2DC_LOG_LEVEL = original;
		}
	}
});
