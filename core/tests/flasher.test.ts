import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { FlasherTransport } from '../src/transport.js';
import { FlasherDevice } from '../src/device.js';
import { parseVkd, VkdBoot } from '../src/vkd.js';
import { PhoneDevice, xorChecksum, wordChecksum } from '../src/phone.js';
import { FullFlashDevice } from '../src/fullflash.js';
import { applyVkpToDevice, makeRepairPatchFileName, makeRepairPatchText } from '../src/vkp.js';
import { vkpNormalize, vkpParse } from '@sie-js/vkp';
import { MemCache } from '../src/memcache.js';
import { IniFile } from '../src/ini.js';
import { parseVkdData, parseEscapeString } from '../src/data.js';
import { diffBuffers, diffEraseStats, diffRegionPreviews } from '../src/diff.js';

// A minimal V_KLay driver for the S55-like phone (loader protocol v1)
const VKD_S55 = `
[PhoneCommonInfo]
Name=Test Phone
MCUMemGeometry=0x400000: 0x020000, 0x800000: 0x010000
optReadCmdSkipBytesAfterData=0
optReadCmdSkipBytesAfterCheckSum=2

[Phone01]
Name=S55
Type=Test
Boots=Connect, GoBoot.bin, InitBoot.bin, LoadBoot.bin, AllBoot.bin
MCUMemFuBu= fullflash, 0x400000, 0xC00000
MCUMemArea01= bootcore, 0x800000, 0x010000, bootcore
MCUMemArea02= eeprom, 0xFE0000, 0x020000

[Boot01]
Name=Connect
UseIgnition=1
TryCount=5
NoSendLen=1
Data=0sAT
NoSendCheckSum=1
Answer=B0
AnswerTimeout=100

[Boot02]
Name=GoBoot.bin
NoSendLen=1
Data=A55AA5A5
NoSendCheckSum=1
Answer=A5

[Boot03]
Name=InitBoot.bin
NoSendLen=1
Data=11223344
NoSendCheckSum=1
Answer=A5

[Boot04]
Name=LoadBoot.bin
NoSendLen=1
Data=55667788
NoSendCheckSum=1
Answer=A6

[Boot05]
Name=AllBoot.bin
NoSendLen=1
Data=AABBCCDD
NoSendCheckSum=1
Answer=0sOK
`;

// A minimal x65-like driver (loader protocol v2)
const VKD_X65 = `
[PhoneCommonInfo]
Name=x65 Phone
MCUMemGeometry=0
optBaudCmdCodes=57600: 0x00, 115200: 0x01, 230400: 0x02
optCmdAddrAndSizeLen=4
optWriteCmdVersion=2
optTestEmptyCmdEnable=1
optKeepAliveCmdEnableAndSetInterval=250
optAuthorization=1

[Phone01]
Name=S65
Type=Test
Boots=Connect, GoBoot.bin, ChaosBoot.bin
MCUMemFuBu= fullflash, 0xA0000000, 0x02000000
MCUMemArea01= bootcore, 0xA0000000, 0x00020000, bootcore
MCUMemArea02= EEFULL, 0xA0220000, 0x00040000

[Boot01]
Name=Connect
UseIgnition=1
TryCount=-1
NoSendLen=1
Data=0sAT
NoSendCheckSum=1
Answer=B0
AnswerTimeout=100

[Boot02]
Name=GoBoot.bin
NoSendLen=1
Data=30
NoSendCheckSum=1

[Boot03]
Name=ChaosBoot.bin
SizeLen=2
Data=0011
Answer=B1
`;

// ---------------------------------------------------------------------
// Mock phone implementing the V1 loader protocol (Freia-style loaders)
class MockPhoneV1 {
	flash: Buffer;
	readonly opts: { skipAfterData: number; skipAfterChecksum: number };
	#rxQueue: Buffer = Buffer.alloc(0);
	#baudAckPending = false;
	#writes: { addr: number; data: Buffer }[] = [];
	#bootAnswers: Map<string, Buffer> = new Map([
		["4154", Buffer.from([0xB0])], // Connect: "AT" -> 0xB0
		["a55aa5a5", Buffer.from([0xA5])], // GoBoot.bin
		["11223344", Buffer.from([0xA5])], // InitBoot.bin
		["55667788", Buffer.from([0xA6])], // LoadBoot.bin
		["aabbccdd", Buffer.from("OK", "latin1")], // AllBoot.bin
	]);
	connected = false;
	speedChangedTo?: number;

	constructor(base: number, size: number, opts = { skipAfterData: 0, skipAfterChecksum: 2 }) {
		this.flash = Buffer.alloc(base + size, 0xFF);
		this.opts = opts;
		this.base = base;
		// Fill some pattern
		for (let i = base; i < this.flash.length; i += 4)
			this.flash.writeUInt32LE(i, i);
	}
	readonly base: number;

	get writes() {
		return this.#writes;
	}

	reset() {
		this.#rxQueue = Buffer.alloc(0);
	}

	#dataState: { addr: number; size: number; buf: Buffer } | null = null;

	// Emulator of the phone side: process a chunk written by the device.
	async handleWrite(data: Uint8Array): Promise<Buffer> {
		// Boot phase: respond to the raw boot payloads.
		const buf = Buffer.from(data);
		const hex = buf.toString("hex");
		if (!this.#dataState) {
			const bootAnswer = this.#bootAnswers.get(hex);
			if (bootAnswer)
				return bootAnswer;
		}

		// Write command data phase: accumulate the block data + checksum byte.
		if (this.#dataState) {
			const st = this.#dataState;
			st.buf = Buffer.concat([st.buf, buf.subarray(0, st.size + 1 - st.buf.length)]);
			if (st.buf.length == st.size + 1) {
				this.#dataState = null;
				return this.handleWriteData(st.addr, st.size, st.buf.subarray(0, st.size));
			}
			return Buffer.alloc(0);
		}

		this.#rxQueue = Buffer.concat([this.#rxQueue, buf]);
		return this.#process();
	}

	#take(n: number): Buffer | undefined {
		if (this.#rxQueue.length >= n) {
			const chunk = this.#rxQueue.subarray(0, n);
			this.#rxQueue = this.#rxQueue.subarray(n);
			return Buffer.from(chunk);
		}
		return undefined;
	}

	#process(): Buffer {
		if (!this.#rxQueue.length)
			return Buffer.alloc(0);
		const cmd = String.fromCharCode(this.#rxQueue[0]);
		switch (cmd) {
			case "A": {
				if (!this.#take(1)) return Buffer.alloc(0);
				if (this.#baudAckPending) {
					this.#baudAckPending = false;
					return Buffer.from("H", "latin1");
				}
				return Buffer.from("R", "latin1");
			}
			case "H": {
				if (!this.#take(2)) return Buffer.alloc(0);
				this.#baudAckPending = true;
				return Buffer.from("h", "latin1");
			}
			case "I": {
				if (!this.#take(1)) return Buffer.alloc(0);
				const info = Buffer.alloc(224);
				info.write("SIEMENS", 0x30, "latin1");
				info.write("S55", 0x20, "latin1");
				info.write("lgp", 0x10, "latin1");
				info[0] = 0x20; // fw version
				info.writeUInt32LE(0x12345678, 0xB0);
				info.writeUInt32LE(0x9ABCDEF0, 0xB4);
				return info;
			}
			case "R": {
				const cmdBuf = this.#take(7); // 'R' + addr(3) + size(3)
				if (!cmdBuf) return Buffer.alloc(0);
				const addr = (cmdBuf[1] << 16) | (cmdBuf[2] << 8) | cmdBuf[3];
				const size = (cmdBuf[4] << 16) | (cmdBuf[5] << 8) | cmdBuf[6];
				const data = this.flash.subarray(addr, addr + size);
				// Freia-style answer: data + checksum(2) + junk(2), no "OK"
				return Buffer.concat([
					data,
					Buffer.from([xorChecksum(data), 0]),
					Buffer.alloc(this.opts.skipAfterChecksum, 0xAA),
				]);
			}
			case "F": {
				const cmdBuf = this.#take(3); // 'F' + addr (2 bytes, 4k units, relative to the flash base)
				if (!cmdBuf) return Buffer.alloc(0);
				const addr = this.base + cmdBuf.readUInt16BE(1) * 0x1000;
				this.#dataState = { addr, size: 0x10000, buf: Buffer.alloc(0) };
				// 10-byte addr answer + blockSize (0x10 = 64k) + id 0xFFFF
				return Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10, 0x00, 0xFF, 0xFF]);
			}
			default:
				return Buffer.alloc(0);
		}
	}

	// V1 write data phase: called by the transport when data arrives after the F command.
	async handleWriteData(addr: number, size: number, data: Buffer): Promise<Buffer> {
		this.#writes.push({ addr, data: Buffer.from(data) });
		data.copy(this.flash, addr);
		const crc = wordChecksum(data);
		const crcBuf = Buffer.alloc(2);
		crcBuf.writeUInt16LE(crc);
		return Buffer.concat([
			Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), // data answer
			Buffer.from([0x02, 0x02]), // erase ack
			Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), // write start ack
			Buffer.from([0x03, 0x03]), // write ack
			crcBuf,
			Buffer.from("OK", "latin1"),
		]);
	}
}

// Mock transport that connects PhoneDevice to MockPhoneV1
class MockTransportV1 implements FlasherTransport {
	phone: MockPhoneV1;
	baudrate = 115200;
	signals = { dtr: true, rts: true };
	isClosed = false;

	constructor(phone: MockPhoneV1) {
		this.phone = phone;
	}

	async write(data: Uint8Array): Promise<void> {
		this.#pendingAnswers.push(await this.phone.handleWrite(data));
	}

	#pendingAnswers: Buffer[] = [];
	#rxBuffer: Buffer = Buffer.alloc(0);

	#pollRx(): Buffer {
		if (this.#pendingAnswers.length) {
			this.#rxBuffer = Buffer.concat([this.#rxBuffer, ...this.#pendingAnswers.splice(0)]);
		}
		return this.#rxBuffer;
	}

	async read(size: number, timeoutMS: number): Promise<Buffer | undefined> {
		// Fast mock: max 50ms wait, return available data after 10ms of silence.
		const deadline = Date.now() + Math.min(timeoutMS, 50);
		let lastLen = -1;
		let lastChange = Date.now();
		let available = this.#pollRx();
		while (available.length < size && Date.now() < deadline) {
			if (available.length != lastLen) {
				lastLen = available.length;
				lastChange = Date.now();
			} else if (Date.now() - lastChange > 10) {
				break; // No new data for 10ms - the phone stopped sending
			}
			await new Promise((resolve) => setTimeout(resolve, 1));
			available = this.#pollRx();
		}
		if (!available.length)
			return undefined;
		const result = Buffer.from(available.subarray(0, Math.min(size, available.length)));
		this.#rxBuffer = available.subarray(result.length);
		return result;
	}

	async readByte(timeoutMS: number): Promise<number> {
		const data = await this.read(1, timeoutMS);
		return data && data.length ? data[0] : -1;
	}

	async skipData(timeoutMS: number, maxCount?: number): Promise<number> {
		if (maxCount === 0)
			return 0;
		// Instantly consume everything
		let skipped = this.#rxBuffer.length;
		this.#rxBuffer = Buffer.alloc(0);
		skipped += this.#pendingAnswers.reduce((acc, b) => acc + b.length, 0);
		this.#pendingAnswers.splice(0);
		if (maxCount !== undefined && maxCount != -1)
			return Math.min(maxCount, skipped);
		return skipped;
	}

	async updateBaudrate(baudrate: number): Promise<void> {
		this.baudrate = baudrate;
	}

	getBaudrate(): number {
		return this.baudrate;
	}

	async setSignals(signals: { dtr?: boolean; rts?: boolean }): Promise<void> {
		Object.assign(this.signals, signals);
	}

	async flush(): Promise<void> {
		this.#pendingAnswers.splice(0);
	}

	async close(): Promise<void> {
		this.isClosed = true;
	}
}

test("vkd data value parsing", () => {
	assert.deepEqual(parseVkdData("0sAT"), Buffer.from([0x41, 0x54]));
	assert.deepEqual(parseVkdData("0sAT\\r\\n\\xFF"), Buffer.from([0x41, 0x54, 0x0D, 0x0A, 0xFF]));
	assert.deepEqual(parseVkdData("A55AA5A5"), Buffer.from([0xA5, 0x5A, 0xA5, 0xA5]));
	assert.deepEqual(parseVkdData("120000EA,00000000"), Buffer.from([0x12, 0x00, 0x00, 0xEA, 0x00, 0x00, 0x00, 0x00]));
	assert.deepEqual(parseVkdData("0xFF"), Buffer.from([0xFF]));
	assert.deepEqual(parseVkdData("0b10110"), Buffer.from([0x16]));
	assert.deepEqual(parseEscapeString("a\\x41b"), Buffer.from([0x61, 0x41, 0x62]));
});

test("ini parsing", () => {
	const ini = IniFile.parse("[Sec]\r\nkey = value\r\n; whole line comment\r\n[Sec2]\nfoo=bar");
	assert.equal(ini.getString("Sec", "key"), "value");
	assert.equal(ini.getString("sec2", "foo"), "bar");
	assert.equal(ini.getString("Sec", "missing"), undefined);
	assert.equal(ini.getString("Sec", "missing", "def"), "def");
});

test("vkd parsing", () => {
	const vkd = parseVkd(VKD_S55);
	assert.equal(vkd.phones.length, 1);
	const phone = vkd.phones[0];
	assert.equal(phone.name, "S55");
	assert.equal(phone.fullflash.addr, 0x400000);
	assert.equal(phone.fullflash.size, 0xC00000);
	assert.equal(phone.memAreas.length, 3);
	assert.ok(phone.memAreas[1].isBootcore);
	assert.deepEqual(phone.memGeometry, [
		{ startAddr: 0x400000, pageSize: 0x20000 },
		{ startAddr: 0x800000, pageSize: 0x10000 },
	]);
	assert.equal(phone.opts.cmdAddrAndSizeLen, 3);
	assert.equal(phone.opts.writeCmdVersion, 1);
	assert.equal(phone.opts.readCmdSkipBytesAfterCheckSum, 2);
	assert.ok(vkd.getBoot("goboot.BIN")); // case-insensitive
});

test("memcache geometry", () => {
	const cache = new MemCache();
	cache.setMemAreaStart(0x400000);
	cache.setGeometry([
		{ startAddr: 0x400000, pageSize: 0x20000 },
		{ startAddr: 0x800000, pageSize: 0x10000 },
	]);
	assert.equal(cache.pageSizeAtAddr(0), 0x20000);
	assert.equal(cache.pageSizeAtAddr(0x3FFFF), 0x20000);
	assert.equal(cache.pageSizeAtAddr(0x400000), 0x10000);
	const page1 = cache.getPageAtAddr(0x10000)!;
	assert.equal(page1.page.addr, 0);
	assert.equal(page1.page.size, 0x20000);
	assert.ok(page1.isNew);
	const page2 = cache.getPageAtAddr(0x12345)!;
	assert.equal(page2.page.addr, 0);
	assert.ok(!page2.isNew);
	const page3 = cache.getPageAtAddr(0x20000)!;
	assert.equal(page3.page.addr, 0x20000);
	assert.equal(page3.page.size, 0x20000);
	assert.ok(page3.isNew);
});

test("phone device v1: boot, read, write", async () => {
	const vkd = parseVkd(VKD_S55);
	const phone = vkd.phones[0];
	const mock = new MockPhoneV1(0x400000, 0xC00000);
	const transport = new MockTransportV1(mock);
	const device = new PhoneDevice(transport, phone, vkd.boots);


	let statuses: string[] = [];
	device.onProgress = undefined;
	(device as any).opts.onStatus = (s: string) => statuses.push(s);

	await device.open(115200);
	assert.ok(device.connected);

	// Reading (read()/write() take the device addresses of getMemoryStart(),
	// the flash offsets are readMemory()/writeMemory()).
	const data = await device.read(0x400100, 0x100);
	assert.equal(data.length, 0x100);
	assert.deepEqual(Buffer.from(data), mock.flash.subarray(0x400100, 0x400200));

	// Writing: 0x30000 spans two cache pages of 0x20000, the second page is
	// flushed entirely (page-granularity writes, as in V_KLay) => 4 x 64k blocks.
	const pattern = Buffer.alloc(0x30000, 0xAB);
	await device.write(0x400000, pattern);
	await device.flush();
	assert.equal(mock.writes.length, 4);
	for (const w of mock.writes) {
		assert.equal(w.data.length, 0x10000);
	}
	assert.ok(mock.flash.subarray(0x400000, 0x430000).equals(pattern));

	await device.disconnect();
});

test("phone device: device addresses and flash offsets", async () => {
	// read()/write() of the FlasherDevice interface take the device addresses
	// (getMemoryStart()..), like FullFlashDevice does; readAtOffset() /
	// readMemory() take the flash offsets the loader itself uses.
	const vkd = parseVkd(VKD_S55);
	const phone = vkd.phones[0];
	const mock = new MockPhoneV1(0x400000, 0xC00000);
	const device = new PhoneDevice(new MockTransportV1(mock), phone, vkd.boots);
	await device.open();

	assert.equal(device.getMemoryStart(), 0x400000);
	const expected = mock.flash.subarray(0x400100, 0x400200);
	assert.deepEqual(Buffer.from(await device.read(0x400100, 0x100)), Buffer.from(expected));
	assert.deepEqual(Buffer.from(await device.readAtOffset(0x100, 0x100)), Buffer.from(expected));
	assert.deepEqual(Buffer.from(await device.readMemory(0x100, 0x100)), Buffer.from(expected));

	// The flash offset of a device address is not a device address itself.
	await assert.rejects(() => device.read(0x100, 0x10), /outside of the phone memory/);
	await assert.rejects(() => device.read(0x400000 + 0xC00000, 0x10), /outside of the phone memory/);
	await assert.rejects(() => device.write(0x100, Buffer.alloc(4)), /outside of the phone memory/);

	// A patch applies to the phone device without any address juggling by the
	// caller: the patch addresses are flash offsets, like in V_KLay.
	const patched = Buffer.from(mock.flash.subarray(0x410000, 0x410004));
	const vkp = vkpParse(`0x010000: ${patched.toString("hex").toUpperCase()} DEADBEEF\r\n`);
	const result = await applyVkpToDevice(device, vkp, {});
	assert.ok(result.ok, result.reports.map((r) => r.reason).join("\n"));
	assert.equal(result.written, 4);
	assert.deepEqual(Buffer.from(mock.flash.subarray(0x410000, 0x410004)), Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]));

	await device.disconnect();
});

test("phone device: bootcore write skip", async () => {
	const vkd = parseVkd(VKD_S55);
	const phone = vkd.phones[0];
	const mock = new MockPhoneV1(0x400000, 0xC00000);
	const transport = new MockTransportV1(mock);
	const device = new PhoneDevice(transport, phone, vkd.boots, { skipBootcore: true });
	await device.open();

	// The bootcore area is at 0x800000-0x810000, flash page there = 0x10000
	const pattern = Buffer.alloc(0x10000, 0xCD);
	await device.write(0x800000, pattern);
	await device.flush();
	// No write must happen (bootcore skip)
	assert.equal(mock.writes.length, 0);
	await device.disconnect();
});

test("fullflash device", async () => {
	const buf = Buffer.alloc(0x20000, 0xFF);
	buf.write("HELLO", 0x100, "latin1");
	const device = new FullFlashDevice(buf, 0x400000);
	await device.open();
	const data = await device.read(0x400100, 5);
	assert.equal(Buffer.from(data).toString("latin1"), "HELLO");

	await assert.rejects(() => device.read(0x400000 + 0x20000, 1));

	await device.write(0x400000, Buffer.from([1, 2, 3, 4]));
	assert.deepEqual(Buffer.from(buf.subarray(0, 4)), Buffer.from([1, 2, 3, 4]));
});

test("vkp apply to fullflash", async () => {
	const buf = Buffer.alloc(0x10000, 0xFF);
	const device = new FullFlashDevice(buf, 0x400000);
	await device.open();

	const vkp = {
		valid: true,
		warnings: [],
		errors: [],
		writes: [
			{
				addr: 0x400100,
				size: 4,
				old: Buffer.from([0xFF, 0xFF, 0xFF, 0xFF]),
				new: Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]),
				loc: { line: 1, column: 1 },
				pragmas: {
					warn_no_old_on_apply: false,
					warn_if_new_exist_on_apply: false,
					warn_if_old_exist_on_undo: false,
					undo: false,
					old_equal_ff: false,
				},
			},
		],
	} as any;

	const result = await applyVkpToDevice(device, vkp, {});
	assert.ok(result.ok);
	assert.ok(!result.alreadyDone);
	assert.equal(result.written, 4);
	assert.deepEqual(Buffer.from(buf.subarray(0x100, 0x104)), Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]));

	// Applying again reports "already applied"
	const result2 = await applyVkpToDevice(device, vkp, {});
	assert.ok(result2.alreadyDone);
	assert.equal(result2.written, 0);

	// Revert
	const result3 = await applyVkpToDevice(device, vkp, { revert: true });
	assert.ok(result3.ok);
	assert.equal(result3.written, 4);
	assert.deepEqual(Buffer.from(buf.subarray(0x100, 0x104)), Buffer.from([0xFF, 0xFF, 0xFF, 0xFF]));
});

test("vkp apply with mismatched old data", async () => {
	const buf = Buffer.alloc(0x100, 0x00);
	const device = new FullFlashDevice(buf, 0x400000);
	await device.open();

	const vkp = {
		valid: true,
		warnings: [],
		errors: [],
		writes: [
			{
				addr: 0x400010,
				size: 2,
				old: Buffer.from([0xFF, 0xFF]),
				new: Buffer.from([0x11, 0x22]),
				loc: { line: 1, column: 1 },
				pragmas: {},
			},
		],
	} as any;

	const result = await applyVkpToDevice(device, vkp, {});
	assert.ok(!result.ok);
	assert.equal(result.written, 0);

	// Forced apply works
	const result2 = await applyVkpToDevice(device, vkp, { force: true });
	assert.ok(result2.ok);
	assert.equal(result2.written, 2);
});

// ---------------------------------------------------------------------
// V_KLay repair patch (CPatchPage::RepairPatchSave): when the old data does
// not match (or the patch has no old data at all) and the user confirms, a
// repair patch is saved before anything is written; undoing it restores the
// original device data.

const makeWrite = (addr: number, old: Buffer | undefined, neu: Buffer, line = 7) => ({
	addr, size: neu.length, old, new: neu,
	loc: { line, column: 1 },
	pragmas: {},
});

const makeVkp = (writes: any[]) => ({ valid: true, warnings: [], errors: [], writes } as any);

test("vkp repair patch: confirmed mismatch saves a working restore patch", async () => {
	const buf = Buffer.alloc(0x100, 0x00);
	buf[0x10] = 0xAB; buf[0x11] = 0xCD;   // device data differs from the patch old data
	const device = new FullFlashDevice(buf, 0x400000);
	await device.open();

	const vkp = makeVkp([makeWrite(0x400010, Buffer.from([0xFF, 0xFF]), Buffer.from([0x11, 0x22]))]);
	const infos: any[] = [];
	const saved: { text: string; fileName: string }[] = [];

	const result = await applyVkpToDevice(device, vkp, {
		patchName: "test.vkp",
		patchText: "; test patch\n0x400010: FFFF 1122\n",
		confirmMismatch: (info) => {
			infos.push(info);
			return true;
		},
		saveRepairPatch: (text, fileName) => {
			saved.push({ text, fileName });
			return fileName;
		},
	});

	// The mismatch was reported like V_KLay's msgOldExist message box.
	assert.equal(infos.length, 1);
	assert.equal(infos[0].mismatchCount, 1);
	assert.equal(infos[0].totalWrites, 1);
	assert.equal(infos[0].addr, 0x400010);
	assert.equal(infos[0].deviceByte, 0xAB);
	assert.equal(infos[0].oldByte, 0xFF);
	assert.equal(infos[0].newByte, 0x11);
	assert.equal(infos[0].line, 7);

	// The write was performed (writenewanyway) and the repair patch saved first.
	assert.ok(result.ok);
	assert.ok(!result.cancelled);
	assert.equal(result.written, 2);
	assert.deepEqual(Buffer.from(buf.subarray(0x10, 0x12)), Buffer.from([0x11, 0x22]));
	assert.equal(saved.length, 1);
	assert.equal(saved[0].fileName, "test_REPAIR.vkp");
	assert.equal(result.repairPatch!.savedAs, "test_REPAIR.vkp");

	// The repair patch text is a valid VKP patch (V_KLay format).
	const text = result.repairPatch!.text;
	assert.ok(text.includes("*** REPAIR PATCH ***"));
	assert.ok(text.includes("Press \"Undo Patch\" button to repair phone."));
	assert.ok(text.includes(";  test.vkp"));
	assert.ok(text.includes("#pragma disable warn_if_old_exist_on_undo"));
	assert.ok(text.includes(";different phone data and old data from the patch:"));
	assert.ok(text.includes("400010: ABCD" + " ".repeat(28) + " 1122" + " ".repeat(28) + " ;FFFF"));
	assert.ok(text.includes(";0x400010: FFFF 1122"));   // the patch text is embedded commented

	// Undoing the repair patch restores the original data.
	const repair = vkpParse(text, { allowEmptyOldData: true });
	assert.ok(repair.valid, JSON.stringify(repair.errors));
	assert.equal(repair.writes.length, 1);
	assert.deepEqual(Buffer.from(repair.writes[0].old!), Buffer.from([0xAB, 0xCD]));
	assert.deepEqual(Buffer.from(repair.writes[0].new), Buffer.from([0x11, 0x22]));
	const undo = await applyVkpToDevice(device, repair, { revert: true });
	assert.ok(undo.ok);
	assert.equal(undo.written, 2);
	assert.deepEqual(Buffer.from(buf.subarray(0x10, 0x12)), Buffer.from([0xAB, 0xCD]));
});

test("vkp repair patch: declining the mismatch cancels the operation", async () => {
	const buf = Buffer.alloc(0x100, 0x00);
	const device = new FullFlashDevice(buf, 0x400000);
	await device.open();

	const vkp = makeVkp([makeWrite(0x400010, Buffer.from([0xFF, 0xFF]), Buffer.from([0x11, 0x22]))]);
	const result = await applyVkpToDevice(device, vkp, {
		confirmMismatch: () => false,
		saveRepairPatch: () => "repair.vkp",
	});

	assert.ok(!result.ok);
	assert.ok(result.cancelled);
	assert.equal(result.written, 0);
	assert.equal(result.repairPatch, undefined);
	assert.deepEqual(Buffer.from(buf.subarray(0x10, 0x12)), Buffer.from([0x00, 0x00]));
});

test("vkp repair patch: cancelling the repair patch save aborts", async () => {
	const buf = Buffer.alloc(0x100, 0x00);
	const device = new FullFlashDevice(buf, 0x400000);
	await device.open();

	const vkp = makeVkp([makeWrite(0x400010, Buffer.from([0xFF, 0xFF]), Buffer.from([0x11, 0x22]))]);
	const result = await applyVkpToDevice(device, vkp, {
		confirmMismatch: () => true,
		saveRepairPatch: () => false,
	});

	// V_KLay: o_bIsRepairPatchCanSkip=FALSE - cancelling "Save Repair Patch
	// As..." cancels the whole operation.
	assert.ok(!result.ok);
	assert.ok(result.cancelled);
	assert.equal(result.written, 0);
	assert.equal(result.repairPatch, undefined);
	assert.deepEqual(Buffer.from(buf.subarray(0x10, 0x12)), Buffer.from([0x00, 0x00]));
});

test("vkp repair patch: patch without old data (undo impossible)", async () => {
	const buf = Buffer.alloc(0x100, 0xEE);
	const device = new FullFlashDevice(buf, 0x400000);
	await device.open();

	const vkp = makeVkp([makeWrite(0x400020, undefined, Buffer.from([0x11, 0x22]))]);
	let confirmed = false;
	const result = await applyVkpToDevice(device, vkp, {
		patchName: "noold.vkp",
		confirmNoOld: () => {
			confirmed = true;
			return true;
		},
		saveRepairPatch: (text) => text.length > 0 ? "noold_REPAIR.vkp" : false,
	});

	assert.ok(confirmed);
	assert.ok(result.ok);
	assert.equal(result.written, 2);
	assert.deepEqual(Buffer.from(buf.subarray(0x20, 0x22)), Buffer.from([0x11, 0x22]));

	// The repair patch has the original device data as the old data, so the
	// undo becomes possible through it (m_OldData is filled from the phone).
	const repair = vkpParse(result.repairPatch!.text, { allowEmptyOldData: true });
	assert.ok(repair.valid);
	assert.deepEqual(Buffer.from(repair.writes[0].old!), Buffer.from([0xEE, 0xEE]));
	assert.deepEqual(Buffer.from(repair.writes[0].new), Buffer.from([0x11, 0x22]));
	const undo = await applyVkpToDevice(device, repair, { revert: true });
	assert.ok(undo.ok);
	assert.deepEqual(Buffer.from(buf.subarray(0x20, 0x22)), Buffer.from([0xEE, 0xEE]));

	// Declining the warning cancels before anything is read or written.
	const device2 = new FullFlashDevice(buf, 0x400000);
	await device2.open();
	const result2 = await applyVkpToDevice(device2, vkp, { confirmNoOld: () => false });
	assert.ok(!result2.ok);
	assert.ok(result2.cancelled);
	assert.equal(result2.written, 0);
});

test("vkp repair patch: forced undo with mismatched patched data", async () => {
	// The phone data is neither the patched nor the original data.
	const buf = Buffer.alloc(0x100, 0x00);
	buf[0x30] = 0x55; buf[0x31] = 0x66;
	const device = new FullFlashDevice(buf, 0x400000);
	await device.open();

	const vkp = makeVkp([makeWrite(0x400030, Buffer.from([0xFF, 0xFF]), Buffer.from([0x11, 0x22]))]);
	const result = await applyVkpToDevice(device, vkp, {
		revert: true,
		confirmMismatch: () => true,
		saveRepairPatch: (text, fileName) => fileName,
	});

	assert.ok(result.ok);
	assert.equal(result.written, 2);
	assert.deepEqual(Buffer.from(buf.subarray(0x30, 0x32)), Buffer.from([0xFF, 0xFF]));

	// Undoing the repair patch restores the data the phone really had.
	const repair = vkpParse(result.repairPatch!.text, { allowEmptyOldData: true });
	assert.ok(repair.valid);
	const undo = await applyVkpToDevice(device, repair, { revert: true });
	assert.ok(undo.ok);
	assert.deepEqual(Buffer.from(buf.subarray(0x30, 0x32)), Buffer.from([0x55, 0x66]));
});

test("vkp repair patch: undo of a patch without old data skips the writes", async () => {
	const buf = Buffer.alloc(0x100, 0x00);
	buf[0x40] = 0x11; buf[0x41] = 0x22;
	const device = new FullFlashDevice(buf, 0x400000);
	await device.open();

	// A write without old data cannot be undone: after the confirmed
	// warning it is skipped (like V_KLay counts it into existNewCounter),
	// and a repair patch is saved.
	const vkp = makeVkp([makeWrite(0x400040, undefined, Buffer.from([0x11, 0x22]))]);
	const result = await applyVkpToDevice(device, vkp, {
		revert: true,
		confirmNoOld: () => true,
		saveRepairPatch: (text, fileName) => fileName,
	});

	assert.ok(result.ok);
	assert.equal(result.written, 0);
	assert.equal(result.reports.length, 1);
	assert.equal(result.reports[0].status, "skipped");
	assert.ok(result.reports.every((r) => r.status == "skipped"));
});

test("vkp repair patch: V_KLay line format (16-byte aligned columns)", () => {
	// 32-char hex column with the bytes placed at their offset inside the
	// 16-byte block (VPatchBlock::MakeTextLine ident).
	const col = (hex: string, ident: number) =>
		" ".repeat(ident) + hex + " ".repeat(32 - ident - hex.length);
	const line = (addr: number, oldHex: string, newHex: string, commHex: string, ident: number) =>
		addr.toString(16).toUpperCase().padStart(6, "0") + ": " +
		col(oldHex, ident) + " " + col(newHex, ident) + " ;" + col(commHex, ident);

	const text = makeRepairPatchText({
		action: "apply",
		patchName: "fmt.vkp",
		entries: [{
			addr: 0x400105,
			device: Buffer.from([0xAA, 0xBB, 0xCC]),
			written: Buffer.from([0xDD, 0xEE, 0xFF]),
			expected: Buffer.from([0x11, 0x22, 0x33]),
		}],
	});
	const lines = text.split("\r\n");
	// The different section: 3 bytes at offset 5 of the 16-byte block - each
	// column carries 10 spaces, then the data.
	const dataLine = line(0x400105, "AABBCC", "DDEEFF", "112233", 10);
	assert.ok(lines.includes(dataLine), lines.join("\n"));
	// The same section is empty (the device data differs everywhere).
	const sameIdx = lines.indexOf(";same phone data and old data from the patch:");
	assert.ok(sameIdx > 0);
	assert.ok(!lines.slice(sameIdx).includes(dataLine));

	// Mixed data is split into the different/same sections (runs never cross
	// a 16-byte boundary).
	const mixed = makeRepairPatchText({
		action: "apply",
		entries: [{
			addr: 0x10,
			device: Buffer.from([1, 2, 3, 4]),
			written: Buffer.from([5, 6, 7, 8]),
			expected: Buffer.from([1, 2, 9, 9]),
		}],
	});
	const mixedLines = mixed.split("\r\n");
	// bytes 0..1 equal (same section), bytes 2..3 differ (different section)
	assert.ok(mixedLines.includes(line(0x10, "0102", "0506", "0102", 0)), mixedLines.join("\n"));
	assert.ok(mixedLines.includes(line(0x12, "0304", "0708", "0909", 4)), mixedLines.join("\n"));
	assert.ok(mixedLines.indexOf(line(0x12, "0304", "0708", "0909", 4))
		< mixedLines.indexOf(";same phone data and old data from the patch:")!);

	// File names: V_KLay's RepairPatchGetFileName()
	assert.equal(makeRepairPatchFileName("patch.vkp"), "patch_REPAIR.vkp");
	assert.equal(makeRepairPatchFileName("my.patch.txt"), "my.patch_REPAIR.txt");
	assert.equal(makeRepairPatchFileName("noext"), "noext_REPAIR.vkp");
	assert.match(makeRepairPatchFileName(), /^Patch_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_REPAIR\.vkp$/);
});

test("vkp apply: flash-relative patch addresses (x65/x75 patch form)", async () => {
	// x65/x75 phones: the flash is at 0xA0000000 and the patches use offsets
	// from the flash start (V_KLay: "address 0xA15C0000 is 0x015C0000",
	// so the user's 0x00A165E8 is the CPU address 0xA0A165E8).
	const buf = Buffer.alloc(0x2000000, 0xFF);
	buf.write("CODE", 0xA165E8, "latin1");
	const device = new FullFlashDevice(buf, 0xA0000000);
	await device.open();

	const makeVkp = (addr: number) => ({
		valid: true,
		warnings: [],
		errors: [],
		writes: [{
			addr,
			size: 4,
			old: Buffer.from("CODE", "latin1"),
			new: Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]),
			loc: { line: 1, column: 1 },
			pragmas: {},
		}],
	} as any);

	// The offset form (the user's patch style) must apply at the right place.
	const result = await applyVkpToDevice(device, makeVkp(0xA165E8), {});
	assert.ok(result.ok);
	assert.ok(!result.alreadyDone);
	assert.equal(result.written, 4);
	assert.deepEqual(Buffer.from(buf.subarray(0xA165E8, 0xA165EC)), Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]));

	// The absolute form addresses the same location and undoes it.
	const result2 = await applyVkpToDevice(device, makeVkp(0xA0A165E8), { revert: true });
	assert.ok(result2.ok);
	assert.equal(result2.written, 4);
	assert.deepEqual(Buffer.from(buf.subarray(0xA165E8, 0xA165EC)), Buffer.from("CODE", "latin1"));

	// Addresses that fit the flash neither as absolute nor as offsets
	// are still rejected.
	const result3 = await applyVkpToDevice(device, makeVkp(0x3000000), { dryRun: true });
	assert.ok(!result3.ok);
	assert.ok(!result3.alreadyDone);
	assert.equal(result3.reports.filter((r) => r.status == "error").length, 1);
});

test("vkp apply: patch with errors is not reported as already applied", async () => {
	const buf = Buffer.alloc(0x10000, 0xFF);
	const device = new FullFlashDevice(buf, 0x400000);
	await device.open();

	const write = (addr: number) => ({
		addr,
		size: 4,
		old: Buffer.from([0xFF, 0xFF, 0xFF, 0xFF]),
		new: Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]),
		loc: { line: 1, column: 1 },
		pragmas: {},
	});

	// All writes are outside of the flash: a bad patch for this device.
	const badVkp = {
		valid: true,
		warnings: [],
		errors: [],
		writes: [write(0x74000), write(0x74004), write(0x74008)],
	} as any;
	const result = await applyVkpToDevice(device, badVkp, { dryRun: true });
	assert.ok(!result.ok);
	assert.ok(!result.alreadyDone, "a bad patch must not be reported as already applied");
	assert.equal(result.written, 0);
	assert.equal(result.reports.filter((r) => r.status == "error").length, 3);

	// An error combined with a really already applied write is not
	// "already applied" either.
	const applied = write(0x400100);
	await device.write(0x400100, Buffer.from(applied.new));
	const mixedVkp = {
		valid: true,
		warnings: [],
		errors: [],
		writes: [write(0x74000), applied],
	} as any;
	const result2 = await applyVkpToDevice(device, mixedVkp, { dryRun: true });
	assert.ok(!result2.ok);
	assert.ok(!result2.alreadyDone);

	// Only when every write is skipped without errors it is already applied.
	const okVkp = {
		valid: true,
		warnings: [],
		errors: [],
		writes: [applied],
	} as any;
	const result3 = await applyVkpToDevice(device, okVkp, { dryRun: true });
	assert.ok(result3.ok);
	assert.ok(result3.alreadyDone);
	assert.equal(result3.written, 0);
});

// ---------------------------------------------------------------------
// Mock phone implementing the x65 (chaos loader, protocol v2)

class MockPhoneX65 {
	flash: Buffer;
	readonly base = 0xA0000000;
	#rx: Buffer = Buffer.alloc(0);
	#dataState: { addr: number; size: number; buf: Buffer } | null = null;
	#baudAck = false;
	writes: { addr: number; data: Buffer }[] = [];
	// Boot sequences accumulate over multiple writes (the previous boot byte,
	// size, data and checksum all form one stream on the wire).
	bootSequences = new Map<string, Buffer>([
		["4154", Buffer.from([0xB0])],           // Connect: "AT" -> 0xB0
		["300200001111", Buffer.from([0xB1])],   // GoBoot("30") + ChaosBoot: size(2 LE) + data(2) + xor crc -> B1
	]);
	#bootBuf: Buffer = Buffer.alloc(0);

	#bootPhase = true;

	// During the boot phase all writes are matched against the boot sequences.
	// The first single 'A' (ping) byte switches the phone to the command phase.
	#matchBootSequence(buf: Buffer): { answer?: Buffer; passthrough?: boolean } {
		this.#bootBuf = Buffer.concat([this.#bootBuf, buf]);
		for (const [seq, answer] of this.bootSequences) {
			if (this.#bootBuf.toString("hex") == seq) {
				this.#bootBuf = Buffer.alloc(0);
				return { answer };
			}
		}
		if (this.#bootBuf.length > 32)
			this.#bootBuf = Buffer.alloc(0);
		if (this.#bootBuf.length == 1 && this.#bootBuf[0] == 0x41) {
			this.#bootBuf = Buffer.alloc(0);
			this.#bootPhase = false;
			return { passthrough: true };
		}
		return {};
	}

	constructor(size: number) {
		this.flash = Buffer.alloc(size, 0xFF);
		for (let i = 0; i < Math.min(size, 0x10000); i += 4)
			this.flash.writeUInt32LE(i, i);
	}

	handleWrite(data: Uint8Array): Buffer {
		const buf = Buffer.from(data);
		if (!this.#dataState && this.#bootPhase) {
			const boot = this.#matchBootSequence(buf);
			if (boot.answer !== undefined)
				return boot.answer;
			if (!boot.passthrough)
				return Buffer.alloc(0);
			// The ping falls through into the command phase.
		}

		if (this.#dataState) {
			const st = this.#dataState;
			st.buf = Buffer.concat([st.buf, buf.subarray(0, st.size + 1 - st.buf.length)]);
			if (st.buf.length == st.size + 1) {
				this.#dataState = null;
				const data = st.buf.subarray(0, st.size);
				this.writes.push({ addr: st.addr, data: Buffer.from(data) });
				data.copy(this.flash, st.addr - this.base);
				const crcBuf = Buffer.alloc(2);
				crcBuf.writeUInt16LE(wordChecksum(data));
				// v2: ACK(0x0101) + erase OK(0x0202) + write OK(0x0303) + written crc + "OK"
				return Buffer.concat([
					Buffer.from([0x01, 0x01]),
					Buffer.from([0x02, 0x02]),
					Buffer.from([0x03, 0x03]),
					crcBuf,
					Buffer.from("OK", "latin1"),
				]);
			}
			return Buffer.alloc(0);
		}

		this.#rx = Buffer.concat([this.#rx, buf]);
		return this.#process();
	}

	#take(n: number): Buffer | undefined {
		if (this.#rx.length >= n) {
			const c = Buffer.from(this.#rx.subarray(0, n));
			this.#rx = this.#rx.subarray(n);
			return c;
		}
		return undefined;
	}

	#process(): Buffer {
		if (!this.#rx.length)
			return Buffer.alloc(0);
		switch (String.fromCharCode(this.#rx[0])) {
			case "A": {
				this.#take(1);
				if (this.#baudAck) {
					this.#baudAck = false;
					return Buffer.from([0x48]);
				}
				return Buffer.from([0x52]); // 'R'
			}
			case "H": {
				if (!this.#take(2)) return Buffer.alloc(0);
				this.#baudAck = true;
				return Buffer.from([0x68]); // 'h'
			}
			case "U": {
				// Authorization packet: 5 bytes, no immediate answer.
				this.#take(5);
				return Buffer.alloc(0);
			}
			case ".": {
				// Keepalive, no answer.
				this.#take(1);
				return Buffer.alloc(0);
			}
			case "I": {
				this.#take(1);
				// V3 flash info: 128 bytes
				const info = Buffer.alloc(128);
				info.write("S65", 0, "latin1");
				info.write("SIEMENS", 16, "latin1");
				info.write("354141203574824", 32, "latin1"); // IMEI
				info.writeUInt32LE(this.base, 64);            // flashBaseAddr
				info.writeUInt32LE(0x00BF001F | 0x2200 << 16, 80); // flash0Type
				info.writeUInt16LE(0x001F, 80);               // VID
				info.writeUInt16LE(0x2200, 82);               // PID (dummy)
				info.writeUInt8(25, 84);                      // 32MB
				info.writeUInt16LE(32, 85);                   // writeBufferSize
				info.writeUInt8(1, 87);                       // 1 region
				info.writeUInt16LE(255, 88);                  // 256 blocks
				info.writeUInt16LE(0x20000 / 256, 90);        // 128k each
				return info;
			}
			case "R": {
				const c = this.#take(9);
				if (!c) return Buffer.alloc(0);
				const addr = c.readUInt32BE(1);
				const size = c.readUInt32BE(5);
				const data = this.flash.subarray(addr - this.base, addr - this.base + size);
				return Buffer.concat([
					data,
					Buffer.from("OK", "latin1"),
					Buffer.from([xorChecksum(data), 0]),
				]);
			}
			case "T": {
				const c = this.#take(9);
				if (!c) return Buffer.alloc(0);
				const addr = c.readUInt32BE(1) - this.base;
				const size = c.readUInt32BE(5);
				let isEmpty = true;
				for (let i = 0; i < size; i++) {
					if (this.flash[addr + i] != 0xFF) {
						isEmpty = false;
						break;
					}
				}
				return Buffer.from([isEmpty ? 0xFF : 0x00]);
			}
			case "F": {
				const c = this.#take(5); // 'F' + addr(4)
				if (!c) return Buffer.alloc(0);
				const addr = c.readUInt32BE(1);
				this.#rx = Buffer.alloc(0); // The size comes in the next write
				this.#pendingSizeAddr = addr;
				return Buffer.alloc(0);
			}
			case "\x00": // size word (4 bytes) after the F command
			default: {
				if (this.#pendingSizeAddr !== undefined && this.#rx.length >= 4) {
					const size = this.#rx.readUInt32BE(0);
					this.#rx = Buffer.alloc(0);
					this.#dataState = { addr: this.#pendingSizeAddr, size, buf: Buffer.alloc(0) };
					this.#pendingSizeAddr = undefined;
				}
				return Buffer.alloc(0);
			}
		}
	}

	#pendingSizeAddr?: number;
}

class MockTransportX65 extends MockTransportV1 {
	// Reuse the fast read/skipData logic, only the phone differs.
	constructor(phone: MockPhoneX65) {
		super(phone as any);
	}
}

test("phone device x65: v2 protocol with authorization and test-empty", async () => {
	const vkd = parseVkd(VKD_X65);
	const phone = vkd.phones[0];
	const mock = new MockPhoneX65(phone.fullflash.size);
	const transport = new MockTransportX65(mock);
	const device = new PhoneDevice(transport, phone, vkd.boots);
	device.onProgress = undefined;

	await device.open(115200);
	assert.ok(device.connected);

	// Flash info must be decoded from the V3 answer.
	const info = device.getFlashInfo()!;
	assert.equal(info.kind, "v3");
	if (info.kind == "v3") {
		assert.equal(info.model, "S65");
		assert.equal(info.imei, "354141203574824");
		assert.equal(info.regions.length, 1);
		assert.equal(info.regions[0].eraseSize, 0x20000);
	}

	// Reading
	const data = await device.read(0xA0000000, 0x100);
	assert.ok(Buffer.from(data).equals(mock.flash.subarray(0, 0x100)));

	// Writing (v2: F + addr(4) + size(4) + data + crc).
	// Write outside of the bootcore area (which is skipped by default).
	const pattern = Buffer.alloc(0x18000, 0xCD); // partial page of 0x20000
	await device.write(0xA0040000, pattern);
	await device.flush();
	assert.equal(mock.writes.length, 1); // the whole 0x20000 cache page
	assert.equal(mock.writes[0].addr, mock.base + 0x40000);
	assert.equal(mock.writes[0].data.length, 0x20000);
	assert.deepEqual(
		mock.flash.subarray(0x40000, 0x40000 + pattern.length).toString("hex"),
		pattern.toString("hex"));

	await device.disconnect();
});

// ---------------------------------------------------------------------
// Boot sequence retry, skip-loader mode and autoignition

test("phone device: whole boot sequence retry (optLoaderUploadTryCount)", async () => {
	const vkd = parseVkd(VKD_X65.replace("[PhoneCommonInfo]", `[PhoneCommonInfo]
optLoaderUploadTryCount=3
optLoaderUploadDelay=1`));
	const phone = vkd.phones[0];
	assert.equal(phone.opts.loaderUploadTryCount, 3);
	assert.equal(phone.opts.loaderUploadDelay, 1);

	const mock = new MockPhoneX65(phone.fullflash.size);
	// The first boot attempt gets no answers at all.
	let brokenAttempts = 1;
	const origHandle = mock.handleWrite.bind(mock);
	mock.handleWrite = ((data: Uint8Array) => {
		if (brokenAttempts > 0) {
			brokenAttempts--;
			return Buffer.alloc(0);
		}
		return origHandle(data);
	}) as any;

	const transport = new MockTransportX65(mock);
	const device = new PhoneDevice(transport, phone, vkd.boots);
	await device.open(115200);
	assert.ok(device.connected);
	// The loader state of the mock must be past the boot phase now.
	const data = await device.read(0xA0000000, 0x100);
	assert.equal(data.length, 0x100);
	await device.disconnect();
});

test("phone device: skip loader load/unload mode reuses the running loader", async () => {
	const vkd = parseVkd(VKD_X65);
	const phone = vkd.phones[0];
	const mock = new MockPhoneX65(phone.fullflash.size);
	// The loader is already in the phone RAM (command phase).
	(mock as any)["#bootPhase"] = false;

	const transport = new MockTransportX65(mock);
	let txCount = 0;
	const origWrite = transport.write.bind(transport);
	transport.write = ((data: Uint8Array) => {
		const buf = Buffer.from(data);
		// Any boot payload (AT / 30 / boot body) must not be sent.
		if (buf.length && buf[0] == 0x41 && buf.length == 2 && buf[1] == 0x54)
			throw new Error("Boot payload sent in skip-loader mode!");
		txCount++;
		return origWrite(data);
	}) as any;

	const device = new PhoneDevice(transport, phone, vkd.boots, { skipLoaderLoadUnload: true });
	await device.open(921600);
	assert.ok(device.connected);

	// Flash info still works (queried through the running loader).
	const info = device.getFlashInfo();
	assert.equal(info?.kind, "v3");

	// The loader must not be stopped on disconnect in skip mode.
	await device.disconnect();
});

test("phone device: autoignition disabled skips the DTR ignition pulse", async () => {
	const vkd = parseVkd(VKD_S55);
	const phone = vkd.phones[0];
	const mock = new MockPhoneV1(0x400000, 0xC00000);
	const transport = new MockTransportV1(mock);
	const signals: boolean[] = [];
	const origSet = transport.setSignals.bind(transport);
	transport.setSignals = (async (signalsIn: any) => {
		if (signalsIn.dtr !== undefined)
			signals.push(signalsIn.dtr);
		return origSet(signalsIn);
	}) as any;

	const device = new PhoneDevice(transport, phone, vkd.boots, { autoIgnition: false, dtr: false, rts: true });
	await device.open(115200);
	assert.ok(device.connected);
	// No ignition (dtr=true) pulse was ever sent.
	assert.ok(!signals.some((dtr) => dtr));
	await device.disconnect();
});

test("phone device: operation-wide progress for read and write", async () => {
	const vkd = parseVkd(VKD_S55);
	const phone = vkd.phones[0];
	const mock = new MockPhoneV1(0x400000, 0xC00000);
	const transport = new MockTransportV1(mock);
	const device = new PhoneDevice(transport, phone, vkd.boots);
	await device.open(115200);

	// Read 3 pages worth through the public operation entry point.
	const events: { cursor: number; total: number }[] = [];
	device.onProgress = (p) => events.push({ cursor: p.cursor, total: p.total });
	const data = await device.readMemory(0, 0x60000);
	device.onProgress = undefined;
	assert.equal(data.length, 0x60000);
	assert.ok(events.length > 0);
	// The progress must be one continuous bar: monotonic, with the
	// operation total (not the per-block size).
	for (const e of events)
		assert.equal(e.total, 0x60000);
	for (let i = 1; i < events.length; i++)
		assert.ok(events[i].cursor >= events[i - 1].cursor, "progress must not go back");
	assert.equal(events[events.length - 1].cursor, 0x60000);

	// Write progress as well.
	const writeEvents: { cursor: number; total: number }[] = [];
	device.onProgress = (p) => writeEvents.push({ cursor: p.cursor, total: p.total });
	await device.writeMemory(0x40000, Buffer.alloc(0x40000, 0x99));
	device.onProgress = undefined;
	assert.ok(writeEvents.length > 0);
	for (const e of writeEvents)
		assert.equal(e.total, 0x40000);
	for (let i = 1; i < writeEvents.length; i++)
		assert.ok(writeEvents[i].cursor >= writeEvents[i - 1].cursor, "write progress must not go back");
	assert.equal(writeEvents[writeEvents.length - 1].cursor, 0x40000);

	await device.disconnect();
});

test("dump comparison helpers", () => {
	const a = Buffer.alloc(256, 0xAA);
	const b = Buffer.from(a);

	// Identical buffers
	assert.deepEqual(diffBuffers(a, b), []);

	// Two separate small diffs + a fill/erase classification
	b[10] = 0xFF;         // data -> FF (erased in b)
	b[11] = 0x00;         // changed
	b[100] = 0x55;        // changed
	b[200] = 0xFF;        // data -> FF
	a[240] = 0xFF;        // FF -> data (filled in b)
	b[250] = 0x01;        // changed
	const regions = diffBuffers(a, b);
	assert.equal(regions.length, 4);
	assert.deepEqual(regions[0], { addr: 10, length: 2 });
	assert.deepEqual(regions[1], { addr: 100, length: 1 });
	assert.deepEqual(regions[2], { addr: 200, length: 1 });
	assert.deepEqual(regions[3], { addr: 240, length: 11 }); // 240 and 250 merged by the gap

	const stats = diffEraseStats(a, b, regions);
	assert.equal(stats.aToFF, 2);   // b[10], b[200]
	assert.equal(stats.ffToA, 1);   // a[240]
	assert.equal(stats.changed, 3); // b[11], b[100], b[250]

	// Previews
	const previews = diffRegionPreviews(a, b, regions);
	assert.equal(previews.length, 4);
	assert.equal(previews[0].addr, 10);
	assert.equal(previews[0].a, "AA AA");
	assert.equal(previews[0].b, "FF 00");
});

test("phone device: repeated reads always fetch fresh data from the phone", async () => {
	const vkd = parseVkd(VKD_S55);
	const phone = vkd.phones[0];
	const mock = new MockPhoneV1(0x400000, 0xC00000);
	const transport = new MockTransportV1(mock);
	const device = new PhoneDevice(transport, phone, vkd.boots);
	await device.open(115200);

	const first = await device.readMemory(0x1000, 0x100);
	assert.ok(Buffer.from(first).equals(mock.flash.subarray(0x401000, 0x401100)));

	// The flash content changes between the operations (e.g. the phone FFS):
	// the second read must not be served from the stale page cache.
	mock.flash.fill(0x5A, 0x401000, 0x401100);
	const second = await device.readMemory(0x1000, 0x100);
	assert.ok(Buffer.from(second).equals(mock.flash.subarray(0x401000, 0x401100)),
		"the second read must return the updated phone data");

	await device.disconnect();
});

// ---------------------------------------------------------------------
// Applying a real multi-block patch over the mock phone.
//
// The E71 bootscreen patch of the patches submodule consists of thousands
// of small writes (1..16 bytes) spread over several flash blocks. It is
// applied to the fullflash of a different phone (EL71), so the old data of
// every write mismatches and the apply runs through the confirmed-mismatch
// path. This is the patch of the "web tools get stuck on reading the block"
// report; the tests below pin the block traffic the patch engine is allowed
// to produce.

const MULTIBLOCK_PATCH_FILE = path.resolve(process.cwd(), "..", "tests",
	"patches", "patches", "E71v45", "10772-BS_SM_Black_E71sw45_fixed2.vkp");
const OTHER_PHONE_DUMP_FILE = path.resolve(process.cwd(), "..", "tests",
	"fullflashes", "EL71v41lg91.bin");

// The flash block size reported by the mock loader in its flash info.
const BLOCK_SIZE = 0x20000;

// Mock transport that corrupts the checksum of the next block data answer,
// so the loader hits a "Received data CRC error" exactly once and has to
// retry the chunk.
class CrcCorruptingTransport extends MockTransportX65 {
	corruptNextDataAnswer = false;

	async read(size: number, timeoutMS: number): Promise<Buffer | undefined> {
		const answer = await super.read(size, timeoutMS);
		// The block read answers (data + OK + checksum) are the only big reads
		// on the wire; flip the last checksum byte of the next one.
		if (answer && this.corruptNextDataAnswer && size > 1024) {
			this.corruptNextDataAnswer = false;
			answer[answer.length - 1] ^= 0xFF;
		}
		return answer;
	}
}

// A connected phone whose flash holds the dump of another phone, with the
// loader block operations counted: every loaderReadMemory() call is one
// block fetch from the phone (the "Reading 0x...-0x... (131072 bytes)"
// log lines), every loaderWriteMemory() call one block erase+program.
async function makeForeignFlashPhone(corruptFirstChunk = false) {
	const vkd = parseVkd(VKD_X65);
	const phone = vkd.phones[0];
	const mock = new MockPhoneX65(phone.fullflash.size);
	const dump = readFileSync(OTHER_PHONE_DUMP_FILE);
	dump.copy(mock.flash, 0);
	const transport = new CrcCorruptingTransport(mock);
	transport.corruptNextDataAnswer = corruptFirstChunk;
	const device = new PhoneDevice(transport, phone, vkd.boots);
	await device.open(115200);

	const blockReads: number[] = [];
	const blockWrites: number[] = [];
	const origRead = device.loaderReadMemory.bind(device);
	const origWrite = device.loaderWriteMemory.bind(device);
	device.loaderReadMemory = async (addr, size, out) => {
		blockReads.push(addr);
		return origRead(addr, size, out);
	};
	device.loaderWriteMemory = async (addr, size, data) => {
		blockWrites.push(addr);
		return origWrite(addr, size, data);
	};
	return { device, mock, dump, blockReads, blockWrites };
}

function loadMultiblockPatch() {
	const vkp = vkpParse(vkpNormalize(readFileSync(MULTIBLOCK_PATCH_FILE)), { allowEmptyOldData: true });
	assert.ok(vkp.valid, "the patch must parse");
	// The flash blocks the patch writes touch (V_KLay offsets).
	const pages = [...new Set(vkp.writes.map((w) => w.addr & ~(BLOCK_SIZE - 1)))].sort((a, b) => a - b);
	return { vkp, pages };
}

const multiblockDataAvailable = () => existsSync(MULTIBLOCK_PATCH_FILE) && existsSync(OTHER_PHONE_DUMP_FILE);

const skipWithoutMultiblockData = (t: { skip(message?: string): void }) =>
	t.skip(`needs the test data of the sieflasher checkout: ${MULTIBLOCK_PATCH_FILE}, ${OTHER_PHONE_DUMP_FILE}`);

test("vkp apply: a patch spanning multiple blocks reads and writes every block exactly once", async (t) => {
	if (!multiblockDataAvailable()) {
		skipWithoutMultiblockData(t);
		return;
	}
	const { vkp, pages } = loadMultiblockPatch();
	assert.ok(vkp.writes.length > 1000, "the patch must consist of many small writes");
	assert.ok(pages.length >= 2, "the patch must span several flash blocks");
	const totalBytes = vkp.writes.reduce((sum, w) => sum + w.new.length, 0);

	const { device, mock, dump, blockReads, blockWrites } = await makeForeignFlashPhone(true);

	// None of the patch old data is in the flash of the other phone: the
	// whole apply runs through the confirmed-mismatch path.
	let mismatches = 0;
	const result = await applyVkpToDevice(device, vkp, {
		confirmNoOld: () => true,
		confirmMismatch: () => {
			mismatches++;
			return true;
		},
	});
	assert.ok(result.ok);
	assert.equal(mismatches, 1);
	assert.equal(result.read, totalBytes);
	assert.equal(result.written, totalBytes);

	// Every touched block was fetched from the phone exactly once and
	// erased+programmed exactly once - despite the one injected chunk CRC
	// error, which was retried inside the very block read it happened in.
	assert.deepEqual([...blockReads].sort((a, b) => a - b), pages,
		"one block fetch per touched block");
	assert.deepEqual([...blockWrites].sort((a, b) => a - b), pages,
		"one block erase+program per touched block");
	assert.equal(device.errorsCorrectedCount, 1);

	// The loader really saw one whole-block write per touched block.
	assert.equal(mock.writes.length, pages.length);
	for (const page of pages)
		assert.ok(mock.writes.some((w) => w.addr == 0xA0000000 + page),
			`the block at 0x${page.toString(16)} was written as one block`);

	// The new data of every write landed in the flash at its address...
	for (const w of vkp.writes) {
		if (!mock.flash.subarray(w.addr, w.addr + w.new.length).equals(w.new))
			assert.fail(`the new data of the write at 0x${w.addr.toString(16)} is not in the flash`);
	}
	// ...and nothing outside the writes changed: the rewritten blocks kept
	// the original data of the dump everywhere else.
	const covered = new Uint8Array(mock.flash.length);
	for (const w of vkp.writes)
		covered.fill(1, w.addr, w.addr + w.new.length);
	let changedOutside = -1;
	for (let i = 0; i < mock.flash.length && changedOutside == -1; i++) {
		if (!covered[i] && mock.flash[i] != dump[i])
			changedOutside = i;
	}
	assert.equal(changedOutside, -1,
		`byte 0x${changedOutside == -1 ? "" : changedOutside.toString(16)} outside of the writes changed`);

	await device.disconnect();
});

test("vkp apply: readMemory()/writeMemory() routing refetches and rewrites the whole block for every write", async (t) => {
	if (!multiblockDataAvailable()) {
		skipWithoutMultiblockData(t);
		return;
	}
	const { vkp, pages } = loadMultiblockPatch();
	const totalBytes = vkp.writes.reduce((sum, w) => sum + w.new.length, 0);

	// How the web tools drove the patch engine when applying this patch got
	// stuck "on reading the block": every per-write read()/write() of the
	// engine was routed through PhoneDevice.readMemory()/writeMemory() - the
	// operation-level API which drops the whole page cache before every call
	// (so that a Read Memory always reflects the current phone state). The
	// containing block is then fetched from the phone again for every single
	// patch write; for this patch thousands of full-block reads instead of
	// one per touched block, each visible as a repeated "Reading 0x..."
	// line.
	const operationWrapper = (device: PhoneDevice) => {
		const base = device.getMemoryStart();
		return {
			read: (addr: number, size: number) => device.readMemory(addr - base, size),
			write: (addr: number, data: Uint8Array) => device.writeMemory(addr - base, data),
			flush: async () => {},
			getMemoryStart: () => device.getMemoryStart(),
			getMemorySize: () => device.getMemorySize(),
		} as FlasherDevice;
	};

	// The conversion (reading) phase alone is where it gets stuck.
	{
		const { device, blockReads, blockWrites } = await makeForeignFlashPhone();
		const result = await applyVkpToDevice(operationWrapper(device), vkp, {
			dryRun: true,
			confirmNoOld: () => true,
			confirmMismatch: () => true,
		});
		assert.ok(result.ok);
		assert.equal(blockReads.length, vkp.writes.length,
			"one whole block fetch per patch write instead of one per touched block");
		assert.deepEqual([...new Set(blockReads)].sort((a, b) => a - b), pages);
		assert.equal(blockWrites.length, 0);
		await device.disconnect();
	}

	// The write phase through writeMemory() has it even worse: every write
	// call drops the cache, re-fetches the whole block to update it and then
	// erases and reprograms the whole block - one flash erase cycle per patch
	// write instead of one per touched block.
	{
		const { device, mock, blockReads, blockWrites } = await makeForeignFlashPhone();
		const result = await applyVkpToDevice(operationWrapper(device), vkp, {
			confirmNoOld: () => true,
			confirmMismatch: () => true,
		});
		assert.ok(result.ok);
		assert.equal(result.written, totalBytes);
		assert.equal(blockReads.length, 2 * vkp.writes.length,
			"one whole block fetch per patch write in each phase");
		assert.equal(blockWrites.length, vkp.writes.length,
			"one whole-block erase+program per patch write");
		// The routing is functionally correct, just catastrophic: the new data
		// of every write still lands in the flash.
		for (const w of vkp.writes) {
			if (!mock.flash.subarray(w.addr, w.addr + w.new.length).equals(w.new))
				assert.fail(`the new data of the write at 0x${w.addr.toString(16)} is not in the flash`);
		}
		await device.disconnect();
	}
});
