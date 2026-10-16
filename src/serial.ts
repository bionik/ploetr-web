import { Emitter } from './emitter';

type SerialEvents = {
  line: string;
  close: void;
};

/** Line-oriented Web Serial transport. */
export class SerialTransport extends Emitter<SerialEvents> {
  private port: SerialPort | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private readDone: Promise<void> = Promise.resolve();
  private encoder = new TextEncoder();

  static get supported(): boolean {
    return 'serial' in navigator;
  }

  get isOpen(): boolean {
    return this.port !== null;
  }

  /** Prompts the user for a port (must be called from a user gesture) and opens it. */
  async open(baudRate: number): Promise<void> {
    if (!SerialTransport.supported) throw new Error('Web Serial is not supported in this browser (use Chrome or Edge).');
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate });
    this.port = port;
    this.writer = port.writable!.getWriter();
    navigator.serial.addEventListener('disconnect', this.onDisconnect);
    this.readDone = this.readLoop(port);
  }

  async close(): Promise<void> {
    const port = this.port;
    if (!port) return;
    this.port = null;
    navigator.serial.removeEventListener('disconnect', this.onDisconnect);
    try {
      await this.reader?.cancel();
    } catch { /* already closed */ }
    await this.readDone;
    try {
      this.writer?.releaseLock();
    } catch { /* already released */ }
    this.reader = this.writer = null;
    try {
      await port.close();
    } catch { /* port may already be gone */ }
    this.emit('close', undefined);
  }

  /** Writes text as-is (caller adds newlines). */
  async write(text: string): Promise<void> {
    if (!this.writer) throw new Error('Not connected');
    await this.writer.write(this.encoder.encode(text));
  }

  /** Writes raw bytes, used for GRBL real-time commands. */
  async writeBytes(...bytes: number[]): Promise<void> {
    if (!this.writer) throw new Error('Not connected');
    await this.writer.write(new Uint8Array(bytes));
  }

  private onDisconnect = (e: Event) => {
    if ((e as Event & { target: SerialPort }).target === this.port) void this.close();
  };

  private async readLoop(port: SerialPort): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    const reader = (this.reader = port.readable!.getReader());
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buffer.search(/\r?\n/)) >= 0) {
          const line = buffer.slice(0, i).trim();
          buffer = buffer.slice(buffer[i] === '\r' ? i + 2 : i + 1);
          if (line) this.emit('line', line);
        }
      }
    } catch {
      // Device lost or reader cancelled.
    } finally {
      reader.releaseLock();
      if (this.port === port) void this.close();
    }
  }
}
