const EXIF_DATE_TAGS = new Set([0x9003, 0x9004, 0x0132]);

function readExifDate(view, start, end) {
	const byteOrder = view.getUint16(start, false);
	const littleEndian = byteOrder === 0x4949;
	if (!littleEndian && byteOrder !== 0x4d4d) return null;
	if (view.getUint16(start + 2, littleEndian) !== 42) return null;

	const readDirectory = (offset, depth = 0) => {
		if (depth > 2 || offset + 2 > end) return null;
		const count = view.getUint16(offset, littleEndian);
		for (let index = 0; index < count; index += 1) {
			const entry = offset + 2 + index * 12;
			if (entry + 12 > end) break;
			const tag = view.getUint16(entry, littleEndian);
			const type = view.getUint16(entry + 2, littleEndian);
			const valueCount = view.getUint32(entry + 4, littleEndian);
			if (tag === 0x8769) {
				const exifOffset = start + view.getUint32(entry + 8, littleEndian);
				const date = readDirectory(exifOffset, depth + 1);
				if (date) return date;
			}
			if (!EXIF_DATE_TAGS.has(tag) || type !== 2 || valueCount < 19 || valueCount > 64) continue;
			const valueOffset = valueCount <= 4 ? entry + 8 : start + view.getUint32(entry + 8, littleEndian);
			if (valueOffset + valueCount > end) continue;
			const value = new TextDecoder()
				.decode(new Uint8Array(view.buffer, valueOffset, valueCount))
				.replace(/\0.*$/, "")
				.trim();
			const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value);
			if (match)
				return new Date(
					Number(match[1]),
					Number(match[2]) - 1,
					Number(match[3]),
					Number(match[4]),
					Number(match[5]),
					Number(match[6]),
				);
		}
		return null;
	};

	return readDirectory(start + view.getUint32(start + 4, littleEndian));
}

async function imageCreationDate(file) {
	if (!/^image\/(jpeg|tiff)$/i.test(file.type) && !/\.(jpe?g|tiff?)$/i.test(file.name)) return null;
	const bytes = await file.slice(0, Math.min(file.size, 2 * 1024 * 1024)).arrayBuffer();
	const view = new DataView(bytes);
	if (view.byteLength >= 8 && (view.getUint16(0, false) === 0x4949 || view.getUint16(0, false) === 0x4d4d)) {
		return readExifDate(view, 0, view.byteLength);
	}
	if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) return null;
	let offset = 2;
	while (offset + 4 <= view.byteLength) {
		if (view.getUint8(offset) !== 0xff) break;
		const marker = view.getUint8(offset + 1);
		const length = view.getUint16(offset + 2, false);
		if (length < 2 || offset + 2 + length > view.byteLength) break;
		if (marker === 0xe1 && view.getUint32(offset + 4, false) === 0x45786966) {
			const tiffStart = offset + 10;
			return readExifDate(view, tiffStart, offset + 2 + length);
		}
		offset += 2 + length;
	}
	return null;
}

async function videoCreationDate(file) {
	if (!/^video\//i.test(file.type) && !/\.(mp4|mov|m4v|3gp)$/i.test(file.name)) return null;
	const bytes = await file.slice(0, Math.min(file.size, 2 * 1024 * 1024)).arrayBuffer();
	const view = new DataView(bytes);
	const scanEnd = view.byteLength;
	for (let offset = 4; offset + 20 <= scanEnd; offset += 1) {
		if (view.getUint32(offset, false) !== 0x6d766864) continue;
		const version = view.getUint8(offset + 4);
		const creationSeconds =
			version === 1 ? Number(view.getBigUint64(offset + 8, false)) : view.getUint32(offset + 8, false);
		if (creationSeconds > 0) return new Date((creationSeconds - 2082844800) * 1000);
	}
	return null;
}

export async function extractCreationDate(file) {
	try {
		const metadataDate = (await imageCreationDate(file)) ?? (await videoCreationDate(file));
		if (metadataDate && !Number.isNaN(metadataDate.getTime())) {
			return { date: metadataDate, source: "metadata" };
		}
	} catch (error) {
		console.warn(`Metadata read failed for ${file.name}; using file timestamp.`, error);
	}
	return { date: new Date(file.lastModified || Date.now()), source: "file timestamp" };
}
