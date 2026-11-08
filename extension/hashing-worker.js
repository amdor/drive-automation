self.onmessage = async event => {
	const { id, fileSize, lastModified, head, tail, relativePath } = event.data;
	try {
		const pathBytes = new TextEncoder().encode(`${relativePath}\0${fileSize}\0${lastModified}\0`);
		const combined = new Uint8Array(pathBytes.length + head.byteLength + tail.byteLength);
		combined.set(pathBytes);
		combined.set(new Uint8Array(head), pathBytes.length);
		combined.set(new Uint8Array(tail), pathBytes.length + head.byteLength);
		const digest = await crypto.subtle.digest("SHA-256", combined);
		const signatureHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
		self.postMessage({ id, signatureHash });
	} catch (error) {
		self.postMessage({ id, error: error.message || "Unable to fingerprint file." });
	}
};
