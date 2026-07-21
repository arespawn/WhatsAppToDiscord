const MAX_ERROR_CAUSE_DEPTH = 6;
const RECOVERABLE_PROCESS_EVENTS = new Set([
	"uncaughtException",
	"unhandledRejection",
]);
const RECOVERABLE_NETWORK_MESSAGE_HINTS = [
	"terminated",
	"fetch failed",
	"other side closed",
	"socket",
	"tls",
	"ssl",
	"timed out",
	"timeout",
	"econnreset",
	"enotfound",
	"ehostunreach",
	"eai_again",
	"certificate",
];
const RECOVERABLE_NETWORK_CODE_HINTS = [
	"UND_ERR",
	"ECONNRESET",
	"ENOTFOUND",
	"EHOSTUNREACH",
	"ETIMEDOUT",
	"EAI_AGAIN",
	"CERT_",
];

const asLower = (value) => String(value || "").toLowerCase();

const collectErrorChain = (reason) => {
	const chain = [];
	let current = reason;
	for (let i = 0; i < MAX_ERROR_CAUSE_DEPTH && current; i += 1) {
		if (chain.includes(current)) {
			break;
		}
		chain.push(current);
		current = current?.cause;
	}
	return chain;
};

const includesHint = (text, hints) =>
	hints.some((hint) => text.includes(asLower(hint)));

export const isRecoverableUndiciError = (reason) => {
	const chain = collectErrorChain(reason);
	if (!chain.length) {
		return false;
	}

	const messageText = asLower(
		chain.map((entry) => entry?.message || entry).join(" | "),
	);
	const codeText = asLower(chain.map((entry) => entry?.code || "").join(" | "));
	const stackText = asLower(
		chain.map((entry) => entry?.stack || "").join("\n"),
	);

	const looksLikeUndici =
		stackText.includes("node:internal/deps/undici/undici") ||
		stackText.includes("/undici/") ||
		codeText.includes("und_err");
	if (!looksLikeUndici) {
		return false;
	}

	return (
		includesHint(messageText, RECOVERABLE_NETWORK_MESSAGE_HINTS) ||
		includesHint(codeText, RECOVERABLE_NETWORK_CODE_HINTS)
	);
};

export const shouldIgnoreProcessError = (eventName, reason) =>
	RECOVERABLE_PROCESS_EVENTS.has(eventName) && isRecoverableUndiciError(reason);
