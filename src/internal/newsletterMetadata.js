// WhatsApp's desktop NewsletterMetadata document and wire type are a pair.
// Source: tulir/whatsmeow, argo/{name-to-queryids.json,argo-wire-type-store.argo}
// at ae388b0429be70d6eddff7ec7a3d22c296ea4416.
export const NEWSLETTER_METADATA_QUERY_ID = "9779843322044422";

const field = (name, type, { optional = false, nullable = true } = {}) => ({
	name,
	type,
	optional,
	nullable,
});
const optional = (name, type) => field(name, type, { optional: true });
const required = (name, type) => field(name, type, { nullable: false });
const text = [
	required("id", "ID"),
	field("text", "String"),
	field("update_time", "String"),
];
const picture = [
	field("id", "ID"),
	field("type", "XWA2PictureType"),
	field("url", "String"),
	field("direct_path", "String"),
];
const stringList = Symbol("string list");
const newsletter = [
	field("id", "ID"),
	optional("state", [field("type", "XWA2NewsletterStateType")]),
	field("thread_metadata", [
		optional("creation_time", "String"),
		optional("name", text),
		optional("picture", picture),
		optional("preview", picture),
		optional("description", text),
		optional("invite", "String"),
		optional("handle", "String"),
		optional("subscribers_count", "String"),
		optional("followers_count", "String"),
		optional("verification", "XWA2NewsletterVerifyState"),
		optional("verification_source", "XWA2NewsletterVerifySource"),
		optional("settings", [
			field("reaction_codes", [
				required("value", "XWA2NewsletterReactionCodesSettingValue"),
				field("blocked_codes", stringList),
				field("enabled_ts_sec", "String"),
			]),
		]),
		optional("wamo_sub", [field("plan_id", "ID")]),
	]),
	optional("viewer_metadata", [
		field("mute", "XWA2NewsletterMuteSetting"),
		field("role", "XWA2NewsletterRole"),
		field("wamo_sub_status", "XWA2NewsletterWamoSubStatus"),
	]),
];

const invalid = () => new Error("Invalid newsletter metadata response.");
class Reader {
	constructor(bytes) {
		this.bytes = bytes;
		this.offset = 0;
	}
	get remaining() {
		return this.bytes.length - this.offset;
	}
	take(length) {
		if (length < 0 || length > this.remaining) throw invalid();
		const start = this.offset;
		this.offset += length;
		return this.bytes.subarray(start, this.offset);
	}
	label() {
		let value = 0;
		for (let shift = 0; shift < 35; shift += 7) {
			const [byte] = this.take(1);
			value += (byte & 127) * 2 ** shift;
			if (byte < 128) return value % 2 ? -(value + 1) / 2 : value / 2;
		}
		throw invalid();
	}
}

// A 0x04 response stores strings in separate blocks and field errors out of band.
// Decode this fixed document only. Field order and block keys are part of its wire format.
export function decodeNewsletterMetadata(bytes) {
	if (bytes.length > 1024 * 1024 || bytes[0] !== 4) throw invalid();
	const input = new Reader(bytes.subarray(1));
	const segments = [];
	while (input.remaining) {
		if (segments.length >= 32) throw invalid();
		segments.push(new Reader(input.take(input.label())));
	}
	const core = segments.pop();
	if (!core) throw invalid();
	const blocks = new Map();
	const utf8 = new TextDecoder("utf-8", { fatal: true });
	function readString(key, length) {
		if (!blocks.has(key)) {
			const reader = segments.shift();
			if (!reader) throw invalid();
			blocks.set(key, { reader, strings: [] });
		}
		const { reader, strings } = blocks.get(key);
		if (length <= -4) {
			const value = strings[-length - 4];
			if (value === undefined) throw invalid();
			return value;
		}
		const value = utf8.decode(reader.take(length));
		strings.push(value);
		return value;
	}
	function readRecord(fields) {
		const value = {};
		for (const { name, type, optional, nullable } of fields) {
			const label = core.label();
			if (optional && label === -2) continue;
			if (nullable && label === -1) {
				value[name] = null;
			} else if (typeof type === "string") {
				value[name] = readString(type, label);
			} else if (type === stringList) {
				if (label < 0 || label > core.remaining) throw invalid();
				value[name] = Array.from({ length: label }, () =>
					readString("String", core.label()),
				);
			} else {
				if (label !== 0) throw invalid();
				value[name] = readRecord(type);
			}
		}
		return value;
	}
	const result = readRecord([
		field("data", [field("xwa2_newsletter", newsletter)]),
	]);
	const errors = core.label();
	if (errors !== -2 && errors !== 0)
		throw new Error("WhatsApp rejected the newsletter metadata query.");
	const extensions = core.label();
	if (extensions !== -2 && extensions !== 0) throw invalid();
	if (
		extensions === -2 &&
		(core.remaining ||
			segments.length ||
			[...blocks.values()].some(({ reader }) => reader.remaining))
	)
		throw invalid();
	return result;
}
