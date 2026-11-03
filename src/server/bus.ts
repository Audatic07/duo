/** Server-Sent Events hub: every GUI window subscribes once and receives all events. */
import type { ServerResponse } from 'node:http';

const MAX_PENDING_BYTES = 1024 * 1024;

export type BusEvent = { t: string } & Record<string, unknown>;

export class Bus {
  private readonly clients = new Set<ServerResponse>();

  add(res: ServerResponse): void {
    if (res.destroyed) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    this.clients.add(res);
    const ping = setInterval(() => this.write(res, ': ping\n\n'), 20_000);
    const cleanup = () => {
      clearInterval(ping);
      this.clients.delete(res);
    };
    res.once('close', cleanup);
    res.once('error', () => { cleanup(); res.destroy(); });
    this.write(res, 'retry: 1500\n\n');
  }

  private write(res: ServerResponse, data: string): void {
    // EventSource reconnects and reloads state. Drop a stalled window rather than retaining
    // every full-text streaming update indefinitely in Node's outgoing buffer.
    if (res.destroyed || res.writableLength > MAX_PENDING_BYTES) {
      this.clients.delete(res);
      res.destroy();
      return;
    }
    res.write(data);
  }

  emit(e: BusEvent): void {
    const data = `data: ${JSON.stringify(e)}\n\n`;
    for (const c of this.clients) this.write(c, data);
  }
}
