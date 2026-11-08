import { getFolder, saveFolder, saveQueueItem, saveSession } from "./db.js";

const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const RESUMABLE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable";
const CHUNK_SIZE = 8 * 1024 * 1024;

function escapeQuery(value) {
	return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

async function requestJson(url, token, options = {}) {
	const response = await fetch(url, {
		...options,
		headers: { Authorization: `Bearer ${token}`, ...options.headers },
	});
	if (!response.ok) throw new Error(`Drive API ${response.status}: ${await response.text()}`);
	return response.status === 204 ? null : response.json();
}

async function ensureFolder(session, path, token) {
	const cached = await getFolder(session.id, path);
	if (cached?.driveId) return cached.driveId;
	const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
	const parentId = parentPath ? await ensureFolder(session, parentPath, token) : session.driveRootId;
	const name = path.slice(path.lastIndexOf("/") + 1);
	const query = `name = '${escapeQuery(name)}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
	const found = await requestJson(
		`${DRIVE_API}?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=10`,
		token,
	);
	let driveId = found.files[0]?.id;
	if (!driveId) {
		const created = await requestJson(DRIVE_API, token, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
		});
		driveId = created.id;
	}
	await saveFolder({ id: `${session.id}:${path}`, sessionId: session.id, path, driveId });
	return driveId;
}

async function ensureRootFolder(session, token) {
	if (session.driveRootId) return session.driveRootId;
	const query = `name = '${escapeQuery(session.destinationName)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
	const found = await requestJson(
		`${DRIVE_API}?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=10`,
		token,
	);
	const created = found.files[0]
		? null
		: await requestJson(DRIVE_API, token, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: session.destinationName, mimeType: "application/vnd.google-apps.folder" }),
			});
	session.driveRootId = found.files[0]?.id ?? created.id;
	session.updatedAt = Date.now();
	await saveSession(session);
	return session.driveRootId;
}

function parseNextOffset(response, fallback = 0) {
	const range = response.headers.get("Range");
	if (!range) return fallback;
	const match = /bytes=0-(\d+)/i.exec(range);
	return match ? Number(match[1]) + 1 : fallback;
}

async function startResumableUpload(item, parentId, token) {
	const response = await fetch(RESUMABLE_UPLOAD, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json; charset=UTF-8",
			"X-Upload-Content-Type": item.mimeType || "application/octet-stream",
			"X-Upload-Content-Length": String(item.size),
		},
		body: JSON.stringify({
			name: item.generatedName,
			parents: [parentId],
			appProperties: { batchSignature: item.signatureHash },
		}),
	});
	if (response.status < 200 || response.status >= 300)
		throw new Error(`Upload handshake failed (${response.status}): ${await response.text()}`);
	const uploadUrl = response.headers.get("Location");
	if (!uploadUrl) throw new Error("Drive did not return a resumable upload URL.");
	item.uploadUrl = uploadUrl;
	item.uploadOffset = 0;
	item.updatedAt = Date.now();
	await saveQueueItem(item);
}

async function queryUploadStatus(item, token) {
	const response = await fetch(item.uploadUrl, {
		method: "PUT",
		headers: { Authorization: `Bearer ${token}`, "Content-Range": `bytes */${item.size}` },
	});
	if (response.status === 308) return { complete: false, offset: parseNextOffset(response) };
	if (response.ok) return { complete: true, offset: item.size };
	if (response.status === 404 || response.status === 410) return { expired: true, offset: 0 };
	throw new Error(`Upload recovery check failed (${response.status}): ${await response.text()}`);
}

async function sendChunk(item, file, token, start, end) {
	const chunk = await file.slice(start, end + 1).arrayBuffer();
	const response = await fetch(item.uploadUrl, {
		method: "PUT",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": item.mimeType || "application/octet-stream",
			"Content-Range": `bytes ${start}-${end}/${item.size}`,
		},
		body: chunk,
	});
	if (response.status === 308) return { complete: false, offset: parseNextOffset(response, end + 1) };
	if (response.ok) return { complete: true, offset: item.size };
	throw new Error(`Upload chunk failed (${response.status}): ${await response.text()}`);
}

export async function uploadQueueItem(session, item, token, onProgress) {
	const rootId = await ensureRootFolder(session, token);
	const parentId = item.destinationPath ? await ensureFolder(session, item.destinationPath, token) : rootId;
	let file = await item.fileHandle.getFile();

	if (!item.uploadUrl) await startResumableUpload(item, parentId, token);
	else {
		try {
			const status = await queryUploadStatus(item, token);
			if (status.complete) return;
			if (status.expired) {
				item.uploadUrl = null;
				item.uploadOffset = 0;
				await startResumableUpload(item, parentId, token);
			} else item.uploadOffset = status.offset;
		} catch (error) {
			if (error.message.includes("401"))
				throw new Error("Drive authorization expired. Restart the upload to reauthorize.");
			throw error;
		}
	}

	while (item.uploadOffset < item.size) {
		const start = item.uploadOffset;
		const end = Math.min(start + CHUNK_SIZE, item.size) - 1;
		let result;
		try {
			result = await sendChunk(item, file, token, start, end);
		} catch (error) {
			if (error.message.includes("401"))
				throw new Error("Drive authorization expired. Restart the upload to reauthorize.");
			const status = await queryUploadStatus(item, token);
			if (status.expired) {
				item.uploadUrl = null;
				await startResumableUpload(item, parentId, token);
				continue;
			}
			if (status.complete) break;
			result = { complete: false, offset: status.offset };
		}
		item.uploadOffset = result.offset;
		item.updatedAt = Date.now();
		await saveQueueItem(item);
		onProgress(item.uploadOffset, item.size);
		if (result.complete) break;
		if (item.uploadOffset <= start)
			throw new Error("Drive did not advance the upload offset; the saved session can be resumed.");
	}
}

export async function authorizeDrive(interactive = true) {
	return new Promise((resolve, reject) => {
		chrome.identity.getAuthToken({ interactive }, token => {
			const error = chrome.runtime.lastError;
			if (error) reject(new Error(error.message));
			else if (!token) reject(new Error("Google authorization did not return an access token."));
			else resolve(token);
		});
	});
}
