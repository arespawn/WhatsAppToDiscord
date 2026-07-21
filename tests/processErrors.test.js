import assert from "node:assert/strict";
import test from "node:test";

import {
	isRecoverableUndiciError,
	shouldIgnoreProcessError,
} from "../src/processErrors.js";

test("classifies undici terminated socket close as recoverable", () => {
	const socketError = new Error("other side closed");
	socketError.code = "UND_ERR_SOCKET";

	const reason = new TypeError("terminated");
	reason.cause = socketError;
	reason.stack =
		"TypeError: terminated\n    at Fetch.onAborted (node:internal/deps/undici/undici:12707:53)";

	assert.equal(isRecoverableUndiciError(reason), true);
	assert.equal(shouldIgnoreProcessError("unhandledRejection", reason), true);
	assert.equal(shouldIgnoreProcessError("uncaughtException", reason), true);
	assert.equal(shouldIgnoreProcessError("SIGTERM", reason), false);
});

test("classifies undici TLS fetch failures as recoverable", () => {
	const tlsError = new Error("tlsv1 alert internal error");
	tlsError.code = "ECONNRESET";

	const reason = new TypeError("fetch failed");
	reason.cause = tlsError;
	reason.stack =
		"TypeError: fetch failed\n    at node:internal/deps/undici/undici:16416:13";

	assert.equal(isRecoverableUndiciError(reason), true);
});

test("does not classify application errors named terminated as recoverable", () => {
	const reason = new TypeError("terminated");
	reason.stack =
		"TypeError: terminated\n    at file:///app/src/handler.js:10:5";

	assert.equal(isRecoverableUndiciError(reason), false);
	assert.equal(shouldIgnoreProcessError("uncaughtException", reason), false);
});

test("does not classify generic coding errors as recoverable", () => {
	const reason = new TypeError(
		"Cannot read properties of undefined (reading 'x')",
	);
	reason.stack =
		"TypeError: Cannot read properties of undefined (reading 'x')\n    at file:///app/src/handler.js:10:5";

	assert.equal(isRecoverableUndiciError(reason), false);
});
