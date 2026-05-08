// Single source of truth for the WebRTC server-side configuration.
// Reads from env so deploy can pin a UDP port range without a code
// change. Defaults are sane for development.
//
// Production checklist (mirrors the deploy README addendum):
//   1. Pick a small UDP port range to open in the GCP firewall, e.g.
//      50000-50050. Set GRIDFORCE_RTC_PORT_BEGIN / _END.
//   2. Open those ports inbound on the VM's network firewall rule.
//   3. (Optional) Run a TURN server for users behind strict NATs and
//      add it to GRIDFORCE_RTC_ICE_SERVERS as a stun:/turn: URL list.
//   4. The VM's public IP should reachable; libdatachannel discovers it
//      via the configured STUN servers.

import type { RtcConfig } from 'node-datachannel';

const DEFAULT_ICE = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];

export function rtcConfig(): RtcConfig {
  const env = process.env;
  const iceFromEnv = env.GRIDFORCE_RTC_ICE_SERVERS?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const cfg: RtcConfig = {
    iceServers: iceFromEnv && iceFromEnv.length > 0 ? iceFromEnv : DEFAULT_ICE,
  };
  const begin = Number(env.GRIDFORCE_RTC_PORT_BEGIN ?? 0);
  const end = Number(env.GRIDFORCE_RTC_PORT_END ?? 0);
  if (begin > 0 && end >= begin) {
    cfg.portRangeBegin = begin;
    cfg.portRangeEnd = end;
  }
  return cfg;
}
