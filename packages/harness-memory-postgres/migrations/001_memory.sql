create extension if not exists vector;

create table if not exists purista_harness_memory_records (
  scope_key text not null,
  key text not null,
  value_json jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  expires_at timestamptz,
  tags_json jsonb,
  metadata_json jsonb,
  index_text text,
  vector vector,
  index_descriptor_json jsonb,
  primary key (scope_key, key)
);

create table if not exists purista_harness_memory_index (
  id smallint primary key check (id = 1),
  descriptor_json jsonb not null,
  dimensions integer not null check (dimensions > 0)
);

create index if not exists purista_harness_memory_scope_key_idx on purista_harness_memory_records(scope_key, key);
create index if not exists purista_harness_memory_text_idx on purista_harness_memory_records using gin(to_tsvector('simple', coalesce(index_text, '')));
