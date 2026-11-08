import { extractCreationDate } from "./metadata.js";

const SUPPORTED_EXTENSIONS = /\.(avif|bmp|gif|heic|heif|jpe?g|m4v|mov|mp4|mpeg|mpg|png|tif|tiff|webm|webp|3gp)$/i;

export async function* walkMedia(directoryHandle, parentPath = "") {
	for await (const [name, handle] of directoryHandle.entries()) {
		const relativePath = parentPath ? `${parentPath}/${name}` : name;
		if (handle.kind === "directory") {
			yield* walkMedia(handle, relativePath);
			continue;
		}
		if (!SUPPORTED_EXTENSIONS.test(name)) continue;
		const file = await handle.getFile();
		if (file.size === 0) continue;
		if (!file.type.startsWith("image/") && !file.type.startsWith("video/") && !SUPPORTED_EXTENSIONS.test(file.name))
			continue;
		const { date, source } = await extractCreationDate(file);
		yield { file, handle, relativePath, creationDate: date.toISOString(), metadataSource: source };
	}
}

export function getMediaKind(file) {
	return file.type.startsWith("video/") || /\.(m4v|mov|mp4|mpeg|mpg|webm|3gp)$/i.test(file.name) ? "VIDEO" : "IMAGE";
}
