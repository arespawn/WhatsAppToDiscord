import { createDefaultSettings } from "./contracts.js";

const state = {
	settings: createDefaultSettings(),
	dcClient: null,
	waClient: null,
	waConnection: {
		browserProfile: [],
		connection: null,
		hasQr: false,
		qrAt: 0,
		registered: null,
		updatedAt: 0,
	},
	chats: {},
	contacts: {},
	startTime: 0,
	logger: null,
	lastMessages: null,

	sentMessages: new Set(),

	reactions: {},

	sentReactions: new Set(),

	sentPins: new Set(),
	goccRuns: {},
	updateInfo: null,
	version: "",
	shutdownRequested: false,
};

export const settings = state.settings;
export const sentMessages = state.sentMessages;

export default state;
