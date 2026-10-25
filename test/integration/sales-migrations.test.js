import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import pg from 'pg'
import {describe,it,expect} from 'vitest'

describe.skipIf(!process.env.TEST_DATABASE_URL)('additive sales migrations on a disposable local schema',()=>{
 it('builds concurrent indexes, preserves legacy violations and reverses without changing rows',async()=>{
  const url=new URL(process.env.TEST_DATABASE_URL)
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Local disposable database required')
  const db=new pg.Client({connectionString:url.href}),schema='sales_migration_'+crypto.randomUUID().replaceAll('-','')
  await db.connect()
  try {
   await db.query(`CREATE SCHEMA ${schema}`);await db.query(`SET search_path TO ${schema},public`)
   await db.query('CREATE TABLE leads (organization_id uuid NOT NULL,id uuid NOT NULL,UNIQUE(organization_id,id))')
   await db.query('CREATE TABLE deals (id uuid PRIMARY KEY,organization_id uuid NOT NULL,lead_id uuid,source_id uuid)')
   const org=crypto.randomUUID(),foreign=crypto.randomUUID(),lead=crypto.randomUUID()
   await db.query('INSERT INTO leads VALUES ($1,$2)',[org,lead])
   await db.query('INSERT INTO deals VALUES ($1,$2,$3,NULL)',[crypto.randomUUID(),foreign,lead])
   const paths=['20261025090000_deal_lead_lookup','20261025090100_deal_source_lookup','20261025090200_deal_lead_tenant_link']
   const migrations=await Promise.all(paths.map(name=>fs.readFile(new URL('../../prisma/migrations/'+name+'/migration.sql',import.meta.url),'utf8')))
   for(const sql of migrations)await db.query(sql)
   const constraint=(await db.query("SELECT convalidated FROM pg_constraint WHERE conname='deals_organization_id_lead_id_fkey' AND conrelid='deals'::regclass")).rows[0]
   expect(constraint.convalidated).toBe(false)
   expect((await db.query("SELECT count(*)::int n FROM pg_index WHERE indrelid='deals'::regclass AND indisvalid")).rows[0].n).toBe(3)
   await expect(db.query('INSERT INTO deals VALUES ($1,$2,$3,NULL)',[crypto.randomUUID(),foreign,lead])).rejects.toMatchObject({code:'23503'})
   await db.query('INSERT INTO deals VALUES ($1,$2,$3,NULL)',[crypto.randomUUID(),org,lead])
   await db.query('ALTER TABLE deals DROP CONSTRAINT deals_organization_id_lead_id_fkey')
   await db.query('DROP INDEX CONCURRENTLY deals_organization_id_lead_id_idx')
   await db.query('DROP INDEX CONCURRENTLY deals_organization_id_source_id_idx')
   expect((await db.query('SELECT COUNT(*)::int n FROM deals')).rows[0].n).toBe(2)
   for(const sql of migrations)await db.query(sql)
   expect((await db.query('SELECT COUNT(*)::int n FROM deals')).rows[0].n).toBe(2)
  } finally {await db.query('SET search_path TO public');await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await db.end()}
 })
})
