import * as net from 'node:net';

/** Worker와 Redis 사이에 두는 TCP 중계기. block()으로 연결을 끊어 Redis 장애를 흉내 낸다. */
export class TcpProxy {
  private blocked = false;
  private readonly sockets = new Set<net.Socket>();

  private constructor(private readonly server: net.Server) {}

  static async start(
    targetPort: number,
    targetHost = '127.0.0.1',
  ): Promise<TcpProxy> {
    const server = net.createServer(client =>
      proxy.accept(client, targetPort, targetHost),
    );
    const proxy = new TcpProxy(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return proxy;
  }

  get port(): number {
    return (this.server.address() as net.AddressInfo).port;
  }

  block(): void {
    this.blocked = true;
    for (const s of this.sockets) s.destroy();
  }

  unblock(): void {
    this.blocked = false;
  }

  async close(): Promise<void> {
    this.block();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  private accept(client: net.Socket, port: number, host: string): void {
    if (this.blocked) {
      client.destroy();
      return;
    }
    const upstream = net.connect(port, host);
    for (const s of [client, upstream]) {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
      s.on('error', () => s.destroy());
    }
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.pipe(upstream).pipe(client);
  }
}
