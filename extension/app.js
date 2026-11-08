import { getSession, listQueue, listSessions, saveQueueItem, saveSession } from "./db.js";
import { authorizeDrive, uploadQueueItem } from "./drive.js";
import { getMediaKind, walkMedia } from "./scanner.js";

const elements = {
	chooseDirectory: document.querySelector("#choose-directory"),
	directoryName: document.querySelector("#directory-name"),
	directoryDetail: document.querySelector("#directory-detail"),
	destinationName: document.querySelector("#destination-name"),
	categoryRule: document.querySelector("#category-rule"),
	renameRule: document.querySelector("#rename-rule"),
	scanButton: document.querySelector("#scan-button"),
	runButton: document.querySelector("#run-button"),
	message: document.querySelector("#message"),
	queueCount: document.querySelector("#queue-count"),
	progressValue: document.querySelector("#progress-value"),
	progressDetail: document.querySelector("#progress-detail"),
	progressBar: document.querySelector("#progress-bar"),
	progressTrack: document.querySelector(".progress-track"),
	pendingCount: document.querySelector("#pending-count"),
	activeCount: document.querySelector("#active-count"),
	doneCount: document.querySelector("#done-count"),
	failedCount: document.querySelector("#failed-count"),
	queueList: document.querySelector("#queue-list"),
	sessionLabel: document.querySelector("#session-label"),
	connectionLabel: document.querySelector("#connection-label"),
	connectButton: document.querySelector("#connect-drive"),
	landingScreen: document.querySelector("#landing-screen"),
	workspaceApp: document.querySelector("#workspace-app"),
	landingConnect: document.querySelector("#landing-connect"),
	landingStatus: document.querySelector("#landing-status"),
};

let activeSession;
let queueItems = [];
let isBusy = false;
let fingerprintWorker;
let fingerprintSequence = 0;
let driveToken = null;
const fingerprintRequests = new Map();

function hasOAuthClientId() {
	const clientId = chrome.runtime.getManifest().oauth2?.client_id ?? "";
	return Boolean(clientId) && !clientId.startsWith("YOUR_");
}

function updateDriveConnection() {
	const connected = Boolean(driveToken);
	elements.connectButton.textContent = connected ? "Refresh Drive" : "Connect Drive";
	elements.connectButton.disabled = isBusy;
	if (connected) elements.connectionLabel.textContent = "Connected to Google Drive";
	if (!connected) elements.connectionLabel.textContent = "Google Drive not connected";

	elements.workspaceApp.hidden = !connected;
	elements.workspaceApp.style.display = connected ? "block" : "none";
	elements.landingScreen.hidden = connected;
	elements.landingScreen.style.display = connected ? "none" : "grid";

	if (connected) {
		setMessage("Google Drive connected. Your uploads will use this account.", "success");
		setLandingStatus("Connected successfully.", "success");
	} else {
		setLandingStatus("You must connect to Google Drive before using the app.", "error");
	}
}

function requireDriveAccess() {
	if (driveToken) return true;
	elements.workspaceApp.hidden = true;
	elements.landingScreen.hidden = false;
	setLandingStatus("Connect to Google Drive before using the app.", "error");
	setMessage("Connect to Google Drive before using the app.", "error");
	return false;
}

async function connectDrive({ interactive = true } = {}) {
	if (isBusy) return false;
	if (!hasOAuthClientId()) {
		const message =
			"Google Drive sign-in is not configured for this extension yet. Contact the extension publisher.";
		setMessage(message, "error");
		setLandingStatus(message, "error");
		return false;
	}
	elements.connectButton.disabled = true;
	elements.connectButton.textContent = interactive ? "Connecting…" : "Checking…";
	if (elements.landingConnect) {
		elements.landingConnect.disabled = true;
		elements.landingConnect.textContent = interactive ? "Connecting…" : "Checking…";
	}
	try {
		driveToken = await authorizeDrive(interactive);
		updateDriveConnection();
		setMessage("Google Drive connected. Your uploads will use this account.", "success");
		return true;
	} catch (error) {
		driveToken = null;
		updateDriveConnection();
		const message = `Could not connect to Google Drive: ${error.message}`;
		setMessage(message, "error");
		setLandingStatus(message, "error");
		return false;
	} finally {
		elements.connectButton.disabled = isBusy;
		elements.connectButton.textContent = driveToken ? "Refresh Drive" : "Connect Drive";
		if (elements.landingConnect) {
			elements.landingConnect.disabled = false;
			elements.landingConnect.textContent = "Connect to Drive";
		}
	}
}

function setMessage(message, kind = "") {
	elements.message.textContent = message;
	elements.message.dataset.kind = kind;
}

function setLandingStatus(message, kind = "") {
	if (!elements.landingStatus) return;
	elements.landingStatus.textContent = message;
	elements.landingStatus.dataset.kind = kind;
}

function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
	return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function dateParts(isoDate) {
	const date = new Date(isoDate);
	const year = String(date.getFullYear());
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return { date, year, month, day, dateString: `${year}-${month}-${day}` };
}

function generatedName(fileName, isoDate, rule) {
	if (rule === "original") return fileName;
	const { dateString } = dateParts(isoDate);
	const extensionIndex = fileName.lastIndexOf(".");
	const extension = extensionIndex > 0 ? fileName.slice(extensionIndex) : "";
	const stem = extension ? fileName.slice(0, extensionIndex) : fileName;
	if (rule === "exact-date") return `${dateString}${extension}`;
	return `${dateString}_${stem}${extension}`;
}

function categoryPath(isoDate, rule) {
	if (rule === "none") return "";
	const { year, month } = dateParts(isoDate);
	return rule === "month" ? String(Number(month)) : `${year}-${month}`;
}

function fingerprint(file, relativePath) {
	fingerprintWorker ??= new Worker("./hashing-worker.js");
	const id = ++fingerprintSequence;
	return (async () => {
		const sampleSize = 64 * 1024;
		const head = await file.slice(0, sampleSize).arrayBuffer();
		const tail =
			file.size > sampleSize
				? await file.slice(Math.max(sampleSize, file.size - sampleSize)).arrayBuffer()
				: new ArrayBuffer(0);
		return new Promise((resolve, reject) => {
			fingerprintRequests.set(id, { resolve, reject });
			fingerprintWorker.onmessage = ({ data }) => {
				const request = fingerprintRequests.get(data.id);
				if (!request) return;
				fingerprintRequests.delete(data.id);
				if (data.error) request.reject(new Error(data.error));
				else request.resolve(data.signatureHash);
			};
			fingerprintWorker.onerror = error => {
				for (const request of fingerprintRequests.values()) request.reject(error);
				fingerprintRequests.clear();
				fingerprintWorker.terminate();
				fingerprintWorker = undefined;
			};
			fingerprintWorker.postMessage(
				{ id, fileSize: file.size, lastModified: file.lastModified, head, tail, relativePath },
				[head, tail],
			);
		});
	})().catch(async error => {
		console.warn("Worker fingerprint failed; using a metadata-only signature.", error);
		const bytes = new TextEncoder().encode(`${relativePath}\0${file.size}\0${file.lastModified}\0${file.name}`);
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
	});
}

function setBusy(value) {
	isBusy = value;
	elements.chooseDirectory.disabled = value;
	elements.scanButton.disabled = value || !activeSession?.directoryHandle;
	elements.runButton.disabled =
		value || !activeSession?.scanComplete || !queueItems.some(item => item.status !== "completed");
	elements.destinationName.disabled = value;
	elements.categoryRule.disabled = value;
	elements.renameRule.disabled = value;
	updateDriveConnection();
}

function renderQueue(progressItemId = "", progressOffset = 0) {
	const total = queueItems.length;
	const completed = queueItems.filter(item => item.status === "completed").length;
	const failed = queueItems.filter(item => item.status === "failed").length;
	const pending = queueItems.filter(item => item.status === "pending").length;
	const active = queueItems.filter(item => item.status === "processing").length;
	const totalBytes = queueItems.reduce((sum, item) => sum + item.size, 0);
	let completedBytes = queueItems.reduce((sum, item) => sum + (item.status === "completed" ? item.size : 0), 0);
	if (progressItemId) completedBytes += progressOffset;
	const percentage = total
		? totalBytes
			? Math.min(100, Math.floor((completedBytes / totalBytes) * 100))
			: Math.floor((completed / total) * 100)
		: 0;

	elements.queueCount.textContent = `${total} ${total === 1 ? "file" : "files"}`;
	elements.pendingCount.textContent = String(pending);
	elements.activeCount.textContent = String(active);
	elements.doneCount.textContent = String(completed);
	elements.failedCount.textContent = String(failed);
	elements.progressValue.textContent = `${percentage}%`;
	elements.progressDetail.textContent = active
		? "Uploading current file"
		: total
			? `${completed} of ${total} files complete`
			: "Waiting for a scan";
	elements.progressBar.style.width = `${percentage}%`;
	elements.progressTrack.setAttribute("aria-valuenow", String(percentage));
	elements.sessionLabel.textContent = activeSession?.id
		? `SESSION ${activeSession.id.slice(0, 8).toUpperCase()}`
		: "NO ACTIVE SESSION";
	elements.runButton.disabled =
		isBusy || !activeSession?.scanComplete || !queueItems.some(item => item.status !== "completed");

	const visibleItems = queueItems.slice(0, 100);
	elements.queueList.replaceChildren();
	if (!visibleItems.length) {
		const empty = document.createElement("li");
		empty.className = "empty-state";
		empty.textContent = "Scanned files will appear here.";
		elements.queueList.append(empty);
		return;
	}
	const fragment = document.createDocumentFragment();
	for (const item of visibleItems) {
		const row = document.createElement("li");
		const kind = document.createElement("span");
		kind.className = "file-kind";
		kind.textContent = item.kind;
		const info = document.createElement("span");
		info.className = "file-info";
		const name = document.createElement("strong");
		name.textContent = item.sourceName;
		name.title = item.relativePath;
		const detail = document.createElement("small");
		detail.textContent = `${formatBytes(item.size)} · ${item.destinationPath || "Drive root"}`;
		info.append(name, detail);
		const state = document.createElement("span");
		state.className = "file-state";
		state.dataset.state = item.status;
		state.textContent = item.status;
		if (item.error) state.title = item.error;
		row.append(kind, info, state);
		fragment.append(row);
	}
	elements.queueList.append(fragment);
	if (total > visibleItems.length) {
		const more = document.createElement("li");
		more.className = "empty-state";
		more.textContent = `Showing the first ${visibleItems.length} of ${total} files.`;
		elements.queueList.append(more);
	}
}

async function restoreLatestSession() {
	const sessions = await listSessions();
	const session = sessions[0];
	if (!session) return;
	activeSession = await getSession(session.id);
	queueItems = await listQueue(activeSession.id);
	let changed = false;
	for (const item of queueItems) {
		if (item.status === "processing") {
			item.status = "pending";
			item.error = "";
			await saveQueueItem(item);
			changed = true;
		}
	}
	if (activeSession.status === "running" || activeSession.status === "scanning") {
		activeSession.status = "paused";
		activeSession.updatedAt = Date.now();
		await saveSession(activeSession);
		changed = true;
	}
	if (activeSession.directoryHandle) {
		elements.directoryName.textContent = activeSession.directoryHandle.name;
		elements.directoryDetail.textContent = `${queueItems.length} saved files · select Scan to start a new session`;
		elements.scanButton.disabled = false;
	}
	elements.destinationName.value = activeSession.destinationName;
	elements.categoryRule.value = activeSession.categoryRule;
	elements.renameRule.value = activeSession.renameRule;
	elements.connectionLabel.textContent = changed ? "Saved session restored" : "Local queue restored";
	renderQueue();
	elements.runButton.disabled = !activeSession.scanComplete || !queueItems.some(item => item.status !== "completed");
	if (!activeSession.scanComplete) {
		setMessage("The previous scan stopped early. Scan the directory again to build a complete session.");
	} else {
		setMessage(
			queueItems.length
				? "A saved session is ready to resume."
				: "The previous scan did not contain any supported media.",
		);
	}
}

elements.chooseDirectory.addEventListener("click", async () => {
	if (!requireDriveAccess()) return;
	try {
		const directoryHandle = await window.showDirectoryPicker({ mode: "read" });
		activeSession = { directoryHandle };
		queueItems = [];
		elements.directoryName.textContent = directoryHandle.name;
		elements.directoryDetail.textContent = "Ready to scan images and videos recursively";
		elements.scanButton.disabled = false;
		elements.sessionLabel.textContent = "NO ACTIVE SESSION";
		renderQueue();
		setMessage("Directory selected. Choose Scan directory to build the local queue.");
	} catch (error) {
		if (error.name !== "AbortError") setMessage(error.message || "Could not open that directory.", "error");
	}
});

elements.connectButton.addEventListener("click", () => connectDrive({ interactive: true }));
elements.landingConnect.addEventListener("click", () => connectDrive({ interactive: true }));

elements.scanButton.addEventListener("click", async () => {
	if (!requireDriveAccess()) return;
	if (!activeSession?.directoryHandle || isBusy) return;
	const destinationName = elements.destinationName.value.trim();
	if (!destinationName) {
		setMessage("Enter a Drive destination folder name before scanning.", "error");
		return;
	}
	const directoryHandle = activeSession.directoryHandle;
	const sessionId = crypto.randomUUID();
	activeSession = {
		id: sessionId,
		directoryHandle,
		directoryName: directoryHandle.name,
		destinationName,
		categoryRule: elements.categoryRule.value,
		renameRule: elements.renameRule.value,
		status: "scanning",
		scanComplete: false,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		totalFiles: 0,
		completedFiles: 0,
		failedFiles: 0,
		driveRootId: null,
	};
	queueItems = [];
	setBusy(true);
	await saveSession(activeSession);
	renderQueue();
	setMessage("Scanning selected directory…");
	elements.connectionLabel.textContent = "Scanning local files";
	try {
		for await (const discovered of walkMedia(directoryHandle)) {
			const { file, handle, relativePath, creationDate, metadataSource } = discovered;
			const signatureHash = await fingerprint(file, relativePath);
			const sourceName = file.name;
			const destinationPath = categoryPath(creationDate, activeSession.categoryRule);
			const item = {
				id: `${sessionId}:${relativePath}`,
				sessionId,
				relativePath,
				sourceName,
				generatedName: generatedName(sourceName, creationDate, activeSession.renameRule),
				destinationPath,
				signatureHash,
				signatureMethod: "SHA-256 of file metadata and sampled content",
				fileHandle: handle,
				size: file.size,
				lastModified: file.lastModified,
				mimeType: file.type || "application/octet-stream",
				kind: getMediaKind(file),
				creationDate,
				metadataSource,
				status: "pending",
				uploadUrl: null,
				uploadOffset: 0,
				error: "",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			queueItems.push(item);
			await saveQueueItem(item);
			activeSession.totalFiles = queueItems.length;
			activeSession.updatedAt = Date.now();
			if (queueItems.length % 20 === 0) {
				await saveSession(activeSession);
				elements.directoryDetail.textContent = `${queueItems.length} media files found so far`;
				elements.queueCount.textContent = `${queueItems.length} files`;
				elements.progressDetail.textContent = "Scanning local files";
			}
		}
		activeSession.status = "queued";
		activeSession.scanComplete = true;
		activeSession.updatedAt = Date.now();
		await saveSession(activeSession);
		elements.directoryDetail.textContent = `${queueItems.length} ${queueItems.length === 1 ? "media file" : "media files"} queued`;
		elements.connectionLabel.textContent = "Queue saved locally";
		setMessage(
			queueItems.length
				? "Scan complete. Your queue is saved and ready to upload."
				: "No supported image or video files were found.",
		);
		renderQueue();
	} catch (error) {
		activeSession.status = "paused";
		activeSession.updatedAt = Date.now();
		await saveSession(activeSession);
		setMessage(`Scan stopped: ${error.message}`, "error");
		elements.connectionLabel.textContent = "Partial scan saved";
		renderQueue();
	} finally {
		setBusy(false);
	}
});

elements.runButton.addEventListener("click", async () => {
	if (!activeSession?.id || isBusy) return;
	if (!activeSession.scanComplete) {
		setMessage("Scan the directory to completion before uploading this batch.", "error");
		return;
	}
	if (!hasOAuthClientId()) {
		setMessage(
			"Google Drive sign-in is not configured for this extension yet. Contact the extension publisher.",
			"error",
		);
		return;
	}
	if (!requireDriveAccess()) return;
	setBusy(true);
	try {
		const granted = await activeSession.directoryHandle.requestPermission({ mode: "read" });
		if (granted !== "granted") {
			setMessage("Read access to the selected directory is required to continue.", "error");
			return;
		}
		const token = driveToken;
		activeSession.status = "running";
		activeSession.updatedAt = Date.now();
		await saveSession(activeSession);
		elements.connectionLabel.textContent = "Connected to Google Drive";
		elements.runButton.innerHTML = '<span aria-hidden="true">↻</span> Uploading…';
		const workItems = queueItems.filter(item => item.status !== "completed");
		let authorizationExpired = false;
		for (const item of workItems) {
			item.status = "processing";
			item.error = "";
			item.updatedAt = Date.now();
			await saveQueueItem(item);
			renderQueue(item.id, item.uploadOffset);
			setMessage(`Uploading ${item.sourceName}…`);
			try {
				await uploadQueueItem(activeSession, item, token, offset => renderQueue(item.id, offset));
				item.status = "completed";
				item.uploadOffset = item.size;
				item.error = "";
				activeSession.completedFiles = queueItems.filter(
					entry => entry.status === "completed" || entry.id === item.id,
				).length;
			} catch (error) {
				item.status = "failed";
				item.error = error.message || "Upload failed.";
				activeSession.failedFiles += 1;
				if (item.error.includes("authorization expired") || /\b401\b/.test(item.error))
					authorizationExpired = true;
			}
			item.updatedAt = Date.now();
			await saveQueueItem(item);
			activeSession.updatedAt = Date.now();
			await saveSession(activeSession);
			renderQueue();
			if (authorizationExpired) break;
		}
		const hasUnfinished = queueItems.some(item => item.status !== "completed");
		activeSession.status = hasUnfinished ? "paused" : "completed";
		activeSession.updatedAt = Date.now();
		await saveSession(activeSession);
		elements.connectionLabel.textContent = hasUnfinished ? "Queue paused · resumable" : "Batch complete";
		if (authorizationExpired) {
			driveToken = null;
			updateDriveConnection();
			setMessage("Drive authorization expired. Start the upload again to reauthorize and resume.", "error");
		} else if (hasUnfinished)
			setMessage(
				"Some files failed. Start the upload again to retry; saved upload sessions will resume.",
				"error",
			);
		else setMessage("Batch complete. All queued files are in Google Drive.", "success");
	} catch (error) {
		activeSession.status = "paused";
		activeSession.updatedAt = Date.now();
		await saveSession(activeSession);
		elements.connectionLabel.textContent = "Queue paused · resumable";
		setMessage(`Upload paused: ${error.message}`, "error");
	} finally {
		setBusy(false);
		elements.runButton.innerHTML = '<span aria-hidden="true">↑</span> Resume upload';
		renderQueue();
	}
});

async function initializeApp() {
	try {
		const cachedToken = await authorizeDrive(false).catch(() => null);
		driveToken = cachedToken;
		updateDriveConnection();
	} catch (error) {
		driveToken = null;
		updateDriveConnection();
	}
	try {
		await restoreLatestSession();
	} catch (error) {
		setMessage(`Could not restore the saved queue: ${error.message}`, "error");
	}
}

initializeApp();
