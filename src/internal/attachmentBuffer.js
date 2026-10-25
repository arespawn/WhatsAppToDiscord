export const readStreamToBuffer = async (stream, maxBytes) => {
	const chunks = [];
	let length = 0;
	for await (const chunk of stream) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		length += buffer.length;
		if (length > maxBytes) {
			throw Object.assign(new Error(`buffer_length_exceeded:${length}`), {
				code: "WA2DC_ATTACHMENT_TOO_LARGE",
			});
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks, length);
};

export const loadAttachmentBuffer = async (
	attachment = {},
	{ maxBytes, accept, fetchBuffer } = {},
) => {
	const sourceUrl =
		typeof attachment?.url === "string" ? attachment.url.trim() : "";
	if (!sourceUrl) return null;
	if (sourceUrl.startsWith("data:")) {
		const commaIndex = sourceUrl.indexOf(",");
		if (commaIndex < 0) return null;
		const meta = sourceUrl.slice(0, commaIndex);
		const payload = sourceUrl.slice(commaIndex + 1);
		if (!payload) return null;
		const decoded = /;base64$/i.test(meta)
			? Buffer.from(payload, "base64")
			: Buffer.from(decodeURIComponent(payload), "utf8");
		if (!decoded.length) return null;
		if (decoded.length > maxBytes)
			throw new Error(`buffer_length_exceeded:${decoded.length}`);
		return decoded;
	}
	if (!/^https?:\/\//i.test(sourceUrl)) return null;
	if (typeof fetchBuffer === "function") {
		const response = await fetchBuffer(sourceUrl, { maxBytes, accept });
		return response?.buffer || null;
	}
	const response = await fetch(sourceUrl, {
		...(accept ? { headers: { accept } } : {}),
		signal: AbortSignal.timeout(60000),
	});
	const contentLength = Number.parseInt(
		response.headers.get("content-length") || "",
		10,
	);
	if (!response.ok || contentLength > maxBytes) {
		await response.body?.cancel().catch(() => {});
		throw new Error(
			!response.ok
				? `HTTP ${response.status}`
				: `content_length_exceeded:${contentLength}`,
		);
	}
	return response.body
		? readStreamToBuffer(response.body, maxBytes)
		: Buffer.alloc(0);
};
