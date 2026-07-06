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
export const dcClient = () => state.dcClient;
export const waClient = () => state.waClient;
export const chats = state.chats;
export const contacts = state.contacts;
export const startTime = () => state.startTime;
export const logger = () => state.logger;
export const lastMessages = () => state.lastMessages;
export const sentMessages = state.sentMessages;
export const reactions = state.reactions;
export const sentReactions = state.sentReactions;
export const sentPins = state.sentPins;
export const goccRuns = state.goccRuns;
export const updateInfo = () => state.updateInfo;
export const version = () => state.version;

export default state;
