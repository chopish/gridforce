// Public surface of the wire protocol.
//
// `decodeMessage` reads a 4-byte header off `bytes`, then dispatches to the
// appropriate decoder. Returns a tagged union so callers can switch on `.type`.
//
// To send a message: import the matching message module and call its
// `encode(payload)` function. The returned Uint8Array starts with the header
// and is ready for `ws.send()`.

import { SCHEMA_VERSION } from '../constants.js';
import * as AddBotMsg from './messages/AddBot.js';
import * as ErrorMsg from './messages/Error.js';
import * as HelloMsg from './messages/Hello.js';
import * as InputMsg from './messages/Input.js';
import * as PingMsg from './messages/Ping.js';
import * as PlayerJoinedMsg from './messages/PlayerJoined.js';
import * as PlayerLeftMsg from './messages/PlayerLeft.js';
import * as PongMsg from './messages/Pong.js';
import * as RtcAnswerMsg from './messages/RtcAnswer.js';
import * as RtcIceMsg from './messages/RtcIce.js';
import * as RtcOfferMsg from './messages/RtcOffer.js';
import * as SetLobbySettingsMsg from './messages/SetLobbySettings.js';
import * as SetNpcCountMsg from './messages/SetNpcCount.js';
import * as SetReadyMsg from './messages/SetReady.js';
import * as SnapshotMsg from './messages/Snapshot.js';
import * as StartGameMsg from './messages/StartGame.js';
import * as WelcomeMsg from './messages/Welcome.js';
import { BinaryReader, MessageType, readHeader } from './wire.js';

// Force entity registry init.
import './entities/registry.js';

export {
  BinaryReader,
  BinaryWriter,
  EntityType,
  MessageType,
  readHeader,
  writeHeader,
} from './wire.js';
export { PlayerEncoder, PLAYER_FLAG_DASHING } from './entities/PlayerEncoder.js';
export { NpcEncoder } from './entities/NpcEncoder.js';
export type { EntityEncoder } from './entities/PlayerEncoder.js';
export {
  AddBotMsg,
  ErrorMsg,
  HelloMsg,
  InputMsg,
  PingMsg,
  PlayerJoinedMsg,
  PlayerLeftMsg,
  PongMsg,
  RtcAnswerMsg,
  RtcIceMsg,
  RtcOfferMsg,
  SetLobbySettingsMsg,
  SetNpcCountMsg,
  SetReadyMsg,
  SnapshotMsg,
  StartGameMsg,
  WelcomeMsg,
};

export type DecodedMessage =
  | { type: MessageType.Hello; payload: ReturnType<typeof HelloMsg.decode> }
  | { type: MessageType.Input; payload: ReturnType<typeof InputMsg.decode> }
  | { type: MessageType.Ping; payload: ReturnType<typeof PingMsg.decode> }
  | { type: MessageType.AddBot; payload: ReturnType<typeof AddBotMsg.decode> }
  | { type: MessageType.SetReady; payload: ReturnType<typeof SetReadyMsg.decode> }
  | { type: MessageType.StartGame; payload: ReturnType<typeof StartGameMsg.decode> }
  | { type: MessageType.SetLobbySettings; payload: ReturnType<typeof SetLobbySettingsMsg.decode> }
  | { type: MessageType.SetNpcCount; payload: ReturnType<typeof SetNpcCountMsg.decode> }
  | { type: MessageType.RtcOffer; payload: ReturnType<typeof RtcOfferMsg.decode> }
  | { type: MessageType.RtcAnswer; payload: ReturnType<typeof RtcAnswerMsg.decode> }
  | { type: MessageType.RtcIce; payload: ReturnType<typeof RtcIceMsg.decode> }
  | { type: MessageType.Welcome; payload: ReturnType<typeof WelcomeMsg.decode> }
  | { type: MessageType.Snapshot; payload: ReturnType<typeof SnapshotMsg.decode> }
  | { type: MessageType.Pong; payload: ReturnType<typeof PongMsg.decode> }
  | { type: MessageType.Error; payload: ReturnType<typeof ErrorMsg.decode> }
  | { type: MessageType.PlayerJoined; payload: ReturnType<typeof PlayerJoinedMsg.decode> }
  | { type: MessageType.PlayerLeft; payload: ReturnType<typeof PlayerLeftMsg.decode> };

export class SchemaMismatchError extends Error {
  constructor(
    public readonly expected: number,
    public readonly got: number,
  ) {
    super(`Schema version mismatch: expected ${expected}, got ${got}`);
    this.name = 'SchemaMismatchError';
  }
}

export class UnknownMessageTypeError extends Error {
  constructor(public readonly type: number) {
    super(`Unknown message type 0x${type.toString(16).padStart(4, '0')}`);
    this.name = 'UnknownMessageTypeError';
  }
}

export function decodeMessage(bytes: Uint8Array | ArrayBuffer): DecodedMessage {
  const r = new BinaryReader(bytes);
  const header = readHeader(r);
  if (header.schemaVersion !== SCHEMA_VERSION) {
    throw new SchemaMismatchError(SCHEMA_VERSION, header.schemaVersion);
  }
  switch (header.type) {
    case MessageType.Hello:
      return { type: header.type, payload: HelloMsg.decode(r) };
    case MessageType.Input:
      return { type: header.type, payload: InputMsg.decode(r) };
    case MessageType.Ping:
      return { type: header.type, payload: PingMsg.decode(r) };
    case MessageType.AddBot:
      return { type: header.type, payload: AddBotMsg.decode() };
    case MessageType.SetReady:
      return { type: header.type, payload: SetReadyMsg.decode(r) };
    case MessageType.StartGame:
      return { type: header.type, payload: StartGameMsg.decode(r) };
    case MessageType.SetLobbySettings:
      return { type: header.type, payload: SetLobbySettingsMsg.decode(r) };
    case MessageType.SetNpcCount:
      return { type: header.type, payload: SetNpcCountMsg.decode(r) };
    case MessageType.RtcOffer:
      return { type: header.type, payload: RtcOfferMsg.decode(r) };
    case MessageType.RtcAnswer:
      return { type: header.type, payload: RtcAnswerMsg.decode(r) };
    case MessageType.RtcIce:
      return { type: header.type, payload: RtcIceMsg.decode(r) };
    case MessageType.Welcome:
      return { type: header.type, payload: WelcomeMsg.decode(r) };
    case MessageType.Snapshot:
      return { type: header.type, payload: SnapshotMsg.decode(r) };
    case MessageType.Pong:
      return { type: header.type, payload: PongMsg.decode(r) };
    case MessageType.Error:
      return { type: header.type, payload: ErrorMsg.decode(r) };
    case MessageType.PlayerJoined:
      return { type: header.type, payload: PlayerJoinedMsg.decode(r) };
    case MessageType.PlayerLeft:
      return { type: header.type, payload: PlayerLeftMsg.decode(r) };
    default:
      throw new UnknownMessageTypeError(header.type);
  }
}
