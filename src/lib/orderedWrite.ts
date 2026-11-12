/**
 * Ordered, coalescing terminal writes.
 *
 * Each `invoke` is an independent async command on the backend, so firing one
 * per keystroke without awaiting gives no ordering guarantee: under a burst
 * (fast typing, slow IPC on mobile) `termimus` can reach the shell as
 * `termius-m`. This keeps one write in flight per session and batches
 * whatever arrives meanwhile into the next call, which both preserves order
 * and cuts IPC round-trips.
 */

type WriteFn = (sessionId: string, data: number[]) => Promise<unknown>;

interface Queue {
  pending: number[];
  writeFn: WriteFn;
  flushing: boolean;
}

const queues = new Map<string, Queue>();

async function flush(sessionId: string, queue: Queue) {
  queue.flushing = true;
  try {
    while (queue.pending.length > 0) {
      const chunk = queue.pending;
      queue.pending = [];
      try {
        await queue.writeFn(sessionId, chunk);
      } catch (e) {
        console.error("terminal write failed:", e);
      }
    }
  } finally {
    queue.flushing = false;
    if (queue.pending.length === 0) queues.delete(sessionId);
  }
}

export function writeOrdered(sessionId: string, data: number[], writeFn: WriteFn): void {
  let queue = queues.get(sessionId);
  if (!queue) {
    queue = { pending: [], writeFn, flushing: false };
    queues.set(sessionId, queue);
  }
  queue.writeFn = writeFn;
  for (const byte of data) queue.pending.push(byte);
  if (!queue.flushing) void flush(sessionId, queue);
}
