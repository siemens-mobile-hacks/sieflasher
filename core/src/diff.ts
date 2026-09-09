// Dump comparison helpers (for debugging read differences between tools
// or between two reads of the same phone).

import { Buffer } from "buffer";

export interface DiffRegion {
	// Offset of the first differing byte.
	addr: number;
	// Number of differing bytes (plus merge gaps inside the region).
	length: number;
}

// Groups the differing bytes of two buffers into regions. Runs of differing
// bytes that are separated by at most `mergeGap` equal bytes are merged into
// one region (like diff tools show a changed block with context).
export function diffBuffers(a: Uint8Array, b: Uint8Array, mergeGap = 16): DiffRegion[] {
	const len = Math.min(a.length, b.length);
	const regions: DiffRegion[] = [];
	let region: DiffRegion | undefined;
	let gap = 0;

	for (let i = 0; i < len; i++) {
		if (a[i] != b[i]) {
			if (region) {
				region.length = i - region.addr + 1;
				gap = 0;
			} else {
				region = { addr: i, length: 1 };
				regions.push(region);
				gap = 0;
			}
		} else if (region) {
			gap++;
		}
		if (region && gap > mergeGap)
			region = undefined;
	}

	// Different lengths: the tail counts as one region.
	if (a.length != b.length) {
		const tailAddr = len;
		const tailLen = Math.abs(a.length - b.length);
		const last = regions[regions.length - 1];
		if (last && last.addr + last.length >= tailAddr - mergeGap)
			last.length = tailAddr + tailLen - last.addr;
		else
			regions.push({ addr: tailAddr, length: tailLen });
	}

	return regions;
}

export interface DiffEraseStats {
	// Bytes with data in A but 0xFF in B (erased in B).
	aToFF: number;
	// Bytes with 0xFF in A but data in B (filled in B).
	ffToA: number;
	// Bytes that differ without any side being 0xFF.
	changed: number;
}

// Classifies the differing bytes: erased, filled or plain changed.
// Useful to tell a live filesystem (mixed directions) from a read
// corruption (usually one-sided or shifted data).
export function diffEraseStats(a: Uint8Array, b: Uint8Array, regions: DiffRegion[]): DiffEraseStats {
	const stats: DiffEraseStats = { aToFF: 0, ffToA: 0, changed: 0 };
	const len = Math.min(a.length, b.length);
	for (const region of regions) {
		const end = Math.min(region.addr + region.length, len);
		for (let i = region.addr; i < end; i++) {
			if (a[i] == b[i])
				continue;
			if (b[i] == 0xFF && a[i] != 0xFF)
				stats.aToFF++;
			else if (a[i] == 0xFF && b[i] != 0xFF)
				stats.ffToA++;
			else
				stats.changed++;
		}
	}
	return stats;
}

export interface DiffRegionPreview {
	addr: number;
	length: number;
	a: string;
	b: string;
}

// Hex previews of both sides for every region (for the diff list UI).
export function diffRegionPreviews(a: Uint8Array, b: Uint8Array, regions: DiffRegion[], maxBytes = 32): DiffRegionPreview[] {
	return regions.map((region) => {
		const end = Math.min(region.addr + region.length, Math.min(a.length, b.length));
		const view = (buf: Uint8Array) =>
			Buffer.from(buf.subarray(region.addr, Math.min(end, region.addr + maxBytes))).toString("hex").toUpperCase()
				.match(/.{1,2}/g)?.join(" ") ?? "";
		return {
			addr: region.addr,
			length: region.length,
			a: view(a),
			b: view(b),
		};
	});
}
