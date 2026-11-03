import { createClient } from '@supabase/supabase-js'
import { env } from '../config/env.js'

// Supabase Storage (private bucket) through the Storage API, authenticated with the server-only secret key.
// Created on first use so importing this module has no side effects.
let storage
const bucket = () => (storage ??= createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } }).storage).from(env.STORAGE_BUCKET)
const unwrap = ({ data, error }) => { if (error) throw error; return data }
// Signed URLs take only a download filename; inline files are served with the content type stored at upload.
const downloadName = (disposition = '') => disposition.startsWith('attachment') ? decodeURIComponent(disposition.split("filename*=UTF-8''")[1] ?? '') || true : undefined

export const objectStore = {
  async pending(cursor) {
    const data = unwrap(await bucket().listV2({ prefix: 'pending/', limit: 1000, cursor }))
    return { Contents: data.objects.map((o) => ({ Key: o.key ?? o.name, LastModified: new Date(o.updated_at ?? o.created_at) })), NextContinuationToken: data.hasNext ? data.nextCursor : undefined }
  },
  upload: async (Key, Body, ContentType) => unwrap(await bucket().upload(Key, Body, { contentType: ContentType, upsert: true })),
  async head(Key) {
    const info = unwrap(await bucket().info(Key))
    return { ContentLength: info.size, ContentType: info.contentType }
  },
  async bytes(Key) {
    const blob = unwrap(await bucket().download(Key))
    return Buffer.from(await blob.arrayBuffer())
  },
  delete: async (Key) => unwrap(await bucket().remove([Key])),
  url: async (Key, _contentType, disposition, expiresIn = env.STORAGE_URL_EXPIRES_IN) => unwrap(await bucket().createSignedUrl(Key, expiresIn, { download: downloadName(disposition) })).signedUrl,
  // One-time signed upload (no upsert, so the token cannot overwrite). Size and type are verified again by completeUpload.
  async intent(Key, ContentType) {
    const { signedUrl } = unwrap(await bucket().createSignedUploadUrl(Key))
    return { url: signedUrl, method: 'PUT', fields: { 'Content-Type': ContentType } }
  },
}
