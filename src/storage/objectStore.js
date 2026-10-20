import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { createPresignedPost } from '@aws-sdk/s3-presigned-post'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from '../config/env.js'

// Same private bucket/credentials as files-sdk; explicit S3 calls expose policy and response controls.
const client = new S3Client({ region: process.env.AWS_REGION || 'us-east-1', endpoint: process.env.AWS_ENDPOINT_URL_S3, forcePathStyle: true })
const Bucket = env.STORAGE_BUCKET
export const objectStore = {
  pending: (ContinuationToken) => client.send(new ListObjectsV2Command({ Bucket, Prefix: 'pending/', MaxKeys: 1000, ContinuationToken })),
  upload: (Key, Body, ContentType) => client.send(new PutObjectCommand({ Bucket, Key, Body, ContentType })),
  head: (Key) => client.send(new HeadObjectCommand({ Bucket, Key })),
  async bytes(Key) {
    const { Body } = await client.send(new GetObjectCommand({ Bucket, Key }))
    return Buffer.from(await Body.transformToByteArray())
  },
  delete: (Key) => client.send(new DeleteObjectCommand({ Bucket, Key })),
  url: (Key, contentType, disposition, expiresIn = env.STORAGE_URL_EXPIRES_IN) => getSignedUrl(client, new GetObjectCommand({ Bucket, Key, ResponseContentType: contentType, ResponseContentDisposition: disposition }), { expiresIn }),
  intent: (Key, ContentType, size) => createPresignedPost(client, { Bucket, Key, Expires: 900, Fields: { 'Content-Type': ContentType }, Conditions: [['content-length-range', size, size], ['eq', '$Content-Type', ContentType]] }),
}
