import * as net from 'node:net';

/**
 * Worker와 Redis 사이에 두는 TCP 중계기.
 * block()은 연결을 끊고(연결 거부), stall()은 연결을 연 채 요청 전달만 멈춘다(응답 없는 네트워크 단절).
 */
export class TcpProxy {
  private blocked = false;
  private stalled = false;
  private readonly sockets = new Set<net.Socket>();
  private readonly links = new Map<net.Socket, net.Socket>();

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

  /** 요청을 버리지 않고 붙잡아 둔다. unstall() 때 순서대로 넘긴다(RESP 순서 유지) */
  stall(): void {
    this.stalled = true;
    for (const [client, upstream] of this.links) {
      client.unpipe(upstream);
      client.pause();
    }
  }

  unstall(): void {
    this.stalled = false;
    for (const [client, upstream] of this.links) client.pipe(upstream);
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
    this.links.set(client, upstream);
    for (const s of [client, upstream]) {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
      s.on('error', () => s.destroy());
    }
    client.on('close', () => {
      this.links.delete(client);
      upstream.destroy();
    });
    upstream.on('close', () => client.destroy());
    upstream.pipe(client);
    if (this.stalled) client.pause();
    else client.pipe(upstream);
  }
}
