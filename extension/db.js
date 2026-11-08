const DATABASE_NAME = "drive-batch-organizer";
const DATABASE_VERSION = 1;

let databasePromise;

function openDatabase() {
	if (!databasePromise) {
		databasePromise = new Promise((resolve, reject) => {
			const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
			request.onupgradeneeded = () => {
				const database = request.result;
				if (!database.objectStoreNames.contains("sessions")) {
					database.createObjectStore("sessions", { keyPath: "id" });
				}
				if (!database.objectStoreNames.contains("queue")) {
					const queue = database.createObjectStore("queue", { keyPath: "id" });
					queue.createIndex("sessionId", "sessionId", { unique: false });
					queue.createIndex("sessionStatus", ["sessionId", "status"], { unique: false });
				}
				if (!database.objectStoreNames.contains("folders")) {
					const folders = database.createObjectStore("folders", { keyPath: "id" });
					folders.createIndex("sessionId", "sessionId", { unique: false });
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
			request.onblocked = () =>
				reject(new Error("Close other extension tabs to upgrade the local queue database."));
		}).catch(error => {
			databasePromise = undefined;
			throw error;
		});
	}
	return databasePromise;
}

async function transact(storeNames, mode, action) {
	const database = await openDatabase();
	return new Promise((resolve, reject) => {
		const transaction = database.transaction(storeNames, mode);
		let result;
		transaction.oncomplete = () => resolve(result);
		transaction.onerror = () => reject(transaction.error);
		transaction.onabort = () => reject(transaction.error ?? new Error("Database transaction was aborted."));
		try {
			result = action(transaction);
		} catch (error) {
			transaction.abort();
			reject(error);
		}
	});
}

function requestResult(request) {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

export async function saveSession(session) {
	await transact(["sessions"], "readwrite", transaction => transaction.objectStore("sessions").put(session));
}

export async function getSession(id) {
	const database = await openDatabase();
	return requestResult(database.transaction("sessions").objectStore("sessions").get(id));
}

export async function listSessions() {
	const database = await openDatabase();
	const sessions = await requestResult(database.transaction("sessions").objectStore("sessions").getAll());
	return sessions.sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function saveQueueItem(item) {
	await transact(["queue"], "readwrite", transaction => transaction.objectStore("queue").put(item));
}

export async function saveQueueItems(items) {
	await transact(["queue"], "readwrite", transaction => {
		const store = transaction.objectStore("queue");
		for (const item of items) store.put(item);
	});
}

export async function listQueue(sessionId) {
	const database = await openDatabase();
	return requestResult(database.transaction("queue").objectStore("queue").index("sessionId").getAll(sessionId));
}

export async function getFolder(sessionId, path) {
	const database = await openDatabase();
	return requestResult(database.transaction("folders").objectStore("folders").get(`${sessionId}:${path}`));
}

export async function saveFolder(folder) {
	await transact(["folders"], "readwrite", transaction => transaction.objectStore("folders").put(folder));
}
