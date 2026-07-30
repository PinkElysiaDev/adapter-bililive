import { createHash, createHmac, randomBytes } from 'node:crypto'

export function getOpenPlatformHeaders(
  body: object,
  accessKey: string,
  accessSecret: string,
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000)
  const headers: Record<string, string> = {
    'x-bili-accesskeyid': accessKey,
    'x-bili-content-md5': createHash('md5').update(JSON.stringify(body)).digest('hex'),
    'x-bili-signature-method': 'HMAC-SHA256',
    'x-bili-signature-nonce': randomBytes(16).toString('hex'),
    'x-bili-signature-version': '1.0',
    'x-bili-timestamp': String(timestamp),
  }
  const signatureSource = Object.keys(headers).sort().map(key => `${key}:${headers[key]}`).join('\n')
  const authorization = createHmac('sha256', accessSecret).update(signatureSource).digest('hex')
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...headers,
    Authorization: authorization,
  }
}
