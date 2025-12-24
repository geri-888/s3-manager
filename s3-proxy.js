/**
 * S3-Compatible API Proxy
 * Enables standard S3 clients to connect using user credentials
 */

const crypto = require('crypto');
const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

// Configuration from environment
const S3_ENDPOINT = process.env.S3_ENDPOINT;
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY;
const S3_SECRET_KEY = process.env.S3_SECRET_KEY;
const S3_BUCKET = process.env.S3_BUCKET;

// Initialize S3 client for backend
const s3Client = new S3Client({
    endpoint: S3_ENDPOINT,
    region: 'us-east-1',
    credentials: {
        accessKeyId: S3_ACCESS_KEY,
        secretAccessKey: S3_SECRET_KEY
    },
    forcePathStyle: true
});

/**
 * Parse AWS Authorization header
 * Format: AWS4-HMAC-SHA256 Credential=ACCESS_KEY/date/region/s3/aws4_request, SignedHeaders=..., Signature=...
 */
function parseAuthHeader(authHeader) {
    if (!authHeader || !authHeader.startsWith('AWS4-HMAC-SHA256')) {
        return null;
    }

    const parts = authHeader.replace('AWS4-HMAC-SHA256 ', '').split(', ');
    const result = {};

    for (const part of parts) {
        const [key, value] = part.split('=');
        if (key === 'Credential') {
            const credParts = value.split('/');
            result.accessKey = credParts[0];
            result.date = credParts[1];
            result.region = credParts[2];
            result.service = credParts[3];
        } else if (key === 'SignedHeaders') {
            result.signedHeaders = value.split(';');
        } else if (key === 'Signature') {
            result.signature = value;
        }
    }

    return result;
}

/**
 * HMAC-SHA256 helper
 */
function hmacSha256(key, data) {
    return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * Get signing key for AWS Signature v4
 */
function getSigningKey(secretKey, dateStamp, region, service) {
    const kDate = hmacSha256('AWS4' + secretKey, dateStamp);
    const kRegion = hmacSha256(kDate, region);
    const kService = hmacSha256(kRegion, service);
    const kSigning = hmacSha256(kService, 'aws4_request');
    return kSigning;
}

/**
 * Verify AWS Signature v4
 */
function verifySignature(req, user, authInfo) {
    const method = req.method;
    const uri = req.originalUrl.split('?')[0];
    const queryString = req.originalUrl.includes('?') ? req.originalUrl.split('?')[1] : '';

    // Get headers for signing
    const headers = {};
    for (const header of authInfo.signedHeaders) {
        headers[header] = req.headers[header.toLowerCase()] || '';
    }

    // Create canonical headers string
    const canonicalHeaders = authInfo.signedHeaders
        .map(h => `${h.toLowerCase()}:${(req.headers[h.toLowerCase()] || '').trim()}`)
        .join('\n') + '\n';

    // Payload hash
    const payloadHash = req.headers['x-amz-content-sha256'] ||
        crypto.createHash('sha256').update('').digest('hex');

    // Create canonical request
    const canonicalRequest = [
        method,
        uri,
        queryString,
        canonicalHeaders,
        authInfo.signedHeaders.join(';'),
        payloadHash
    ].join('\n');

    const canonicalRequestHash = crypto.createHash('sha256').update(canonicalRequest).digest('hex');

    // Create string to sign
    const amzDate = req.headers['x-amz-date'] || '';
    const dateStamp = amzDate.substring(0, 8);
    const credentialScope = `${dateStamp}/${authInfo.region}/${authInfo.service}/aws4_request`;
    const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        credentialScope,
        canonicalRequestHash
    ].join('\n');

    // Calculate signature
    const signingKey = getSigningKey(user.secret_key, dateStamp, authInfo.region, authInfo.service);
    const calculatedSignature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    return calculatedSignature === authInfo.signature;
}

/**
 * XML Response helpers
 */
function xmlHeader() {
    return '<?xml version="1.0" encoding="UTF-8"?>';
}

function errorXml(code, message) {
    return `${xmlHeader()}
<Error>
  <Code>${code}</Code>
  <Message>${message}</Message>
</Error>`;
}

function listBucketsXml(bucketName) {
    const now = new Date().toISOString();
    return `${xmlHeader()}
<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Owner>
    <ID>user</ID>
    <DisplayName>user</DisplayName>
  </Owner>
  <Buckets>
    <Bucket>
      <Name>${bucketName}</Name>
      <CreationDate>${now}</CreationDate>
    </Bucket>
  </Buckets>
</ListAllMyBucketsResult>`;
}

function listObjectsXml(bucketName, prefix, objects, folders) {
    const contents = objects.map(obj => `
    <Contents>
      <Key>${obj.Key}</Key>
      <LastModified>${obj.LastModified?.toISOString() || new Date().toISOString()}</LastModified>
      <Size>${obj.Size || 0}</Size>
      <StorageClass>STANDARD</StorageClass>
    </Contents>`).join('');

    const prefixes = folders.map(f => `
    <CommonPrefixes>
      <Prefix>${f}</Prefix>
    </CommonPrefixes>`).join('');

    return `${xmlHeader()}
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${bucketName}</Name>
  <Prefix>${prefix || ''}</Prefix>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>false</IsTruncated>
  ${contents}
  ${prefixes}
</ListBucketResult>`;
}

/**
 * Create S3 Proxy middleware
 */
function createS3Proxy(queryUserByAccessKey) {
    return async (req, res, next) => {
        // Only handle S3 API requests (check for AWS auth header)
        const authHeader = req.headers['authorization'];
        console.log(`[S3-Proxy] Request: ${req.method} ${req.path}`);
        console.log(`[S3-Proxy] Auth Header:`, authHeader);

        // Check if it's likely an S3 client - connection check or actual request
        if (!authHeader || !authHeader.startsWith('AWS4-HMAC-SHA256')) {
            // Debug: Log if we are skipping potential S3 requests
            if (req.headers['user-agent'] && (req.headers['user-agent'].includes('aws-cli') || req.headers['user-agent'].includes('S3'))) {
                console.log('[S3-Proxy] WARNING: S3-like User-Agent detected but no Auth header!', req.headers['user-agent']);
            }
            return next(); // Not an S3 request, continue to web app
        }

        // Parse auth header
        const authInfo = parseAuthHeader(authHeader);
        if (!authInfo || !authInfo.accessKey) {
            res.set('Content-Type', 'application/xml');
            return res.status(403).send(errorXml('AccessDenied', 'Invalid authorization header'));
        }

        // Look up user by access key
        const user = queryUserByAccessKey(authInfo.accessKey);
        if (!user) {
            res.set('Content-Type', 'application/xml');
            return res.status(403).send(errorXml('InvalidAccessKeyId', 'The access key does not exist'));
        }

        if (user.is_suspended) {
            res.set('Content-Type', 'application/xml');
            return res.status(403).send(errorXml('AccountProblem', 'Account is suspended'));
        }

        // Verify signature
        const isValid = verifySignature(req, user, authInfo);
        if (!isValid) {
            res.set('Content-Type', 'application/xml');
            return res.status(403).send(errorXml('SignatureDoesNotMatch', 'The request signature does not match'));
        }

        // User prefix for all operations
        const userPrefix = `users/${user.folder_id}/`;

        res.set('Content-Type', 'application/xml');

        try {
            const path = req.path;
            const method = req.method;

            // GET / - List Buckets
            if (method === 'GET' && path === '/') {
                return res.send(listBucketsXml('files'));
            }

            // Parse bucket and key from path
            const pathParts = path.split('/').filter(Boolean);
            const bucket = pathParts[0];
            const key = pathParts.slice(1).join('/');

            // GET /bucket - List Objects
            if (method === 'GET' && !key) {
                const prefix = req.query.prefix || '';
                const delimiter = req.query.delimiter || '/';

                const command = new ListObjectsV2Command({
                    Bucket: S3_BUCKET,
                    Prefix: userPrefix + prefix,
                    Delimiter: delimiter
                });

                const result = await s3Client.send(command);

                // Remove user prefix from results
                const objects = (result.Contents || []).map(obj => ({
                    ...obj,
                    Key: obj.Key.replace(userPrefix, '')
                }));

                const folders = (result.CommonPrefixes || []).map(p => p.Prefix.replace(userPrefix, ''));

                return res.send(listObjectsXml(bucket, prefix, objects, folders));
            }

            // GET /bucket/key - Get Object
            if (method === 'GET' && key) {
                const command = new GetObjectCommand({
                    Bucket: S3_BUCKET,
                    Key: userPrefix + key
                });

                const result = await s3Client.send(command);

                res.set('Content-Type', result.ContentType || 'application/octet-stream');
                res.set('Content-Length', result.ContentLength);
                res.set('ETag', result.ETag);
                res.set('Last-Modified', result.LastModified?.toUTCString());

                result.Body.pipe(res);
                return;
            }

            // HEAD /bucket/key - Head Object
            if (method === 'HEAD' && key) {
                const command = new HeadObjectCommand({
                    Bucket: S3_BUCKET,
                    Key: userPrefix + key
                });

                const result = await s3Client.send(command);

                res.set('Content-Type', result.ContentType || 'application/octet-stream');
                res.set('Content-Length', result.ContentLength);
                res.set('ETag', result.ETag);
                res.set('Last-Modified', result.LastModified?.toUTCString());

                return res.status(200).end();
            }

            // PUT /bucket/key - Put Object
            if (method === 'PUT' && key) {
                // Collect request body
                const chunks = [];
                for await (const chunk of req) {
                    chunks.push(chunk);
                }
                const body = Buffer.concat(chunks);

                const command = new PutObjectCommand({
                    Bucket: S3_BUCKET,
                    Key: userPrefix + key,
                    Body: body,
                    ContentType: req.headers['content-type'] || 'application/octet-stream'
                });

                const result = await s3Client.send(command);

                res.set('ETag', result.ETag);
                return res.status(200).end();
            }

            // DELETE /bucket/key - Delete Object
            if (method === 'DELETE' && key) {
                const command = new DeleteObjectCommand({
                    Bucket: S3_BUCKET,
                    Key: userPrefix + key
                });

                await s3Client.send(command);
                return res.status(204).end();
            }

            // Unsupported operation
            res.status(501).send(errorXml('NotImplemented', 'This operation is not supported'));

        } catch (err) {
            console.error('S3 Proxy Error:', err);
            if (err.name === 'NoSuchKey') {
                return res.status(404).send(errorXml('NoSuchKey', 'The specified key does not exist'));
            }
            res.status(500).send(errorXml('InternalError', err.message));
        }
    };
}

module.exports = { createS3Proxy };
