const getPollFromMessage = (msg = {}) =>
	msg.pollCreationMessage ||
	msg.pollCreationMessageV2 ||
	msg.pollCreationMessageV3 ||
	msg.pollCreationMessageV4;

const getPollOptions = (poll) =>
	Array.isArray(poll?.options)
		? poll.options.map((opt) => opt?.optionName || "Option")
		: [];

const getPollEncKey = (pollMessage = {}) => {
	const poll = getPollFromMessage(pollMessage.message || pollMessage);
	const contexts = [
		poll?.contextInfo?.messageSecret,
		pollMessage.message?.contextInfo?.messageSecret,
		pollMessage.message?.messageContextInfo?.messageSecret,
		pollMessage.messageContextInfo?.messageSecret,
		poll?.encKey,
	];
	return contexts.find(Boolean) || null;
};

export { getPollEncKey, getPollOptions };
