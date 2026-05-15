import { CrawlerEncoder } from './CrawlerEncoder.js';
import { NpcEncoder } from './NpcEncoder.js';
import { PlayerEncoder, type EntityEncoder } from './PlayerEncoder.js';
import { EntityType } from '../wire.js';

const encoders = new Map<number, EntityEncoder<unknown>>();

export function registerEntityEncoder<T>(enc: EntityEncoder<T>): void {
  encoders.set(enc.type, enc);
}

export function getEntityEncoder(type: number): EntityEncoder<unknown> | undefined {
  return encoders.get(type);
}

// Phase 0 entity types. Carbon slot is reserved in the EntityType enum
// and will register here when it ships (Task 9).
registerEntityEncoder(PlayerEncoder);
registerEntityEncoder(NpcEncoder);
registerEntityEncoder(CrawlerEncoder);

// Re-export for callers that want it directly without going through the registry.
export { PlayerEncoder, NpcEncoder, CrawlerEncoder, EntityType };
