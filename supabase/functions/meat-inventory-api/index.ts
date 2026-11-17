import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { createHandler } from './handler.ts';
import type { MeatDay } from './handler.ts';

const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const url = Deno.env.get('SUPABASE_URL');
if (!secret || !url) throw new Error('Missing server configuration');

const db = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const key = await crypto.subtle.importKey(
  'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
);

Deno.serve(createHandler({
  key,
  async loadDays(store, start, end) {
    const { data, error } = await db.from('meat_inventory_days')
      .select('business_date,meats,note,version,updated_at')
      .eq('store_id', store).gte('business_date', start).lte('business_date', end)
      .order('business_date', { ascending: true }).limit(40);
    return { data: data as MeatDay[] | null, error };
  },
  async saveDay(args) {
    const { data, error } = await db.rpc('save_muki_meat_day', args);
    return { data: data as MeatDay | null, error };
  },
}));
