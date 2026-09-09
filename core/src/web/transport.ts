// WebSerial implementation of the flasher transport, based on AsyncSerialPort
// from @sie-js/serial (the same stack the other tools of this app use).

import { Buffer } from "buffer";
import { FlasherTransport, SerialSignals } from "../transport.js";

// The part of AsyncSerialPort (@sie-js/serial) the transport uses. Structural
// on purpose: the consumer may resolve its own copy of @sie-js/serial, whose
// class type is nominal (private fields), so the class itself cannot be used
// as the parameter type here.
export interface FlasherSerialPort {
	write(data: Uint8Array): Promise<void>;
	read(size: number, timeout?: number): Promise<Uint8Array | undefined>;
	readByte(timeout?: number): Promise<number>;
	update(settings: { baudRate: number }): Promise<void>;
	readonly baudRate: number;
	setSignals(signals: { dtr?: boolean; rts?: boolean; break?: boolean }): Promise<void>;
	close(): Promise<void>;
}

export class AsyncSerialPortTransport implements FlasherTransport {
	private readonly port: FlasherSerialPort;

	constructor(port: FlasherSerialPort) {
		this.port = port;
	}

	async write(data: Uint8Array): Promise<void> {
		await this.port.write(Buffer.from(data));
	}

	async read(size: number, timeoutMS: number, nextBytesTimeoutMS: number = timeoutMS): Promise<Buffer | undefined> {
		// V_KLay CommRead() semantics: the FIRST byte is waited for up to
		// timeoutMS; every following chunk resets an inter-byte (idle) timeout
		// of nextBytesTimeoutMS. A big page that streams steadily for seconds
		// is thus never aborted mid-flight (a total-timeout read would corrupt
		// the retry alignment, see VDevicePhone::CommRead).
		let result = Buffer.alloc(0);
		let timeout = timeoutMS;
		while (result.length < size) {
			const chunk = await this.port.read(size - result.length, timeout);
			if (!chunk || !chunk.length)
				break; // idle timeout: the phone stopped sending
			result = result.length
				? Buffer.concat([result, chunk])
				: Buffer.from(chunk);
			timeout = nextBytesTimeoutMS;
		}
		return result.length ? result : undefined;
	}

	async readByte(timeoutMS: number): Promise<number> {
		return this.port.readByte(timeoutMS);
	}

	async skipData(timeoutMS: number, maxCount?: number): Promise<number> {
		if (maxCount === 0)
			return 0;
		const deadline = Date.now() + timeoutMS;
		let skipped = 0;
		while (Date.now() < deadline) {
			if (maxCount !== undefined && maxCount != -1 && skipped >= maxCount)
				break;
			const byte = await this.port.readByte(timeoutMS);
			if (byte == -1)
				break;
			skipped++;
		}
		return skipped;
	}

	async updateBaudrate(baudrate: number): Promise<void> {
		await this.port.update({ baudRate: baudrate });
	}

	getBaudrate(): number {
		return this.port.baudRate;
	}

	async setSignals(signals: SerialSignals): Promise<void> {
		await this.port.setSignals(signals);
	}

	async flush(): Promise<void> {
		// Purge the input buffer.
		for (let i = 0; i < 10000; i++) {
			if (await this.port.readByte(1) == -1)
				break;
		}
	}

	async close(): Promise<void> {
		await this.port.close();
	}
}
