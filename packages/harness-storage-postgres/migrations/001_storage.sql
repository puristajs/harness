create table if not exists purista_harness_storage_schema (
  id smallint primary key check (id = 1),
  version integer not null check (version > 0),
  applied_at timestamptz not null default now()
);

insert into purista_harness_storage_schema(id, version)
values (1, 1)
on conflict (id) do nothing;

create table if not exists purista_harness_sessions (
  id text primary key,
  instance_id text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  run_count integer not null check (run_count >= 0),
  identity_json jsonb,
  sandbox_binding_json jsonb not null,
  metadata_json jsonb
);

create table if not exists purista_harness_messages (
  id text primary key,
  session_id text not null,
  run_id text,
  role text not null,
  content text not null,
  tool_calls_json jsonb,
  tool_results_json jsonb,
  created_at timestamptz not null
);

create index if not exists purista_harness_messages_session_order
  on purista_harness_messages(session_id, created_at, id);

create table if not exists purista_harness_runs (
  id text primary key,
  session_id text not null,
  kind text not null,
  target text not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  status text not null,
  input_json jsonb,
  output_json jsonb,
  error_json jsonb,
  attempt integer,
  worker_id text,
  initial_step_id text,
  metadata_json jsonb
);

create index if not exists purista_harness_runs_session_order
  on purista_harness_runs(session_id, started_at, id);

create table if not exists purista_harness_run_events (
  id text primary key,
  run_id text not null,
  observed_at timestamptz not null,
  type text not null,
  payload_json jsonb not null
);

create index if not exists purista_harness_run_events_run_order
  on purista_harness_run_events(run_id, id);

create table if not exists purista_harness_run_checkpoints (
  run_id text not null,
  session_id text not null,
  lease_id text not null,
  worker_id text not null,
  step_id text not null,
  input_json jsonb not null,
  attempt integer not null,
  sequence integer not null,
  output_json jsonb,
  replay_json jsonb,
  metadata_json jsonb,
  committed_at timestamptz not null,
  primary key(run_id, step_id)
);

create index if not exists purista_harness_run_checkpoints_order
  on purista_harness_run_checkpoints(run_id, sequence);

create table if not exists purista_harness_run_leases (
  run_id text primary key,
  session_id text not null,
  worker_id text not null,
  lease_id text not null,
  expires_at timestamptz not null
);

create index if not exists purista_harness_run_leases_session
  on purista_harness_run_leases(session_id);

create table if not exists purista_harness_external_waits (
  wait_id text primary key,
  run_id text not null,
  session_id text not null,
  kind text not null,
  schema_version text not null,
  definition_version text not null,
  deadline timestamptz not null,
  status text not null,
  created_at timestamptz not null,
  resolved_at timestamptz,
  event_id text
);

create index if not exists purista_harness_external_waits_deadline
  on purista_harness_external_waits(status, deadline);

create table if not exists purista_harness_external_wait_signals (
  wait_id text not null,
  event_id text not null,
  primary key(wait_id, event_id)
);
