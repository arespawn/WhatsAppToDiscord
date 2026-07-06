const normalizeDiscordId = (value) => {
	if (value == null) return null;
	const trimmed = String(value).trim();
	return /^\d+$/.test(trimmed) ? trimmed : null;
};

const uniqueDiscordIds = (value) =>
	Array.isArray(value)
		? [...new Set(value.map(normalizeDiscordId).filter(Boolean))]
		: [];

const normalizeStringArray = (value) =>
	Array.isArray(value)
		? [...new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean))]
		: [];

const ONE_WAY_MODES = Object.freeze({
	TWO_WAY: "bidirectional",
	TO_DISCORD_ONLY: "to-discord",
	TO_WHATSAPP_ONLY: "to-whatsapp",
});

const VALID_ONE_WAY_MODES = new Set(Object.values(ONE_WAY_MODES));

const normalizeOneWayMode = (value) =>
	VALID_ONE_WAY_MODES.has(value) ? value : ONE_WAY_MODES.TWO_WAY;

const oneWayAllowsWhatsAppToDiscord = (mode) =>
	normalizeOneWayMode(mode) !== ONE_WAY_MODES.TO_WHATSAPP_ONLY;

const oneWayAllowsDiscordToWhatsApp = (mode) =>
	normalizeOneWayMode(mode) !== ONE_WAY_MODES.TO_DISCORD_ONLY;

const createDefaultSettings = () => ({
	Whitelist: [],
	DiscordPrefixText: null,
	DiscordPrefix: false,
	WAGroupPrefix: false,
	WASenderPlatformSuffix: false,
	WhatsAppAudioConversionFormat: "original",
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
});

const SETTINGS_KEYS = new Set(Object.keys(createDefaultSettings()));

const normalizeSettings = (raw = {}, { logger = null } = {}) => {
	const defaults = createDefaultSettings();
	const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const settings = { ...defaults };

	for (const [key, value] of Object.entries(source)) {
		if (SETTINGS_KEYS.has(key)) {
			settings[key] = value;
			continue;
		}
		logger?.warn?.({ key }, "Ignoring unsupported persisted setting");
	}

	settings.DefaultChatType =
		settings.DefaultChatType === "thread" ? "thread" : "channel";
	settings.DefaultThreadHostName =
		typeof settings.DefaultThreadHostName === "string"
			? settings.DefaultThreadHostName.trim()
			: "";
	settings.ThreadNotificationsEnabled = Boolean(
		settings.ThreadNotificationsEnabled,
	);
	settings.ThreadNotificationRoles = uniqueDiscordIds(
		settings.ThreadNotificationRoles,
	);
	settings.ThreadNotificationUsers = uniqueDiscordIds(
		settings.ThreadNotificationUsers,
	);
	settings.WhatsAppAudioConversionFormat =
		settings.WhatsAppAudioConversionFormat === "mp3" ? "mp3" : "original";
	settings.Categories = uniqueDiscordIds(settings.Categories);
	settings.Whitelist = normalizeStringArray(settings.Whitelist);
	settings.oneWay = normalizeOneWayMode(settings.oneWay);
	settings.ReadReceiptMode = ["public", "dm", "reaction"].includes(
		settings.ReadReceiptMode,
	)
		? settings.ReadReceiptMode
		: defaults.ReadReceiptMode;
	settings.UpdateChannel =
		settings.UpdateChannel === "unstable" ? "unstable" : "stable";

	return settings;
};

const DISCORD_BOT_PERMISSIONS = 536879120;

const WHATSAPP_BROWSER_PROFILE_ENV = "WA2DC_WHATSAPP_BROWSER";
const WHATSAPP_BROWSER_PROFILES = Object.freeze({
	ANDROID: "android",
	MACOS_CHROME: "macos-chrome",
	WINDOWS_CHROME: "windows-chrome",
	UBUNTU_CHROME: "ubuntu-chrome",
	BAILEYS: "baileys",
});

const NEWSLETTER_SERVER_ID_WAIT_TIMEOUT_MS = 8000;
const NEWSLETTER_SERVER_ID_WAIT_POLL_MS = 150;
const NEWSLETTER_ACK_WAIT_WITH_SERVER_ID_MS = 2500;
const NEWSLETTER_ACK_WAIT_WITHOUT_SERVER_ID_MS = 8000;

export {
	createDefaultSettings,
	DISCORD_BOT_PERMISSIONS,
	NEWSLETTER_ACK_WAIT_WITHOUT_SERVER_ID_MS,
	NEWSLETTER_ACK_WAIT_WITH_SERVER_ID_MS,
	NEWSLETTER_SERVER_ID_WAIT_POLL_MS,
	NEWSLETTER_SERVER_ID_WAIT_TIMEOUT_MS,
	normalizeOneWayMode,
	normalizeSettings,
	ONE_WAY_MODES,
	oneWayAllowsDiscordToWhatsApp,
	oneWayAllowsWhatsAppToDiscord,
	WHATSAPP_BROWSER_PROFILE_ENV,
	WHATSAPP_BROWSER_PROFILES,
};
