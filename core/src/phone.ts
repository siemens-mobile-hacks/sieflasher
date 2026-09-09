// Siemens phone flasher: a faithful reimplementation of the V_KLay phone
// device (VDevicePhone.cpp in https://github.com/siemens-mobile-hacks/v-klay).
//
// The protocol is fully driven by the .vkd phone driver file:
//  - The boot sequence uploads the loader to the phone.
//  - Memory is read/written with the loader commands (R/F/T).
//  - Protocol variations between the phone generations are controlled
//    by the opt* parameters from the driver file.

import { Buffer } from "buffer";
import { sprintf } from "sprintf-js";
import createDebug from "debug";
import { FlasherAbortError, FlasherDevice, DeviceOperations } from "./device.js";
import { MemCache } from "./memcache.js";
import { FlasherTransport } from "./transport.js";
import { MemGeometry, VkdBoot, VkdFile, VkdPhone } from "./vkd.js";

const debug = createDebug("flasher");
const debugTrx = createDebug("flasher:trx");

const VD_KEEPALIVE_TICK = 250; // ms

const VDP_READ_PAGE_SIZE_START = 0x10000;
const VDP_READ_BIG_PAGE_SIZE_MIN = 0x4000;
const VDP_READ_PAGE_SIZE_MIN = 0x80;
const VDP_READ_PAGE_SIZE_TRY_COUNT = 5;
const VDP_READ_BIG_PAGE_SIZE_TRY_COUNT = 2;

const VDP_MEMORY_READ_TIMEOUT = 1000;
const VDP_MEMORY_WRITE_ALL_PAGE_TIMEOUT = 5 * 60 * 1000;
const VDP_MESSAGE_TIMEOUT = 10;
const VDP_PHONE_FOR_1STBOOT_READY_TIMEOUT = 100;
const VDP_READ_INFO_TIMEOUT = 1000;
const VDP_READ_INFO_INTERVAL_TIMEOUT = 100;
const VDP_READ_INFO_DATA_TRY_COUNT = 4;
const VDP_READ_INFO_DECODED_DATA_TRY_COUNT = 4;
const VDP_IS_LOADER_READY_ANS_TIMEOUT = 1000;
const VDP_BOOT_ANS_READ_TIMEOUT = 5000;
const VDP_WRITE_AFTER_BAD_CRC_SKIP_TIMEOUT = 2000;
const VDP_STOP_LOADER_SKIP_TIMEOUT = 50;
// 16 + max(sizeof(V1)=560, sizeof(V2)=224, sizeof(V3)=128)
const PHONE_INFO_MAX_LEN = 0x240;

// Write command (loader protocol v1, 16-bit segment addressing)
const VDP_CMDLDR_WRITE_ERR_ADDRESS_TOO_FAR = 0xEEEE;
const VDP_CMDLDR_WRITE_ERR_UNKNOWN_FLASH = 0xCCCC;
const VDP_CMDLDR_WRITE_DATARECEIVED_ERR_CRC_NAK = 0xBBBB;
const VDP_CMDLDR_WRITE_OK_ID = 0xFFFF;
const VDP_CMDLDR_WRITE_DATARECEIVED_ERR_RAM_NAK = 0xFFFF;
const VDP_CMDLDR_WRITE_OK_ERASE = 0x0202;
const VDP_CMDLDR_WRITE_OK_ACK = 0x0303;
const VDP_CMDLDR_WRITE_ADDR_LEN = 2;

// Write command v2 (x65-family, absolute addressing)
const VDP_CMDLDR_WRITEV2_DATARECEIVED_ACK = 0x0101;
const VDP_CMDLDR_WRITEV2_DATARECEIVED_ACCESS_DENIED_NAK = 0xEEEE;
const VDP_CMDLDR_WRITEV2_DATARECEIVED_ERR_BOUNDS_NAK = 0xFFFF;
const VDP_CMDLDR_WRITEV2_DATARECEIVED_UNKNOWN_FLASH_NAK = 0xCCCC;

export interface PhoneInfoV1 {
	kind: "v1";
	fwVersion: number;
	langPack: string;
	model: string;
	manufacturer: string;
	someInfo: string;
	phoneId0: number;
	phoneId1: number;
	flash0Type: number;
	flash1Type: number;
}

export interface PhoneInfoRegion {
	addr: number;
	blocksCount: number;
	eraseSize: number;
}

export interface PhoneInfoV3 {
	kind: "v3";
	model: string;
	manufacturer: string;
	imei: string;
	flashBaseAddr: number;
	flash0Type: number;
	flashVID: number;
	flashPID: number;
	flashSizePow: number;
	writeBufferSize: number;
	flashRegionsNum: number;
	regions: PhoneInfoRegion[];
}

export type PhoneInfo = PhoneInfoV1 | PhoneInfoV3;

export interface PhoneDeviceOptions {
	// Initial signals state (cable powering, e.g. for DCA-510).
	dtr?: boolean;
	rts?: boolean;
	// Skip writing to bootcore areas (safety, default: true).
	skipBootcore?: boolean;
	// Skip writing to areas marked as nowrite in the driver.
	skipNoWrite?: boolean;
	// Use the loader that is already in the phone RAM, without sending
	// the boots again (Shift+Ctrl+Alt in V_KLay).
	skipLoaderLoadUnload?: boolean;
	// Power the phone from the cable during the boot (ignition, default: true).
	// When false, only the "press the power button" phase is used
	// (o_AutoignitionType=AUTOIGN_NONE in V_KLay).
	autoIgnition?: boolean;
	// Boot progress callback.
	onStatus?: (status: string) => void;
}

interface BootPhase {
	boot: VkdBoot;
	canceled: boolean;
}

export class PhoneDeviceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PhoneDeviceError";
	}
}

export class PhoneDevice extends FlasherDevice {
	readonly phone: VkdPhone;
	private readonly transport: FlasherTransport;
	private readonly bootsByName: Map<string, VkdBoot>;
	private readonly opts: Required<Pick<PhoneDeviceOptions, "dtr" | "rts" | "skipBootcore" | "skipNoWrite">>
		& PhoneDeviceOptions;

	private cache = new MemCache();
	private isOpen = false;
	private isLoaderLoaded = false;
	private lastGoodPageSize = VDP_READ_PAGE_SIZE_START;
	private phoneInfo?: PhoneInfo;
	private phoneInfoRaw?: Buffer;
	private errorsCorrected = 0;
	private keepaliveTimer?: ReturnType<typeof setInterval>;
	private keepaliveTicks = 0;
	private busyCounter = 0;

	constructor(transport: FlasherTransport, phone: VkdPhone, bootsByName: Map<string, VkdBoot> | { getBoot(name: string): VkdBoot | undefined }, options: PhoneDeviceOptions = {}) {
		super();
		this.transport = transport;
		this.phone = phone;
		this.bootsByName = new Map(bootsByName instanceof Map
			? bootsByName
			: [...(bootsByName as VkdFile).boots.entries()].map(([k, v]) => [k.toLowerCase(), v] as [string, VkdBoot]));
		this.opts = {
			dtr: options.dtr ?? true,
			rts: options.rts ?? true,
			skipBootcore: options.skipBootcore ?? true,
			skipNoWrite: options.skipNoWrite ?? true,
			...options,
		};
	}

	get memoryStart(): number {
		return this.phone.fullflash.addr;
	}

	get memorySize(): number {
		return this.phone.fullflash.size;
	}

	getMemoryStart(): number {
		return this.memoryStart;
	}

	getMemorySize(): number {
		return this.memorySize;
	}

	get memAreas() {
		return this.phone.memAreas;
	}

	get memGeometry(): MemGeometry[] {
		return this.phone.memGeometry;
	}

	get connected(): boolean {
		return this.isOpen;
	}

	get errorsCorrectedCount(): number {
		return this.errorsCorrected;
	}

	getFlashInfo(): PhoneInfo | undefined {
		return this.phoneInfo;
	}

	getSupportedOperations(): number {
		return DeviceOperations.READ | DeviceOperations.WRITE |
			(this.phone.opts.isRstBootcoreCmdEn ? DeviceOperations.RESTORE_BOOTCORE : 0);
	}

	private status(msg: string): void {
		debug(msg);
		this.opts.onStatus?.(msg);
	}

	// ------------------------------------------------------------------
	// Device lifecycle

	async open(baudrate = 115200): Promise<void> {
		if (this.isOpen)
			return;
		this.errorsCorrected = 0;
		this.lastGoodPageSize = VDP_READ_PAGE_SIZE_START;
		this.cache = new MemCache();
		this.cache.setMemAreaStart(this.memoryStart);
		this.cache.setGeometry(this.phone.memGeometry);
		this.phoneInfo = undefined;
		this.phoneInfoRaw = undefined;

		try {
			// "Skip loader load/unload" mode: reuse the loader that is already
			// running in the phone RAM (V_KLay: Shift+Ctrl+Alt).
			let loaderReused = false;
			if (this.opts.skipLoaderLoadUnload) {
				await this.transport.setSignals({ dtr: this.opts.dtr, rts: this.opts.rts });
				await this.delay(100);
				if (await this.loaderIsReady(VDP_PHONE_FOR_1STBOOT_READY_TIMEOUT)) {
					this.isLoaderLoaded = true;
					loaderReused = true;
					this.status("Using the loader that is already in the phone RAM.");
				} else {
					await this.transport.flush();
				}
			}

			if (!loaderReused) {
				// The whole boot sequence can be retried
				// (optLoaderUploadTryCount / optLoaderUploadDelay), like in V_KLay.
				let uploadTry = 0;
				for (;;) {
					try {
						await this.sendBoots();
						break;
					} catch (e) {
						if (!(e instanceof PhoneDeviceError))
							throw e;
						uploadTry++;
						const maxTries = this.phone.opts.loaderUploadTryCount;
						if (maxTries != -1 && (maxTries == 0 || uploadTry >= maxTries))
							throw e;
						this.status(`Error while uploading the loader... retrying (attempt ${uploadTry + 1}).`);
						await this.transport.setSignals({ dtr: this.opts.dtr, rts: this.opts.rts });
						if (this.phone.opts.loaderUploadDelay > 0)
							await this.delay(this.phone.opts.loaderUploadDelay);
						await this.transport.flush();
					}
				}

				this.stopKeepalive();
				await this.transport.skipData(VDP_MESSAGE_TIMEOUT);
				await this.transport.flush();

				if (!await this.loaderIsReady())
					throw new PhoneDeviceError("Loader is not ready.");

				await this.loaderSetConnectionSpeed(baudrate);
				this.isLoaderLoaded = true;
			}

			await this.transport.flush();
			await this.readFlashInfo();

			for (let i = 0; i < VDP_READ_INFO_DECODED_DATA_TRY_COUNT && !this.cache.isValid(); i++) {
				await this.throwIfLoaderNotReady();
				await this.readFlashInfo();
			}

			if (!this.cache.isValid())
				throw new PhoneDeviceError(
					"Unknown geometry of ROM (flash) in the phone. " +
					"Specify it in the MCUMemGeometry parameter in the .vkd file for this phone " +
					"or use a loader that reports the geometry in the flash info command."
				);

			// The reused loader is already authorized.
			if (!loaderReused)
				await this.loaderAuthorization();
			await this.throwIfLoaderNotReady();

			this.isOpen = true;
			this.startKeepalive();
		} catch (e) {
			await this.closeTransport().catch(() => {});
			throw e;
		}
	}

	async close(): Promise<void> {
		if (!this.isOpen && !this.isLoaderLoaded)
			return;
		try {
			await this.flush();
		} finally {
			this.cache.clearCache();
			this.stopKeepalive();
			this.isLoaderLoaded = false;
		}
	}

	async abort(): Promise<void> {
		this.cache.dropChangedPages();
	}

	async disconnect(): Promise<void> {
		try {
			await this.close();
		} finally {
			this.isOpen = false;
			if (this.isLoaderLoaded) {
				await this.loaderStopLoader().catch(() => {});
				this.isLoaderLoaded = false;
			}
			await this.closeTransport();
		}
	}

	private async closeTransport(): Promise<void> {
		this.stopKeepalive();
		await this.transport.setSignals({ dtr: this.opts.dtr, rts: this.opts.rts }).catch(() => {});
		await this.transport.close().catch(() => {});
	}

	// ------------------------------------------------------------------
	// Boot sequence (VPhoneBoot::LoadToPhone)

	private async sendBoots(): Promise<void> {
		const boots = this.phone.boots
			.map((name) => this.lookupBoot(name))
			.filter((b): b is VkdBoot => !!b);
		if (!boots.length)
			throw new PhoneDeviceError("The phone driver does not define any boots.");

		for (const boot of boots)
			await this.sendBoot(boot);
	}

	private lookupBoot(name: string): VkdBoot | undefined {
		return this.bootsByName.get(name) ?? this.bootsByName.get(name.toLowerCase());
	}

	private async sendBoot(boot: VkdBoot): Promise<void> {
		this.status(`Sending boot: ${boot.name}`);
		if (boot.delayBefore && boot.delayBefore > 0)
			await this.delay(boot.delayBefore);

		if (boot.baud && boot.baud > 0)
			await this.transport.updateBaudrate(boot.baud);

		const tryCount = boot.tryCount == 0 ? 1 : boot.tryCount;
		const answerTimeout = boot.answerTimeout || (boot.useIgnition ? VDP_PHONE_FOR_1STBOOT_READY_TIMEOUT : VDP_BOOT_ANS_READ_TIMEOUT);

		let ok = false;
		if (boot.useIgnition) {
			ok = await this.sendBootWithIgnition(boot, answerTimeout, tryCount);
		} else {
			let tries = tryCount;
			while (!ok && tries != 0) {
				await this.sendBootPayload(boot);
				if (!boot.answer) {
					ok = true;
					break;
				}
				ok = await this.deviceWaitCmdAnswer(boot.answer, answerTimeout);
				if (tries != -1)
					tries--;
			}
		}

		if (!ok)
			throw new PhoneDeviceError(`No answer from the boot "${boot.name}". ` +
				`Make sure the phone is turned off and the cable is properly connected.`);

		if (boot.delayAfter && boot.delayAfter > 0)
			await this.delay(boot.delayAfter);
	}

	private async sendBootPayload(boot: VkdBoot): Promise<void> {
		if (!boot.data.length)
			return;
		if (!boot.noSendLen)
			await this.transport.write(sizeToComm(boot.data.length, boot.sizeLen));
		await this.transport.write(boot.data);
		if (!boot.noSendCheckSum)
			await this.transport.write(Buffer.from([xorChecksum(boot.data)]));
	}

	// Ignition boot (VPhoneBoot::LoadToPhone() with m_bUseIgnition).
	// Phase 1: power the phone from the cable (ignition) and send the boot in a loop.
	// Phase 2: power cycle the phone (for cables without ignition support).
	// Phase 3: wait until the user presses the power button.
	private async sendBootWithIgnition(boot: VkdBoot, answerTimeout: number, tryCount: number): Promise<boolean> {
		if (!this.opts.autoIgnition)
			return this.sendBootPowerButtonOnly(boot, answerTimeout, tryCount);

		const payload = async () => {
			await this.sendBootPayload(boot);
			if (!boot.answer)
				return true;
			const answer = await this.transport.read(boot.answer.length, answerTimeout);
			return !!answer && answer.length >= boot.answer.length
				&& answer.subarray(0, boot.answer.length).equals(boot.answer);
		};

		let ok = false;
		let zeroReads = 0;

		// Phase 1: ignition - power the phone with DTR and send the boot.
		await this.transport.setSignals({ dtr: true, rts: this.opts.rts });
		const ignitionDeadline = Date.now() + 500;
		while (Date.now() < ignitionDeadline) {
			this.checkCancel();
			const answer = await this.transport.read(boot.answer?.length ?? 1, answerTimeout);
			if (answer && answer.length == 1 && answer[0] == 0)
				zeroReads++;
			if (await payload())
				return true;
		}

		// Phase 2: power cycle - power off the phone, then power it on again.
		await this.transport.setSignals({ dtr: true, rts: this.opts.rts });
		if (zeroReads != 1)
			await this.transport.read(1, 1500);
		const offDeadline = Date.now() + 500;
		await this.transport.setSignals({ dtr: false, rts: this.opts.rts });
		let tries = tryCount;
		while (!ok) {
			this.checkCancel();
			if (Date.now() >= offDeadline)
				break; // Phone is powered off now
			if (await payload())
				return true;
			const answer = await this.transport.read(boot.answer?.length ?? 1, 1);
			if (answer && answer.length == 1 && answer[0] == 0)
				break; // Ignition edge detected
			if (tries != -1) {
				tries--;
				if (!tries)
					break;
			}
		}

		// Phase 3: ask the user to press the power button.
		await this.transport.setSignals({ dtr: this.opts.dtr, rts: this.opts.rts });
		this.status("Please, shortly press the Power button on the phone!");
		tries = tryCount;
		while (!ok && tries != 0) {
			this.checkCancel();
			ok = await payload();
			if (tries != -1)
				tries--;
		}

		await this.transport.setSignals({ dtr: this.opts.dtr, rts: this.opts.rts });
		return ok;
	}

	// Ignition boot with the ignition disabled (AUTOIGN_NONE):
	// only the "press the power button" phase is used.
	private async sendBootPowerButtonOnly(boot: VkdBoot, answerTimeout: number, tryCount: number): Promise<boolean> {
		await this.transport.setSignals({ dtr: this.opts.dtr, rts: this.opts.rts });
		let tries = tryCount == 0 ? 1 : tryCount;
		for (;;) {
			this.checkCancel();
			await this.sendBootPayload(boot);
			if (!boot.answer)
				return true;
			const answer = await this.transport.read(boot.answer.length, answerTimeout);
			if (answer && answer.length >= boot.answer.length
				&& answer.subarray(0, boot.answer.length).equals(boot.answer))
				return true;
			if (tries != -1) {
				tries--;
				if (!tries)
					return false;
			}
		}
	}

	// ------------------------------------------------------------------
	// Loader commands

	// Sends a single-char command, returns the answer or undefined on timeout.
	private async deviceSendCommand(cmd: string | Buffer, answerLen: number, timeoutMS = VDP_MESSAGE_TIMEOUT, nextBytesTimeoutMS?: number): Promise<Buffer | undefined> {
		if (typeof cmd == "string") {
			debugTrx("TX: %s", cmd);
			await this.transport.write(Buffer.from(cmd, "latin1"));
		} else {
			debugTrx("TX: %s", Buffer.from(cmd).toString("hex"));
			await this.transport.write(cmd);
		}
		if (answerLen == 0)
			return undefined;
		const answer = await this.transport.read(answerLen, timeoutMS, nextBytesTimeoutMS);
		if (answer)
			debugTrx("RX: %s", answer.toString("hex"));
		return answer;
	}

	// VDevicePhone::DeviceWaitCmdAnswer()
	// Waits for the specified answer, searching for it in the input stream.
	private async deviceWaitCmdAnswer(answer: Buffer, timeoutMS: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMS;
		let partial = Buffer.alloc(0);
		while (Date.now() < deadline) {
			this.checkCancel();
			const chunk = await this.transport.read(answer.length - partial.length, Math.max(1, deadline - Date.now()));
			if (!chunk || !chunk.length)
				continue;
			partial = Buffer.concat([partial, chunk]);
			if (partial.length > answer.length * 4)
				partial = partial.subarray(partial.length - answer.length);
			if (partial.subarray(Math.max(0, partial.length - answer.length)).equals(answer))
				return true;
		}
		return false;
	}

	async loaderIsReady(timeoutMS = VDP_IS_LOADER_READY_ANS_TIMEOUT): Promise<boolean> {
		const answer = await this.deviceSendCommand("A", 1, timeoutMS);
		return !!answer && answer.length == 1 && answer[0] == 0x52; // 'R'
	}

	private async throwIfLoaderNotReady(): Promise<void> {
		for (let i = 0; i < 4; i++) {
			await this.transport.flush();
			await this.transport.skipData(10);
			if (await this.loaderIsReady()) {
				await this.transport.flush();
				if (await this.loaderIsReady()) {
					await this.transport.skipData(10);
					return;
				}
			}
		}
		throw new PhoneDeviceError("Loader is not ready!");
	}

	// VDevicePhone::LoaderSetConnectionSpeed()
	async loaderSetConnectionSpeed(baud: number): Promise<void> {
		if (this.phone.opts.isBaudCmdDis)
			return;

		const baudCode = this.phone.opts.baudsCodes.get(baud);
		if (baudCode === undefined) {
			if (baud <= 115200)
				return;
			throw new PhoneDeviceError(sprintf("The phone does not support the baudrate %d.", baud));
		}

		this.status(`Setting communication speed: ${baud}...`);

		await this.transport.write(Buffer.from("H", "latin1"));
		await this.transport.write(Buffer.from([baudCode]));

		let answer = await this.transport.read(1, VDP_MEMORY_READ_TIMEOUT);
		if (!answer || answer.length < 1 || answer[0] != 0x68) // 'h'
			throw new PhoneDeviceError(`Invalid answer on the baudrate command (expected "h").`);

		await this.transport.updateBaudrate(baud);
		await this.transport.flush();

		await this.transport.write(Buffer.from("A", "latin1"));
		answer = await this.transport.read(1, VDP_MEMORY_READ_TIMEOUT);
		if (!answer || answer.length < 1 || answer[0] != 0x48) // 'H'
			throw new PhoneDeviceError(sprintf("The phone did not confirm the new baudrate %d. Try another speed.", baud));

		this.status(`Speed set: ${baud}.`);
	}

	// VDevicePhone::LoaderStopLoader()
	async loaderStopLoader(): Promise<void> {
		if (this.opts.skipLoaderLoadUnload)
			return;
		this.stopKeepalive();
		this.enterBusy();
		try {
			await this.deviceSendCommand("Q", 0);
			await this.transport.skipData(VDP_STOP_LOADER_SKIP_TIMEOUT);
			await this.deviceSendCommand("Z", 0);
			await this.transport.skipData(VDP_STOP_LOADER_SKIP_TIMEOUT);
		} finally {
			this.exitBusy();
		}
		this.isLoaderLoaded = false;
	}

	// VDevicePhone::KeepAlive()
	private startKeepalive(): void {
		if (!this.phone.opts.keepAliveInterval)
			return;
		this.keepaliveTicks = 0;
		this.keepaliveTimer = setInterval(() => this.keepaliveTick(), VD_KEEPALIVE_TICK);
	}

	private stopKeepalive(): void {
		if (this.keepaliveTimer) {
			clearInterval(this.keepaliveTimer);
			this.keepaliveTimer = undefined;
		}
	}

	private async keepaliveTick(): Promise<void> {
		if (this.busyCounter != 0 || !this.isLoaderLoaded)
			return;
		this.keepaliveTicks++;
		if (this.keepaliveTicks < Math.max(1, this.phone.opts.keepAliveInterval))
			return;
		this.keepaliveTicks = 0;
		try {
			await this.transport.write(Buffer.from(".", "latin1"));
			await this.transport.skipData(1);
		} catch (e) {
			debug("keepalive error: %o", e);
		}
	}

	private enterBusy(): void {
		this.busyCounter++;
		this.stopKeepalive();
	}

	private exitBusy(): void {
		this.busyCounter = Math.max(0, this.busyCounter - 1);
		if (this.busyCounter == 0 && this.isOpen)
			this.startKeepalive();
	}

	// VDevicePhone::LoaderAuthorization()
	private async loaderAuthorization(): Promise<void> {
		if (this.phone.opts.authorization != 1)
			return;
		const imei = this.getBcdIMEI();
		if (!imei)
			return;

		// Port of the original IMEI-based LFSR authorization.
		let r = 0;
		for (let i = 0; i < 14; i++) {
			const digit = i & 1
				? (imei[Math.floor((14 - i) / 2)] >> 4) & 0x0F
				: imei[Math.floor((14 - i) / 2)] & 0x0F;
			r = ((r << 1) + (r << 3) + digit) >>> 0;
		}
		for (let i = 0; i < 0x23c; i++) {
			if (r & 1) {
				r = ((r >>> 1) | 0x80000000) >>> 0;
			} else {
				r = ((r >>> 1) ^ 0x93000) >>> 0;
			}
		}

		const auth = Buffer.alloc(5);
		auth[0] = 0x55; // 'U'
		for (let i = 1; i < 5; i++)
			auth[i] = (r >>> ((4 - i) * 8)) & 0xFF;

		this.status("Authorizing the loader...");
		await this.transport.write(auth);
		if (!await this.loaderIsReady())
			throw new PhoneDeviceError("Loader authorization failed!");
	}

	// VDevicePhone::LoaderReadFlashInfo()
	async readFlashInfo(): Promise<void> {
		this.enterBusy();
		try {
			if (!this.phone.opts.isInfoCmdDis && !await this.loaderIsReady())
				throw new PhoneDeviceError("Loader is not ready while reading the flash info.");

			this.phoneInfoRaw = undefined;
			if (this.phone.opts.isInfoCmdDis)
				return;

			for (let i = 0; i < VDP_READ_INFO_DATA_TRY_COUNT; i++) {
				this.checkCancel();
				let answer = await this.deviceSendCommand("I", PHONE_INFO_MAX_LEN, VDP_READ_INFO_TIMEOUT, VDP_READ_INFO_INTERVAL_TIMEOUT);
				if (!answer || !answer.length) {
					answer = await this.deviceSendCommand("\xF1", PHONE_INFO_MAX_LEN, VDP_READ_INFO_TIMEOUT, VDP_READ_INFO_INTERVAL_TIMEOUT);
				}
				if (answer && answer.length) {
					this.phoneInfoRaw = answer;
					break;
				}
				await this.throwIfLoaderNotReady();
			}

			this.decodePhoneInfo();
		} finally {
			this.exitBusy();
		}
	}

	private decodePhoneInfo(): void {
		const data = this.phoneInfoRaw;
		if (!data)
			return;
		if (data.length == 560) {
			// V1 (old loaders)
			this.phoneInfo = {
				kind: "v1",
				fwVersion: data[0x150],
				langPack: decodeCString(data.subarray(0x160, 0x170)),
				model: decodeCString(data.subarray(0x170, 0x180)),
				manufacturer: decodeCString(data.subarray(0x180, 0x190)),
				someInfo: decodeCString(data.subarray(0x190, 0x1A0)),
				phoneId0: data.readUInt32LE(0x200),
				phoneId1: data.readUInt32LE(0x204),
				flash0Type: data.readUInt32LE(0x208),
				flash1Type: data.readUInt32LE(0x20C),
			};
		} else if (data.length == 224) {
			// V2
			this.phoneInfo = {
				kind: "v1",
				fwVersion: data[0],
				langPack: decodeCString(data.subarray(0x10, 0x20)),
				model: decodeCString(data.subarray(0x20, 0x30)),
				manufacturer: decodeCString(data.subarray(0x30, 0x40)),
				someInfo: decodeCString(data.subarray(0x40, 0x50)),
				phoneId0: data.readUInt32LE(0xB0),
				phoneId1: data.readUInt32LE(0xB4),
				flash0Type: data.readUInt32LE(0xB8),
				flash1Type: data.readUInt32LE(0xBC),
			};
		} else if (data.length >= 88) {
			// V3 (x65-family chaos loaders), 128 bytes
			const info: PhoneInfoV3 = {
				kind: "v3",
				model: decodeCString(data.subarray(0, 16)),
				manufacturer: decodeCString(data.subarray(16, 32)),
				imei: decodeCString(data.subarray(32, 48)),
				flashBaseAddr: data.readUInt32LE(64),
				flash0Type: data.readUInt32LE(80),
				flashVID: data.readUInt16LE(80),
				flashPID: data.readUInt16LE(82),
				flashSizePow: data.readUInt8(84),
				writeBufferSize: data.readUInt16LE(85),
				flashRegionsNum: data.readUInt8(87),
				regions: [],
			};
			let offset = 88;
			let total = 0;
			for (let i = 0; i < info.flashRegionsNum && offset + 4 <= data.length; i++) {
				const count = data.readUInt16LE(offset) + 1;
				const eraseSize = data.readUInt16LE(offset + 2) * 256;
				offset += 4;
				total += count * eraseSize;
				info.regions.push({ addr: info.flashBaseAddr + total, blocksCount: count, eraseSize });
			}
			this.phoneInfo = info;

			// The loader knows the flash geometry - use it when the driver file doesn't.
			if (!this.cache.isValid()) {
				this.cache.clear();
				let startAddr = info.flashBaseAddr;
				for (const region of info.regions) {
					this.cache.addGeometry(startAddr, region.eraseSize);
					startAddr += region.blocksCount * region.eraseSize;
				}
			}
		}
	}

	// Operation-wide progress scope: loaderReadMemory/loaderWriteMemory report
	// per-page progress; the scope maps it into the progress of the whole
	// operation (read/write/map), so the UI shows one continuous progress bar.
	#progressScope?: { base: number; done: number; total: number; allowReads: boolean };

	protected async withProgress<T>(total: number, allowReads: boolean, fn: () => Promise<T>): Promise<T> {
		if (this.#progressScope)
			return fn(); // nested operation: reuse the outer scope
		this.#progressScope = { base: 0, done: 0, total, allowReads };
		try {
			return await fn();
		} finally {
			this.#progressScope = undefined;
		}
	}

	// Anchors the scope progress at the current position before a page operation.
	private beginPageProgress(): void {
		const scope = this.#progressScope;
		if (scope)
			scope.base = scope.done;
	}

	private stepReadProgress(pageDone: number, pageSize: number): void {
		const scope = this.#progressScope;
		if (scope) {
			if (scope.allowReads)
				scope.done = Math.min(scope.total, scope.base + pageDone);
			this.progress(scope.done, scope.total);
		} else {
			this.progress(pageDone, pageSize);
		}
	}

	private stepWriteProgress(pageDone: number, pageSize: number): void {
		const scope = this.#progressScope;
		if (scope) {
			scope.done = Math.min(scope.total, scope.base + pageDone);
			this.progress(scope.done, scope.total);
		} else {
			this.progress(pageDone, pageSize);
		}
	}

	// Public operation entry points with the whole-operation progress.
	// The page cache is dropped before every operation so that each
	// Read Memory / Write Memory reflects the current phone state
	// (V_KLay closes the device after each operation, which clears the cache).
	async readMemory(addr: number, size: number): Promise<Uint8Array> {
		this.cache.clearCache();
		return this.withProgress(size, true, () => this.read(addr, size));
	}

	async writeMemory(addr: number, data: Uint8Array): Promise<void> {
		this.cache.clearCache();
		return this.withProgress(data.length, false, async () => {
			await this.write(addr, data);
			await this.flush();
		});
	}

	// ------------------------------------------------------------------
	// Memory read/write

	// VDevicePhone::Read()
	async read(addr: number, size: number): Promise<Uint8Array> {
		const result = Buffer.alloc(size);
		let rest = size;
		let cursor = addr;
		while (rest > 0) {
			this.checkCancel();
			const entry = this.cache.getPageAtAddr(cursor);
			if (!entry)
				throw new PhoneDeviceError(sprintf("Out of memory geometry at 0x%08X.", cursor));
			const { page, isNew } = entry;
			const offset = cursor - page.addr;
			let len = Math.min(page.size - offset, rest);
			if (isNew) {
				this.beginPageProgress();
				await this.loaderReadMemory(page.addr, page.size, page.data);
			}
			result.set(page.data.subarray(offset, offset + len), size - rest);
			cursor += len;
			rest -= len;
		}
		return result;
	}

	// VDevicePhone::Write()
	async write(addr: number, data: Uint8Array): Promise<void> {
		let rest = data.length;
		let cursor = addr;
		let offset = 0;
		while (rest > 0) {
			this.checkCancel();
			const entry = this.cache.getPageAtAddr(cursor);
			if (!entry)
				throw new PhoneDeviceError(sprintf("Out of memory geometry at 0x%08X.", cursor));
			const { page, isNew } = entry;
			const pageOffset = cursor - page.addr;
			let len = Math.min(page.size - pageOffset, rest);
			let canCompare = true;
			if (isNew) {
				if (len == page.size && pageOffset == 0) {
					canCompare = false;
				} else {
					this.beginPageProgress();
					await this.loaderReadMemory(page.addr, page.size, page.data);
				}
			}
			if (canCompare)
				canCompare = buffersEqual(page.data.subarray(pageOffset, pageOffset + len), data.subarray(offset, offset + len));
			if (!canCompare) {
				page.data.set(data.subarray(offset, offset + len), pageOffset);
				if (!page.isChanged && !this.isSkipWritingInBlock(page.addr, page.size))
					page.isChanged = true;
			}
			cursor += len;
			offset += len;
			rest -= len;
		}
	}

	// VDevicePhone::Flush()
	async flush(): Promise<void> {
		for (const page of this.cache.getPages()) {
			if (!page.isChanged)
				continue;
			this.checkCancel();
			this.beginPageProgress();
			await this.loaderWriteMemory(page.addr, page.size, page.data);
			page.isChanged = false;
		}
	}

	// VDevicePhone::IsSkipWritingInBlock()
	private isSkipWritingInBlock(addr: number, size: number): boolean {
		if (!this.opts.skipBootcore && !this.opts.skipNoWrite)
			return false;
		const end = addr + size;
		for (const area of this.phone.memAreas) {
			if (!area.isBootcore && !area.isNoWrite)
				continue;
			const beg = area.addr - this.memoryStart;
			const areaEnd = beg + area.size;
			if (addr < areaEnd && end > beg) {
				if (area.isNoWrite && this.opts.skipNoWrite)
					return true;
				if (area.isBootcore && this.opts.skipBootcore)
					return true;
			}
		}
		return false;
	}

	// ------------------------------------------------------------------
	// Loader memory commands

	private addrField(address: number, len: number): Buffer {
		const buf = Buffer.alloc(len);
		let v = BigInt(address >>> 0);
		for (let i = len - 1; i >= 0; i--) {
			buf[i] = Number(v & 0xFFn);
			v >>= 8n;
		}
		return buf;
	}

	// VDevicePhone::LoaderReadMemory()
	async loaderReadMemory(address: number, size: number, out: Uint8Array): Promise<void> {
		debug("Reading 0x%08X-0x%08X (%d bytes)", address, address + size, size);
		const opts = this.phone.opts;
		const asLen = opts.cmdAddrAndSizeLen;
		if (asLen > 7)
			throw new PhoneDeviceError("optCmdAddrAndSizeLen is too big (must be <= 7).");

		let pageSize = this.lastGoodPageSize;
		let restSize = size;
		let curAddr = address;
		let outOffset = 0;
		let decSizeTryCount = 0;
		let isErr: boolean | number = false;

		this.enterBusy();
		try {
			while (restSize != 0) {
				this.checkCancel();
				const curSize = Math.min(pageSize, restSize);
				const addr = (curAddr + this.memoryStart) >>> 0;

				debugTrx("TX: R 0x%08X:0x%08X", addr, curSize);
				await this.transport.write(Buffer.from("R", "latin1"));
				await this.transport.write(Buffer.concat([
					this.addrField(addr, asLen),
					this.addrField(curSize, asLen),
				]));

				// Read the answer. Like V_KLay's canusetmpbuf path, the whole
				// answer ([skip][data][skip][OK][checksum][skip]) is read in ONE
				// atomic transport read with inter-byte timeouts, and only then
				// sliced and verified - there are no timeout boundaries between
				// the data and the answer fields.
				// errCode: 0 = ok, 1 = generic error, 2 = data CRC error
				let errCode = 0;
				const layout = this.readAnswerLayout(curSize);
				const answer = await this.transport.read(layout.total, VDP_MEMORY_READ_TIMEOUT);
				if (!answer || answer.length != layout.total) {
					errCode = 1;
				} else {
					const data = answer.subarray(layout.dataOffset, layout.dataOffset + curSize);
					out.set(data, outOffset);

					const checkPart = () => {
						if (errCode)
							return;
						if (layout.okOffset !== undefined
							&& !answer.subarray(layout.okOffset, layout.okOffset + opts.readCmdAnswerOK.length).equals(opts.readCmdAnswerOK))
							errCode = 1;
					};
					const checkChecksum = () => {
						if (errCode)
							return;
						if (layout.checksumOffset !== undefined) {
							const expected = xorChecksum(data);
							if (answer[layout.checksumOffset] != expected || answer[layout.checksumOffset + 1] != 0)
								errCode = 2;
						}
					};

					if (opts.readCmdAnswerOrderCheckSumThenOK) {
						checkChecksum();
						checkPart();
					} else {
						checkPart();
						checkChecksum();
					}
				}

				const isErr = errCode;
				if (isErr) {
					this.errorsCorrected++;
					this.status(isErr == 2
						? sprintf("Received data CRC error at 0x%08X - reading again...", curAddr)
						: sprintf("Error when receiving data at 0x%08X - reading again...", curAddr));
					if (++decSizeTryCount >= (pageSize > VDP_READ_BIG_PAGE_SIZE_MIN
						? VDP_READ_BIG_PAGE_SIZE_TRY_COUNT : VDP_READ_PAGE_SIZE_TRY_COUNT)) {
						decSizeTryCount = 0;
						if (pageSize > VDP_READ_PAGE_SIZE_MIN)
							pageSize /= 2;
					}
					await this.throwIfLoaderNotReady();
					continue;
				}

				this.stepReadProgress(size - restSize + curSize, size);
				restSize -= curSize;
				curAddr += curSize;
				outOffset += curSize;
			}
		} finally {
			this.exitBusy();
		}

		if (pageSize >= 0x4000)
			this.lastGoodPageSize = pageSize;
	}

	// Byte layout of the loader read answer for the given data size,
	// used for the one-shot atomic answer read (V_KLay's tmpbuflen0).
	private readAnswerLayout(curSize: number): {
		total: number;
		dataOffset: number;
		okOffset?: number;
		checksumOffset?: number;
	} {
		const opts = this.phone.opts;
		let offset = Math.max(0, opts.readCmdSkipBytesAfterCmdParameters);
		const dataOffset = offset;
		offset += curSize;
		if (opts.isExistReadCmdSkipBytesAfterData)
			offset += opts.readCmdSkipBytesAfterData;

		let okOffset: number | undefined;
		if (this.readAnswerHasOK()) {
			okOffset = offset;
			offset += opts.readCmdAnswerOK.length;
		}
		if (opts.isExistReadCmdSkipBytesAfterOK)
			offset += opts.readCmdSkipBytesAfterOK;

		let checksumOffset: number | undefined;
		if (opts.readCmdAnswerCheckSumType != 0) {
			if (opts.readCmdAnswerOrderCheckSumThenOK) {
				// checksum comes before OK: recompute the positions
				let o = dataOffset + curSize
					+ (opts.isExistReadCmdSkipBytesAfterData ? opts.readCmdSkipBytesAfterData : 0);
				checksumOffset = o;
				o += 2;
				if (this.readAnswerHasOK()) {
					okOffset = o;
					o += opts.readCmdAnswerOK.length;
				}
				if (opts.isExistReadCmdSkipBytesAfterOK)
					o += opts.readCmdSkipBytesAfterOK;
				offset = o;
			} else {
				checksumOffset = offset;
				offset += 2;
			}
		}
		if (opts.isExistReadCmdSkipBytesAfterCheckSum)
			offset += opts.readCmdSkipBytesAfterCheckSum;

		return { total: offset, dataOffset, okOffset, checksumOffset };
	}

	// Whether the loader read answer contains the OK field
	// (V_KLay: m_ReadCmdAnswerOKLen != 0 && (!isExistSkipAfterData
	// || isExistAnswerOK || isExistSkipAfterOK)).
	private readAnswerHasOK(): boolean {
		const opts = this.phone.opts;
		return opts.readCmdAnswerOK.length != 0
			&& (!opts.isExistReadCmdSkipBytesAfterData
				|| opts.isExistReadCmdAnswerOK
				|| opts.isExistReadCmdSkipBytesAfterOK);
	}

	// VDevicePhone::LoaderWriteMemory()
	async loaderWriteMemory(address: number, size: number, data: Uint8Array | null): Promise<void> {
		if (data)
			debug("Writing 0x%08X-0x%08X (%d bytes)", address, address + size, size);
		const opts = this.phone.opts;
		const asLen = opts.writeCmdVersion == 1 ? VDP_CMDLDR_WRITE_ADDR_LEN : opts.cmdAddrAndSizeLen;
		if (asLen > 7)
			throw new PhoneDeviceError("optCmdAddrAndSizeLen is too big (must be <= 7).");
		const asMax = 2 ** (8 * asLen);
		const restoreBootcore = size == -1 && data === null;

		let addr = 0;
		let curSize = 0;
		let restSize = size;
		let offset = 0;

		this.enterBusy();
		try {
			while (restSize != 0) {
				this.checkCancel();

				if (restoreBootcore) {
					restSize = size = 0;
					addr = address = 0;
				} else {
					if (opts.writeCmdVersion == 1) {
						addr = Math.floor((address + (this.memoryStart - (this.phone.memFlashBase ?? this.memoryStart))) / 0x1000);
						curSize = addr * 0x1000 - (this.memoryStart - (this.phone.memFlashBase ?? this.memoryStart));
					} else {
						addr = (address + this.memoryStart) >>> 0;
						curSize = addr - this.memoryStart;
						if (addr < 0 || addr >= asMax)
							throw new PhoneDeviceError(sprintf("Address 0x%08X is out of range for the loader.", address));
						if (restSize >= asMax)
							throw new PhoneDeviceError("Write block size is out of range for the loader.");
					}

					if (this.isSkipWritingInBlock(curSize, restSize)) {
						this.status(sprintf("Skipping write to the protected block at 0x%08X.", address));
						break;
					}
				}

				// Send the command and the address (high byte first).
				debugTrx("TX: F 0x%s", this.addrField(addr, asLen).toString("hex"));
				await this.transport.write(Buffer.from("F", "latin1"));
				await this.transport.write(this.addrField(addr, asLen));

				if (opts.isExistWriteCmdSkipBytesAfterCmdParameters) {
					await this.transport.skipData(VDP_MEMORY_WRITE_ALL_PAGE_TIMEOUT, opts.writeCmdSkipBytesAfterCmdParameters);
				} else if (opts.writeCmdVersion == 1) {
					const addrAns = await this.transport.read(10, VDP_MEMORY_WRITE_ALL_PAGE_TIMEOUT);
					if (!addrAns || addrAns.length < 10) {
						throw new PhoneDeviceError(sprintf(
							"Invalid answer on the write address (len=%d, must be 10).",
							addrAns ? addrAns.length : 0));
					}
					const flashBase = addrAns.readUInt16LE(0);
					if (flashBase == VDP_CMDLDR_WRITE_ERR_ADDRESS_TOO_FAR)
						throw new PhoneDeviceError(sprintf("Address 0x%08X is too far.", address));
					if (flashBase == VDP_CMDLDR_WRITE_ERR_UNKNOWN_FLASH)
						throw new PhoneDeviceError(sprintf("Unknown flash type: 0x%04X.", addrAns.readUInt16LE(2)));
				}

				if (opts.writeCmdVersion == 1) {
					// Read the block size answer word.
					const blockSizeAns = await this.transport.read(2, VDP_MEMORY_WRITE_ALL_PAGE_TIMEOUT);
					if (!blockSizeAns || blockSizeAns.length < 2)
						throw new PhoneDeviceError("Invalid block size answer length.");
					curSize = blockSizeAns.readUInt16LE(0) * 4096;
					if (curSize > restSize)
						throw new PhoneDeviceError(sprintf(
							"The loader needs more data (%d bytes) for the current block than available (%d bytes). " +
							"Increase the block size in MCUMemGeometry for this address range in the .vkd file.",
							curSize, restSize));
				} else if (opts.writeCmdVersion == 2) {
					curSize = restSize;
					await this.transport.write(this.addrField(curSize, asLen));
				}

				// Read the answer after block size.
				if (opts.isExistWriteCmdSkipBytesAfterBlockSize) {
					await this.transport.skipData(VDP_MEMORY_READ_TIMEOUT, opts.writeCmdSkipBytesAfterBlockSize);
				} else if (opts.writeCmdVersion == 1) {
					const idAns = await this.transport.read(2, VDP_MEMORY_WRITE_ALL_PAGE_TIMEOUT);
					if (!idAns || idAns.length < 2 || idAns.readUInt16LE(0) != VDP_CMDLDR_WRITE_OK_ID)
						throw new PhoneDeviceError("Invalid id in the write address answer.");
				}

				// Send the data and the checksum.
				if (data !== null) {
					const chunk = Buffer.from(data.subarray(offset, offset + curSize));
					await this.transport.write(chunk);
					await this.transport.write(Buffer.from([xorChecksum(chunk)]));
				}

				// Read the answer after the data.
				if (opts.isExistWriteCmdSkipBytesAfterDataWithCheckSum) {
					await this.transport.skipData(VDP_MEMORY_READ_TIMEOUT, opts.writeCmdSkipBytesAfterDataWithCheckSum);
				} else {
					if (opts.writeCmdVersion == 1) {
						const full = await this.transport.read(6, VDP_MEMORY_WRITE_ALL_PAGE_TIMEOUT);
						if (!full || full.length < 6)
							throw new PhoneDeviceError("Invalid answer after the write data.");
						const err = full.readUInt16LE(0);
						if (err == VDP_CMDLDR_WRITE_DATARECEIVED_ERR_RAM_NAK)
							throw new PhoneDeviceError("Phone RAM is bad.");
						if (err == VDP_CMDLDR_WRITE_DATARECEIVED_ERR_CRC_NAK) {
							this.errorsCorrected++;
							this.status("Sent data CRC error - sending again...");
							await this.transport.skipData(VDP_WRITE_AFTER_BAD_CRC_SKIP_TIMEOUT);
							await this.throwIfLoaderNotReady();
							continue;
						}
					} else {
						const full = await this.transport.read(2, VDP_MEMORY_WRITE_ALL_PAGE_TIMEOUT);
						if (!full || full.length < 2)
							throw new PhoneDeviceError("Invalid answer after the write data.");
						const status = full.readUInt16LE(0);
						if (status == VDP_CMDLDR_WRITEV2_DATARECEIVED_ACK) {
							// ok
						} else if (status == VDP_CMDLDR_WRITEV2_DATARECEIVED_ERR_BOUNDS_NAK) {
							throw new PhoneDeviceError("Bounds error (address is not on the edge of the flash block).");
						} else if (status == VDP_CMDLDR_WRITEV2_DATARECEIVED_UNKNOWN_FLASH_NAK) {
							const flashType = await this.transport.read(2, VDP_MESSAGE_TIMEOUT);
							throw new PhoneDeviceError(sprintf(
								"Flash IC type 0x%04X is unknown for the loader.",
								flashType ? flashType.readUInt16LE(0) : 0));
						} else if (status == VDP_CMDLDR_WRITEV2_DATARECEIVED_ACCESS_DENIED_NAK) {
							throw new PhoneDeviceError("Protected area. Access denied.");
						} else if (status == VDP_CMDLDR_WRITE_DATARECEIVED_ERR_CRC_NAK) {
							this.errorsCorrected++;
							this.status("Sent data CRC error - sending again...");
							await this.transport.skipData(VDP_WRITE_AFTER_BAD_CRC_SKIP_TIMEOUT);
							await this.throwIfLoaderNotReady();
							continue;
						} else {
							throw new PhoneDeviceError(sprintf("Unknown answer on the written data: 0x%04X.", status));
						}
					}
				}

				// Read the answer after flash erase.
				if (opts.isExistWriteCmdSkipBytesAfterEraseStep) {
					await this.transport.skipData(VDP_MEMORY_WRITE_ALL_PAGE_TIMEOUT, opts.writeCmdSkipBytesAfterEraseStep);
				} else {
					const eraseAns = await this.transport.read(2, VDP_MEMORY_WRITE_ALL_PAGE_TIMEOUT);
					if (!eraseAns || eraseAns.length < 2)
						throw new PhoneDeviceError("Invalid answer after the flash erase.");
					if (eraseAns.readUInt16LE(0) != VDP_CMDLDR_WRITE_OK_ERASE)
						throw new PhoneDeviceError(sprintf(
							"Invalid answer after the flash erase: 0x%04X (must be 0x0202).",
							eraseAns.readUInt16LE(0)));

					if (opts.writeCmdVersion == 1) {
						const startWriteAns = await this.transport.read(6, VDP_MEMORY_WRITE_ALL_PAGE_TIMEOUT);
						if (!startWriteAns || startWriteAns.length < 6)
							throw new PhoneDeviceError("Invalid start write ack.");
					}
				}

				// Read the answer after flash write.
				if (opts.isExistWriteCmdSkipBytesAfterWriteStep) {
					await this.transport.skipData(VDP_MEMORY_WRITE_ALL_PAGE_TIMEOUT, opts.writeCmdSkipBytesAfterWriteStep);
				} else {
					const writeAns = await this.transport.read(2, VDP_MEMORY_WRITE_ALL_PAGE_TIMEOUT);
					if (!writeAns || writeAns.length < 2)
						throw new PhoneDeviceError("Invalid answer after the flash write.");
					if (writeAns.readUInt16LE(0) != VDP_CMDLDR_WRITE_OK_ACK)
						throw new PhoneDeviceError(sprintf(
							"Invalid answer after the flash write: 0x%04X (must be 0x0303).",
							writeAns.readUInt16LE(0)));
				}

				// Read the checksum of the written data.
				const checksumReaded = await this.transport.read(2, VDP_MEMORY_WRITE_ALL_PAGE_TIMEOUT);
				if (!checksumReaded || checksumReaded.length < 2)
					throw new PhoneDeviceError("Invalid written flash checksum length.");

				// Read the final answer.
				if (opts.isExistWriteCmdSkipBytesAfterWittenCheckSum) {
					await this.transport.skipData(VDP_MEMORY_WRITE_ALL_PAGE_TIMEOUT, opts.writeCmdSkipBytesAfterWittenCheckSum);
				} else {
					const okAns = await this.transport.read(2, VDP_MEMORY_WRITE_ALL_PAGE_TIMEOUT);
					if (!okAns || okAns.length < 2 || okAns.toString("latin1") != "OK")
						throw new PhoneDeviceError(sprintf(
							"Wrong write result: %s (must be OK).",
							okAns ? okAns.toString("latin1") : "<timeout>"));
				}

				if (data !== null) {
					const writtenChecksum = wordChecksum(data.subarray(offset, offset + curSize));
					if (checksumReaded.readUInt16LE(0) != writtenChecksum) {
						this.errorsCorrected++;
						this.status("Written data CRC error - writing again...");
						await this.transport.skipData(VDP_WRITE_AFTER_BAD_CRC_SKIP_TIMEOUT);
						await this.throwIfLoaderNotReady();
						continue;
					}
				}

				if (size > 0)
					this.stepWriteProgress((size - restSize) + curSize, size);
				restSize -= curSize;
				address += curSize;
				offset += curSize;
			}
		} finally {
			this.exitBusy();
		}
	}

	// VDevicePhone::RestoreBootcore()
	async restoreBootcore(): Promise<void> {
		if (!this.phone.opts.isRstBootcoreCmdEn)
			throw new PhoneDeviceError("This loader does not support the bootcore restoring.");
		debug("Restoring bootcore...");
		await this.loaderWriteMemory(-1, -1, null);
	}

	// The IMEI as packed BCD (see VStrAToBCD in V_Klay.cpp), 8 bytes.
	// For the old loaders the raw phone ID is used (as in V_KLay).
	private getBcdIMEI(): Buffer | undefined {
		const info = this.phoneInfo;
		if (info?.kind == "v1") {
			const imei = (BigInt(info.phoneId1 >>> 0) << 32n) | BigInt(info.phoneId0 >>> 0);
			if (imei == 0n || imei == 0xFFFFFFFFFFFFFFFFn)
				return undefined;
			const buf = Buffer.alloc(8);
			buf.writeBigUInt64LE(imei);
			return buf;
		}
		const digits = info?.kind == "v3" ? info.imei.replace(/\D/g, "") : "";
		if (!digits)
			return undefined;
		const bcd = Buffer.alloc(8);
		let p = 0;
		for (let i = digits.length - 1; i >= 0 && p < 16; i--, p++)
			bcd[p >> 1] |= (digits.charCodeAt(i) - 0x30) << ((p & 1) * 4);
		return bcd;
	}

	// Actual speed of the underlying serial port (the loader may keep it at
	// the boot speed when the baudrate command is disabled or the loader is reused).
	getBaudrate(): number {
		return this.transport.getBaudrate();
	}

	getUniqueName(): string {
		const info = this.phoneInfo;
		if (!info)
			return this.phone.name;
		if (info.kind == "v3") {
			let name = `${info.manufacturer} ${info.model}`.trim();
			if (info.imei)
				name += ` ${info.imei}`;
			return name;
		}
		let name = `${info.manufacturer} ${info.model}`.trim();
		if (info.langPack)
			name += ` ${info.langPack}`;
		if (info.fwVersion)
			name += ` fw${info.fwVersion.toString(16)}`;
		const imei = (BigInt(info.phoneId1 >>> 0) << 32n) | BigInt(info.phoneId0 >>> 0);
		if (imei != 0n && imei != 0xFFFFFFFFFFFFFFFFn)
			name += ` ${imei.toString(16).toUpperCase()}`;
		return name;
	}

	private async delay(ms: number): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(resolve, ms);
			if (this.isCanceled) {
				reject(new FlasherAbortError());
				clearTimeout(timer);
			}
		});
	}
}

export function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length != b.length)
		return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] != b[i])
			return false;
	}
	return true;
}

function decodeCString(buf: Buffer): string {
	const end = buf.indexOf(0);
	const str = end == -1 ? buf : buf.subarray(0, end);
	return str.toString("latin1").trim();
}

export function xorChecksum(data: Uint8Array): number {
	let cs = 0;
	for (let i = 0; i < data.length; i++)
		cs ^= data[i];
	return cs & 0xFF;
}

export function wordChecksum(data: Uint8Array): number {
	let cs = 0;
	for (let i = 0; i + 1 < data.length; i += 2)
		cs = (cs + (data[i] | (data[i + 1] << 8))) & 0xFFFF;
	if (data.length & 1)
		cs = (cs + data[data.length - 1]) & 0xFFFF;
	return cs;
}

function sizeToComm(size: number, sizeFieldLength: number): Buffer {
	if (sizeFieldLength <= 0) {
		sizeFieldLength = 1;
		let v = size;
		while (v >>> 8 != 0 && sizeFieldLength < 4) {
			sizeFieldLength++;
			v >>>= 8;
		}
	}
	const buf = Buffer.alloc(sizeFieldLength);
	buf.writeUIntLE(size, 0, sizeFieldLength);
	return buf;
}
