# OPA governance example

This consumer-shaped example runs one PURISTA agent tool through a real Open
Policy Agent Data API decision. It needs no model API key: a deterministic local
model proposes one synthetic transfer, OPA allows or denies it, and the output
shows whether the tool handler actually ran.

## What it proves

```text
scripted model -> parsed transfer_funds input -> typed mapInput -> OPA
                                                           |
                              handler runs <- allow/deny <- validated result
```

- The OPA transport is independent of the model provider and deployment
  topology.
- Only `tool`, `amount`, and `destination` leave the Harness process.
- An allow decision starts the handler; a deny or undefined decision suppresses
  it.
- Routine tests use the strict fake and require no OPA process or credentials.

This is synthetic data. In a real application, authenticated principal,
tenant, action, and resource identity must come from the application boundary,
not the model or tool arguments.

## Run OPA

From this directory, start the reviewed OPA version with the bundled Rego file:

```sh
docker run --rm \
  --name purista-opa-example \
  -p 127.0.0.1:8181:8181 \
  -v "$(pwd)/policy:/policy:ro" \
  openpolicyagent/opa:1.17.0 \
  run --server --addr=0.0.0.0:8181 /policy
```

Verify health and the loaded decision before running the application:

```sh
curl --fail 'http://127.0.0.1:8181/health?bundles&plugins'

curl --fail \
  --request POST \
  --header 'content-type: application/json' \
  --data '{"input":{"tool":"transfer_funds","amount":250,"destination":"acct_savings"}}' \
  http://127.0.0.1:8181/v1/data/purista/bank/transfer/decision
```

Pin and review the OPA image and Rego bundle in production rather than copying a
floating tag. The version above is the version validated for this example.

If OPA is already installed locally, validate the policy without Docker:

```sh
opa check policy/transfer.rego
```

## Run the application

The package installs every runtime dependency from npm:

```sh
cp .env.example .env
npm install
npm run typecheck
npm test
npm run build
npm start
```

With the default `TRANSFER_AMOUNT=250`, expect `handlerCalls: 1` and an allow
`policy.evaluated` event. Change `.env` to `TRANSFER_AMOUNT=1500`, rebuild is not
required, and run `npm start` again. Expect `handlerCalls: 0` and a deny event
with rule `opa_transfer_limit`.

`OPA_TOKEN` is optional and only demonstrates a static gateway bearer token.
Prefer workload identity or mTLS where the deployment platform provides it;
never commit a populated `.env` file.

## Test boundaries

`npm test` injects `FakeOpaDataApi` and proves:

- the exact minimized JSON request;
- allow starts the handler;
- deny suppresses the handler; and
- OPA's undefined-document response falls through to Harness
  `defaultEffect: 'deny'`.

The fake does not parse Rego and cannot prove bundle loading, platform identity,
network policy, decision-log masking, or behavior of the deployed OPA build.
Use `opa check`/OPA policy tests and a selected live deployment test for those
claims.

Read the [adapter package guide](../../packages/harness-policy-opa/README.md),
the [OPA REST API](https://www.openpolicyagent.org/docs/rest-api), and the
[OPA deployment guidance](https://www.openpolicyagent.org/docs/deployments).
