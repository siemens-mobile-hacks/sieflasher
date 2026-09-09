// Device abstraction (port of VDevice from VDevice.cpp).
// A device is anything the flasher can read from / write to:
// a real phone (PhoneDevice) or a fullflash dump file (FullFlashDevice).


export interface DeviceProgress {
	cursor: number;
	total: number;
	status?: string;
}

export const DeviceOperations = {
	READ: 0x01,
	WRITE: 0x02,
	RESTORE_BOOTCORE: 0x04,
} as const;

export abstract class FlasherDevice {
	// Progress callback, optional.
	onProgress?: (progress: DeviceProgress) => void;
	// Cancellation check, optional.
	isCanceled?: () => boolean;

	protected checkCancel(): void {
		if (this.isCanceled?.())
			throw new FlasherAbortError("Operation canceled by user.");
	}

	protected progress(cursor: number, total: number, status?: string): void {
		this.onProgress?.({ cursor, total, status });
	}

	abstract open(): Promise<void>;
	abstract close(): Promise<void>;
	abstract read(addr: number, size: number): Promise<Uint8Array>;
	abstract write(addr: number, data: Uint8Array): Promise<void>;
	abstract flush(): Promise<void>;
	abstract abort(): Promise<void>;

	// Restore bootcore of the phone to its original state.
	async restoreBootcore(): Promise<void> {
		throw new Error("This device does not support bootcore restoring.");
	}

	abstract getMemorySize(): number;
	abstract getMemoryStart(): number;
	abstract getUniqueName(): string;

	getSupportedOperations(): number {
		return DeviceOperations.READ | DeviceOperations.WRITE;
	}
}

// The default dump file name, like V_KLay's GetDefaultFlashFileName():
//   {DeviceName}_{YYYY-MM-DD_HH-MM-SS}_From_{XX}.bin
// where XX is the flash start address in 64k units (addr >> 16).
export function makeDumpFileName(deviceName: string, fromAddr: number): string {
	const name = (deviceName || "Mem").replace(/\s+/g, "_");
	const pad = (n: number) => String(n).padStart(2, "0");
	const d = new Date();
	const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
		`_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
	const from = (fromAddr >>> 16).toString(16).toUpperCase().padStart(2, "0");
	return `${name}_${ts}_From_${from}.bin`;
}

// Extracts the flash start address from the dump file name
// (port of V_KLay's GetAddrFromFileName): the trailing _HHHH / _-HHHH /
// _HH / _-HH group before the extension is the address in 64k units.
export function getAddrFromFileName(name: string): number | undefined {
	const dot = name.lastIndexOf(".");
	const base = dot == -1 ? name : name.slice(0, dot);
	const isHex = (s: string) => /^[0-9a-fA-F]+$/.test(s);
	const check = (len: number, signed: boolean): number | undefined => {
		if (base.length < len)
			return undefined;
		const tail = base.slice(base.length - len);
		if (tail[0] != "_")
			return undefined;
		let digits = tail.slice(1);
		let sign = 1;
		if (signed) {
			if (digits[0] != "-" && digits[0] != "+")
				return undefined;
			sign = digits[0] == "-" ? -1 : 1;
			digits = digits.slice(1);
		}
		if (!isHex(digits))
			return undefined;
		return sign * parseInt(digits, 16) * 0x10000;
	};
	return check(6, true) ?? check(5, false) ?? check(4, true) ?? check(3, false);
}

export class FlasherAbortError extends Error {
	constructor(message = "Operation canceled by user.") {
		super(message);
		this.name = "FlasherAbortError";
	}
}
