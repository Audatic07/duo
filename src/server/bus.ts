/** Server-Sent Events hub: every GUI window subscribes once and receives all events. */
import type { ServerResponse } from 'node:http';

export type BusEvent = { t: string } & Record<string, unknown>;

export class Bus {
  private readonly clients = new Set<ServerResponse>();

  add(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1500\n\n');
    this.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    res.on('close', () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  }

  emit(e: BusEvent): void {
    const data = `data: ${JSON.stringify(e)}\n\n`;
    for (const c of this.clients) c.write(data);
  }
}
