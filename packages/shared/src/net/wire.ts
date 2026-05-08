// Binary wire format primitives. Little-endian throughout.
//
// Every message starts with a 4-byte header:
//   u16 messageType
//   u16 schemaVersion
//
// Beyond that, payload is message-specific. Encoders use BinaryWriter,
// decoders use BinaryReader. Both are zero-allocation in the hot path
// (BinaryWriter only grows when capacity is exceeded).

const utf8Enc = new TextEncoder();
const utf8Dec = new TextDecoder('utf-8', { fatal: true });

export const enum MessageType {
  // Client -> Server
  Hello = 0x0001,
  Input = 0x0002,
  Ping = 0x0003,
  AddBot = 0x0004,
  SetReady = 0x0005,
  StartGame = 0x0006,
  SetLobbySettings = 0x0007,
  SetNpcCount = 0x0008,
  // Bidirectional (signalling, carried over the WS control plane)
  RtcOffer = 0x0010, // server -> client
  RtcAnswer = 0x0011, // client -> server
  RtcIce = 0x0012, // both directions
  // Server -> Client
  Welcome = 0x0081,
  Snapshot = 0x0082,
  Pong = 0x0083,
  Error = 0x0084,
  PlayerJoined = 0x0085,
  PlayerLeft = 0x0086,
}

export const enum EntityType {
  Player = 1,
  NPC = 2,
  // Reserved for future:
  // Electrode = 3,
  // Projectile = 4,
}

export class BinaryWriter {
  private buf: ArrayBuffer;
  private view: DataView;
  private bytes: Uint8Array;
  private offset = 0;

  constructor(initialCapacity = 256) {
    this.buf = new ArrayBuffer(initialCapacity);
    this.view = new DataView(this.buf);
    this.bytes = new Uint8Array(this.buf);
  }

  private ensure(extra: number): void {
    const needed = this.offset + extra;
    if (needed <= this.buf.byteLength) return;
    let cap = this.buf.byteLength;
    while (cap < needed) cap *= 2;
    const nb = new ArrayBuffer(cap);
    new Uint8Array(nb).set(this.bytes);
    this.buf = nb;
    this.view = new DataView(nb);
    this.bytes = new Uint8Array(nb);
  }

  u8(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.offset, v);
    this.offset += 1;
  }
  i8(v: number): void {
    this.ensure(1);
    this.view.setInt8(this.offset, v);
    this.offset += 1;
  }
  u16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.offset, v, true);
    this.offset += 2;
  }
  i16(v: number): void {
    this.ensure(2);
    this.view.setInt16(this.offset, v, true);
    this.offset += 2;
  }
  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.offset, v >>> 0, true);
    this.offset += 4;
  }
  i32(v: number): void {
    this.ensure(4);
    this.view.setInt32(this.offset, v | 0, true);
    this.offset += 4;
  }
  f32(v: number): void {
    this.ensure(4);
    this.view.setFloat32(this.offset, v, true);
    this.offset += 4;
  }
  f64(v: number): void {
    this.ensure(8);
    this.view.setFloat64(this.offset, v, true);
    this.offset += 8;
  }

  // LEB128 unsigned varint, max 5 bytes (covers u32).
  varuint(v: number): void {
    let n = v >>> 0;
    while (n >= 0x80) {
      this.u8((n & 0x7f) | 0x80);
      n = n >>> 7;
    }
    this.u8(n & 0x7f);
  }

  string(s: string): void {
    const enc = utf8Enc.encode(s);
    this.varuint(enc.length);
    this.ensure(enc.length);
    this.bytes.set(enc, this.offset);
    this.offset += enc.length;
  }

  bytesRaw(src: Uint8Array): void {
    this.ensure(src.length);
    this.bytes.set(src, this.offset);
    this.offset += src.length;
  }

  // Snapshot of the written portion. Cheap (subarray view).
  finish(): Uint8Array {
    return new Uint8Array(this.buf, 0, this.offset);
  }

  get size(): number {
    return this.offset;
  }
}

export class BinaryReader {
  private view: DataView;
  private bytes: Uint8Array;
  private offset = 0;

  constructor(src: Uint8Array | ArrayBuffer) {
    if (src instanceof ArrayBuffer) {
      this.view = new DataView(src);
      this.bytes = new Uint8Array(src);
    } else {
      this.view = new DataView(src.buffer, src.byteOffset, src.byteLength);
      this.bytes = src;
    }
  }

  private need(n: number): void {
    if (this.offset + n > this.bytes.byteLength) {
      throw new RangeError(
        `BinaryReader underrun: need ${n} more bytes at offset ${this.offset}, buffer is ${this.bytes.byteLength}`,
      );
    }
  }

  u8(): number {
    this.need(1);
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }
  i8(): number {
    this.need(1);
    const v = this.view.getInt8(this.offset);
    this.offset += 1;
    return v;
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }
  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }
  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }

  varuint(): number {
    let n = 0;
    let shift = 0;
    for (let i = 0; i < 5; i++) {
      const b = this.u8();
      n |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return n >>> 0;
      shift += 7;
    }
    throw new RangeError('varuint exceeds 5 bytes');
  }

  string(): string {
    const len = this.varuint();
    this.need(len);
    const s = utf8Dec.decode(this.bytes.subarray(this.offset, this.offset + len));
    this.offset += len;
    return s;
  }

  bytesRaw(len: number): Uint8Array {
    this.need(len);
    const v = this.bytes.subarray(this.offset, this.offset + len);
    this.offset += len;
    return v;
  }

  get pos(): number {
    return this.offset;
  }
  get remaining(): number {
    return this.bytes.byteLength - this.offset;
  }
}

export interface MessageHeader {
  type: MessageType;
  schemaVersion: number;
}

export function writeHeader(w: BinaryWriter, type: MessageType, schemaVersion: number): void {
  w.u16(type);
  w.u16(schemaVersion);
}

export function readHeader(r: BinaryReader): MessageHeader {
  const type = r.u16();
  const schemaVersion = r.u16();
  return { type, schemaVersion };
}
