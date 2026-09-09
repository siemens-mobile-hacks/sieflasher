// Fullflash dump file as a device (port of VDeviceFile from VDeviceFile.cpp).

import { Buffer } from "buffer";
import { FlasherDevice } from "./device.js";

export class FullFlashDevice extends FlasherDevice {
	private buffer: Buffer;
	private readonly partAddr: number;
	private isModified = false;

	constructor(buffer: Buffer, partAddr: number) {
		super();
		this.buffer = buffer;
		this.partAddr = partAddr;
	}

	get address(): number {
		return this.partAddr;
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

	async read(addr: number, size: number): Promise<Uint8Array> {
		this.checkBounds(addr, size);
		return this.buffer.subarray(addr - this.partAddr, addr - this.partAddr + size);
	}

	async write(addr: number, data: Uint8Array): Promise<void> {
		this.checkBounds(addr, data.length);
		const offset = addr - this.partAddr;
		if (this.buffer.subarray(offset, offset + data.length).equals(data))
			return;
		this.buffer.fill(data, offset, offset + data.length);
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
		return this.partAddr;
	}

	getUniqueName(): string {
		return `fulldump_${this.partAddr.toString(16)}`;
	}

	private checkBounds(addr: number, size: number): void {
		if (addr < this.partAddr || addr + size > this.partAddr + this.buffer.length)
			throw new Error(
				`Address 0x${(addr >>> 0).toString(16)} (size 0x${size.toString(16)}) is outside of the dump ` +
				`0x${this.partAddr.toString(16)}-0x${(this.partAddr + this.buffer.length).toString(16)}.`
			);
	}
}
