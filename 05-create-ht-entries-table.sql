-- ============================================================
-- PRF Manufacturing Dashboard — Heat Treatment Module
-- Creates the real database table for HT production entries.
-- ============================================================
-- Run this in Supabase Dashboard → SQL Editor → New Query.
-- This is a brand new table — nothing existing is touched.
-- Built as a real table from the start (not the shared kv_store
-- blob pattern) to avoid the same concurrent-save data-loss bug
-- that Forging entries originally had.
-- ============================================================

create table if not exists public.prf_ht_entries (
  id text primary key,
  date text not null,
  shift_id text,
  site_id text,
  location_id text,
  furnace_id text,              -- machine id (the furnace), from the shared Machines list
  item_id text,                 -- product code
  qty_kg numeric,
  job_change_count numeric,
  job_change_loss_minutes numeric,
  downtime_blocks jsonb default '[]'::jsonb,   -- [{reasonId, remark, from, to, minutes}]
  erp_done_kg numeric default 0,
  operator_name text,
  supervisor_id text,
  supervisor_name text,
  created_at timestamptz,
  last_edited_by text,
  last_edited_by_name text,
  last_edited_at timestamptz
);

create index if not exists prf_ht_entries_date_idx on public.prf_ht_entries (date);
create index if not exists prf_ht_entries_furnace_idx on public.prf_ht_entries (furnace_id);

-- Same current security posture as everything else (RLS not yet
-- enabled) — will be locked down together with the rest of the
-- app when we resume the Supabase Auth migration.
