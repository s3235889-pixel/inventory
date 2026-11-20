import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { createHandler } from './handler.ts';
import type { LoadResult, SaveResult } from './handler.ts';

const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const url = Deno.env.get('SUPABASE_URL');
if (!secret || !url) throw new Error('Missing server configuration');
const db = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const bucket = db.storage.from('delivery-photos');
const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);

Deno.serve(createHandler({
  key,
  async loadRecords(store, month, page) {
    const { data, error } = await db.rpc('load_delivery_records', { p_store_id: store, p_month: month, p_page: page });
    return { data: data as LoadResult | null, error };
  },
  async saveRecord(args) {
    const { data, error } = await db.rpc('save_delivery_record', args);
    return { data: data as SaveResult | null, error };
  },
  async photoPath(store, id) {
    return await db.from('delivery_records').select('photo_path').eq('store_id', store).eq('id', id).is('deleted_at', null).maybeSingle();
  },
  async uploadPhoto(path, bytes, mime) {
    return await bucket.upload(path, bytes, { contentType: mime, upsert: false, cacheControl: '300' });
  },
  async removePhotos(paths) { return await bucket.remove(paths); },
  async signPhoto(path, seconds) { return await bucket.createSignedUrl(path, seconds); },
}));
