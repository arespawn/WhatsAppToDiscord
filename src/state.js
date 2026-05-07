import { ONE_WAY_MODES } from "./oneWay.js";

const state = {
	settings: {
		Whitelist: [],
		DiscordPrefixText: null,
		DiscordPrefix: false,
		WAGroupPrefix: false,
		WASenderPlatformSuffix: false,
		DiscordEmbedsToWhatsApp: false,
		UploadAttachments: true,
		NewsletterMediaUrlFallback: false,
		Token: "",
		GuildID: "",
		Categories: [],
		ControlChannelID: "",
		LocalDownloads: false,
		LocalDownloadMessage:
			"Downloaded a file larger than the upload limit, check it out at {url}",
		DownloadDir: "./downloads",
		DownloadDirLimitGB: 0,
		DownloadDirMaxAgeDays: 0,
		DownloadDirMinFreeGB: 0,
		DiscordFileSizeLimit: 8 * 1024 * 1024,
		WhatsAppDiscordMediaBurstSize: 10,
		LocalDownloadServer: false,
		LocalDownloadServerHost: "localhost",
		LocalDownloadServerBindHost: "127.0.0.1",
		LocalDownloadServerPort: 8080,
		LocalDownloadServerSecret: "",
		LocalDownloadLinkTTLSeconds: 0,
		UseHttps: false,
		HttpsKeyPath: "",
		HttpsCertPath: "",
		Publish: false,
		ChangeNotifications: false,
		MirrorWAStatuses: true,
		autoSaveInterval: 5 * 60,
		lastMessageStorage: 500,
		oneWay: ONE_WAY_MODES.TWO_WAY,
		redirectBots: true,
		redirectWebhooks: false,
		redirectAnnouncementWebhooks: false,
		DeleteMessages: true,
		ReadReceipts: true,
		ReadReceiptMode: "public",
		UpdateChannel: "stable",
		KeepOldBinary: true,
		UpdatePromptMessage: null,
		RollbackPromptMessage: null,
		PinDurationSeconds: 7 * 24 * 60 * 60,
		DefaultChatType: "channel",
		DefaultThreadHostName: "",
		ThreadNotificationsEnabled: false,
		ThreadNotificationRoles: [],
		ThreadNotificationUsers: [],
		WhatsAppDiscordMentionLinks: {},
		HidePhoneNumbers: false,
		PrivacySalt: "",
	},
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
