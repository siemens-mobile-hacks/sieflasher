// Node.js serial transport for the flasher phone commands.
//
// The --serial argument accepts either a serial device path of a real service
// cable (e.g. /dev/ttyUSB0, COM3) or a socket URL for the pmb887x-emu
// emulator (tcp://host:port — QEMU exposes the phone serial port as a TCP
// chardev server — or unix:///path/to.sock). This is a CLI/tests-only
// dependency on @sie-js/serial; the core library stays transport-agnostic.

import { AsyncSerialPort } from "@sie-js/serial";
import { SerialPortStream } from "@serialport/stream";
import { SocketBinding } from "serialport-bindings-socket";
import { autoDetect } from "@sie-js/node-serialport-bindings-cpp";
import { AsyncSerialPortTransport } from "@sie-js/flasher/web";
import { FlasherTransport } from "@sie-js/flasher";

// Accepts tcp://host:port, tcp:host:port, unix:///path and unix:path.
function normalizeSocketPath(serial: string): string {
	const match = /^(tcp|unix):\/\//i.exec(serial);
	if (match)
		return serial;
	const prefix = serial.slice(0, serial.indexOf(":") + 1);
	return `${prefix.toLowerCase()}//${serial.slice(prefix.length)}`;
}

export async function openSerialTransport(serial: string, baudRate = 115200): Promise<FlasherTransport> {
	const isSocket = /^(tcp|unix):/i.test(serial);
	const stream = new SerialPortStream({
		binding: isSocket ? SocketBinding : autoDetect(),
		path: isSocket ? normalizeSocketPath(serial) : serial,
		baudRate,
		autoOpen: false,
	});
	const port = new AsyncSerialPort(stream);
	await port.open();
	return new AsyncSerialPortTransport(port);
}
