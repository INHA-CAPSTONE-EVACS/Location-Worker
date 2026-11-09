# AWS EC2 deployment foundation

This directory separates the central runtime from the Location Worker runtime:

```
vehicle clients -> WebSocket Gateway (central EC2) -> Redis Stream (central EC2)
                                                    -> Location Worker EC2 instances
```

`central/` runs Redis and the locally built WebSocket Gateway on one EC2.
`worker/` builds and runs one Location Worker on each worker EC2. No ECR registry is
required. The repository does not currently contain the WebSocket Gateway source, so
the central EC2 supplies its local checkout through `WEBSOCKET_BUILD_CONTEXT`.

## Central EC2

1. Place the WebSocket Gateway source checkout on the central EC2, then copy
   `central/.env.example` to `central/.env` and set `WEBSOCKET_BUILD_CONTEXT` to it.
2. Set `REDIS_BIND_ADDRESS` to the central EC2's **private** ENI address.
3. Set `WS_BIND_ADDRESS` to the private address when an ALB/NLB terminates public
   traffic, or deliberately set the intended listener address for your topology.
4. Start the stack:

   ```sh
   cd deploy/aws/central
   docker compose --env-file .env up -d --build
   ```

Redis is password protected and persists to the Docker volume `redis-data`. Back the
central EC2's Docker data disk with EBS and include that volume in your backup plan.

## Worker EC2

1. Transfer or clone this repository's `aws` branch on each worker EC2, then copy
   `worker/.env.example` to `worker/.env`.
2. Supply the central private Redis URL and a distinct `WORKER_CONSUMER_NAME` and
   `WORKER_INSTANCE_ID` for this EC2.
3. Place the validated H3 table at `worker/edge-cell-table.json`. It is intentionally
   ignored by Git so each deployment can use its own region-specific table.
4. Build and start from the local checkout:

   ```sh
   cd deploy/aws/worker
   docker compose --env-file .env up -d --build
   ```

Each worker joins the existing `location-worker` consumer group. Redis Stream entries
are load-balanced across workers, while the existing Redis cycle claim prevents more
than one worker from publishing the same density generation.

## Required AWS boundaries

- Put central and worker EC2 instances in private subnets or otherwise keep Redis off
  the public internet.
- Central security group: allow TCP 6379 **only** from the worker security group.
- Gateway listener security group: allow the WebSocket/ALB listener only from the
  intended client or load-balancer security group. Terminate TLS at ALB/NLB or in the
  gateway; do not expose plaintext Redis to clients.
- Use a secret store (such as SSM Parameter Store or Secrets Manager) to render `.env`;
  do not commit AWS credentials or Redis passwords.

## Template verification

Run this from the repository root after changing either Compose file:

```sh
sh deploy/aws/test_compose.sh
```

It renders both templates with disposable values and asserts Redis authentication,
private address binding, local image build contexts, the worker's central Redis URL,
unique consumer identity, and the read-only H3 table mount.
