import { EventEmitter } from 'node:events';
export function createEmitter() {
  const e = new EventEmitter();
  e.setMaxListeners(50);
  return e;
}
