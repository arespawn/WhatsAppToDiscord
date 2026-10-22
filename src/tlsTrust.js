import { createHash, X509Certificate } from "node:crypto";
import tls from "node:tls";

// Temporary distrust for the October 2026 eMudhra compromise. Public-key hashes
// cover alternate/cross-signed certificates with the same key. Sources:
// https://emudhra.we-have-a-problem.com/roots.json
// https://emudhra.we-have-a-problem.com/impacted-intermediates.json
const BLOCKED_CA_SPKIS = new Set([
	// emSign Root TLS CA - G3
	"c619e4780ed8e0abeda24ad732567de4383a7ea941338f6d1a7d1b49ac792fe9",
	// emSign Root CS CA - G3
	"0a6c2b2ca5b364207954171987ac9d2178561569d8205457e77ca90c32ede282",
	// AAA Certificate Services
	"bd153ed7b0434f6886b17bce8bbe84ed340c7132d702a8f4fa318f756ecbd6f3",
	// emSign ECC Root CA - G3
	"8d417db2dd8bf5e3084d1e3f196d583849d81bdd4c00c70b9d39369e96b8c782",
	// EM DV TLS CA - G3B
	"ebed6475c2c2d80fcb199f3fe8dd6e6b3ce60b77eb15d4e42c3dec0c6f5b5105",
	// EM OV TLS CA - G3B
	"43bffa19d6ef651451f6841e019931e96f6f2eaeff28ab4b6f1ce4576de2717b",
	// EM EV TLS CA - G3B
	"e0254c7fcdc265e2f0f8a428dabb75ab4ae039b4872d62f5ee57f0877d5a8a41",
	// EM DV TLS CA - G3C
	"49dd353dc2b919a3770645117d0e60c16115e7d1bc259eefe734b00ea434fe5f",
	// EM OV TLS CA - G3C
	"63ecefee431d49523bc1136c4e72d0206a477086caf606cd5cf025686c109cf8",
	// EM EV TLS CA - G3C
	"5c0660a2b164910d8ff589c18e14552e9e0ec237dcefe2cb736d41a4811f81a0",
	// EM OV CS CA - G3B
	"ec4ffa1ad0ac88081314b7aaffef6a91f97cd57291bb5ba686c5415f5eb4f6b6",
	// EM OV CS CA - G3C
	"92c063d67e8f14db71d288e11266ffdaf69cbf115f7bab14f3bc2f68d25e0e30",
]);

const filterTrustedCACertificates = (certificates) =>
	certificates.filter((pem) => {
		const certificate = new X509Certificate(pem);
		const hash = createHash("sha256")
			.update(certificate.publicKey.export({ type: "spki", format: "der" }))
			.digest("hex");
		return !BLOCKED_CA_SPKIS.has(hash);
	});

const hasNativeCertificateBlocklist = (version) => {
	if (!/^\d+\.\d+\.\d+$/u.test(version)) return false;
	const [major, minor, patch] = version.split(".").map(Number);
	return (
		(major === 24 && (minor > 22 || (minor === 22 && patch >= 1))) ||
		(major === 26 && (minor > 12 || (minor === 12 && patch >= 1))) ||
		major > 26
	);
};

const applyTlsTrustFilter = ({
	getCACertificates = tls.getCACertificates,
	setDefaultCACertificates = tls.setDefaultCACertificates,
	nodeVersion = process.versions.node,
} = {}) => {
	// Patched Node blocks these keys during chain verification, including when
	// OpenSSL or a connection-specific CA store is used. Preserve that trust setup.
	if (hasNativeCertificateBlocklist(nodeVersion)) {
		return { native: true, removed: 0 };
	}
	if (
		typeof getCACertificates !== "function" ||
		typeof setDefaultCACertificates !== "function"
	) {
		throw new Error(
			"TLS trust filtering requires a current supported Node.js runtime.",
		);
	}
	const certificates = getCACertificates("default");
	const trusted = filterTrustedCACertificates(certificates);
	if (trusted.length === 0) {
		throw new Error(
			"No usable enumerable TLS CA certificates. Use bundled/system CA mode and NODE_EXTRA_CA_CERTS for additional roots.",
		);
	}
	// Replace the store without a permissive alternate-CA fallback.
	setDefaultCACertificates(trusted);
	const installed = getCACertificates("default");
	if (
		installed.length === 0 ||
		filterTrustedCACertificates(installed).length !== installed.length
	) {
		throw new Error("TLS certificate distrust could not be verified.");
	}
	return {
		removed: certificates.length - trusted.length,
		trusted: trusted.length,
	};
};

export {
	applyTlsTrustFilter,
	filterTrustedCACertificates,
	hasNativeCertificateBlocklist,
};
