// Transport abstraction for the phone connection.
// Implemented on top of WebSerial (via AsyncSerialPort) in the browser and
// on top of node-serialport in the future CLI tool.

export interface SerialSignals {
	dtr?: boolean;
	rts?: boolean;
	break?: boolean;
}

import { Buffer } from "buffer";

export interface FlasherTransport {
	// Writes the data and waits until it is sent.
	write(data: Uint8Array): Promise<void>;
	// Reads up to `size` bytes. Waits up to `timeoutMS` for the first byte,
	// then up to `nextBytesTimeoutMS` for each following byte.
	read(size: number, timeoutMS: number, nextBytesTimeoutMS?: number): Promise<Buffer | undefined>;
	// Reads a single byte, returns -1 on timeout.
	readByte(timeoutMS: number): Promise<number>;
	// Skips and discards all pending data for up to timeoutMS ms.
	skipData(timeoutMS: number, maxCount?: number): Promise<number>;
	// Changes the baudrate of the underlying serial port.
	updateBaudrate(baudrate: number): Promise<void>;
	getBaudrate(): number;
	setSignals(signals: SerialSignals): Promise<void>;
	// Purges input and output buffers.
	flush(): Promise<void>;
	close(): Promise<void>;
}
