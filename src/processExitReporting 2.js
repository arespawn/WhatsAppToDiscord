const SHUTDOWN_EVENTS = new Set(["SIGINT", "SIGTERM"]);

export const isShutdownEvent = (eventName) => SHUTDOWN_EVENTS.has(eventName);

export const getProcessExitCode = (eventName) =>
	isShutdownEvent(eventName) ? 0 : 1;

export const getProcessReportFileName = (eventName) =>
	isShutdownEvent(eventName) ? "shutdown.txt" : "crash.txt";

const formatReason = (reason, fallback) => reason?.stack || reason || fallback;

export const buildProcessExitReportContent = ({
	eventName,
	reason,
	logs = "",
} = {}) => {
	const isShutdown = isShutdownEvent(eventName);
	const title = isShutdown ? "Bot shutting down" : "Bot crashed";
	const detail = formatReason(reason, eventName || "unknown");
	return (
		`${title}: \n\n\u0060\u0060\u0060\n${detail}\n\u0060\u0060\u0060` +
		(logs
			? `\nRecent logs:\n\u0060\u0060\u0060\n${logs}\n\u0060\u0060\u0060`
			: "")
	);
};
