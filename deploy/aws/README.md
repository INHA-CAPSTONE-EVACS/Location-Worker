# Location Worker AWS deployment

This directory deploys only the Location Worker. It does not provision Redis, a
WebSocket gateway, or any other central service. The worker connects to the existing
central Redis endpoint supplied through `REDIS_URL`; the endpoint must be reachable
from the worker EC2 instance.

## Worker EC2

1. Transfer or clone this repository's `aws` branch on each worker EC2, then copy
   `worker/.env.example` to `worker/.env`.
2. Set `REDIS_URL` to the existing platform Redis endpoint and set a distinct
   `WORKER_CONSUMER_NAME` and `WORKER_INSTANCE_ID` for this EC2.
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
- Use a secret store (such as SSM Parameter Store or Secrets Manager) to render `.env`;
  do not commit AWS credentials or Redis passwords.

## Template verification

Run this from the repository root after changing the worker Compose file:

```sh
sh deploy/aws/test_compose.sh
```

It renders the worker template with disposable values and asserts the local image build
context, Redis endpoint wiring, unique consumer identity, and the read-only H3 table
mount.
