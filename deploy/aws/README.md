# Location Worker AWS deployment

This directory deploys only the Location Worker. It does not provision Redis, a
WebSocket gateway, or any other central service. The worker connects to the existing
central Redis endpoint. The endpoint must be reachable from the worker EC2 instance.

## Worker EC2

1. Transfer or clone this repository's `aws` branch on each worker EC2, then copy
   `worker/.env.example` to `worker/.env`.
2. In `worker/.env`, set only the existing Redis endpoint's VPC-private IP
   (`REDIS_HOST`) and port (`REDIS_PORT`). Container hostnames automatically supply
   unique consumer and instance identifiers.
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

- Allow worker EC2 instances to reach the existing Redis endpoint only through its
  approved private network path and security-group rule.
- Keep the Redis endpoint reachable only through its approved VPC route and
  security-group rule. This worker-only template assumes that endpoint does not
  require Redis authentication.

## Template verification

Run this from the repository root after changing the worker Compose file:

```sh
sh deploy/aws/test_compose.sh
```

It renders the worker template with disposable values and asserts the local image build
context, Redis endpoint wiring derived from VPC IP and port, and the read-only H3
table mount.
