// Fullflash dump file as a device (port of VDeviceFile from VDeviceFile.cpp).

import { Buffer } from "buffer";
import { FlasherDeviceBase } from "./device.js";

// A dump need not cover the whole flash: startOffset is the flash offset its
// first byte was read from, so that a patch addresses the same byte in the
// dump and in the phone it came from.
export class FlashDumpDevice extends FlasherDeviceBase {
	private readonly buffer: Buffer;
	private readonly startOffset: number;
	private isModified = false;

	constructor(buffer: Buffer, startOffset = 0) {
		super();
		this.buffer = buffer;
		this.startOffset = startOffset;
	}

	get size(): number {
		return this.buffer.length;
	}

	get modified(): boolean {
		return this.isModified;
	}

	getBuffer(): Buffer {
		return this.buffer;
	}

	async open(): Promise<void> {}

	async close(): Promise<void> {
		await this.flush();
	}

	async read(offset: number, size: number): Promise<Uint8Array> {
		this.checkBounds(offset, size);
		const at = offset - this.startOffset;
		return this.buffer.subarray(at, at + size);
	}

	async write(offset: number, data: Uint8Array): Promise<void> {
		this.checkBounds(offset, data.length);
		const at = offset - this.startOffset;
		if (this.buffer.subarray(at, at + data.length).equals(data))
			return;
		this.buffer.fill(data, at, at + data.length);
		this.isModified = true;
		this.progress(data.length, this.buffer.length);
	}

	async flush(): Promise<void> {}

	async abort(): Promise<void> {
		this.isModified = false;
	}

	getMemorySize(): number {
		return this.buffer.length;
	}

	getMemoryStart(): number {
		return this.startOffset;
	}

	getUniqueName(): string {
		return `fulldump_${this.startOffset.toString(16)}`;
	}

	private checkBounds(offset: number, size: number): void {
		if (offset < this.startOffset || offset + size > this.startOffset + this.buffer.length)
			throw new Error(
				`Offset 0x${(offset >>> 0).toString(16)} (size 0x${size.toString(16)}) is outside of the dump ` +
				`0x${this.startOffset.toString(16)}-0x${(this.startOffset + this.buffer.length).toString(16)}.`
			);
	}
}
