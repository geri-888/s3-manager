import express from 'express';
import cors from 'cors';
import { S3Client, ListBucketsCommand, ListObjectsV2Command, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, CreateBucketCommand, DeleteBucketCommand } from '@aws-sdk/client-s3';

const app = express();
const PORT = 3333;

// Middleware
app.use(cors());
app.use(express.json());

// Store active client sessions
const clients = new Map();

// Helper to get or create S3 client
function getClient(sessionId) {
    return clients.get(sessionId);
}

// Connect endpoint
app.post('/api/connect', async (req, res) => {
    const { endpoint, accessKeyId, secretAccessKey } = req.body;

    console.log(`🔌 Attempting to connect to: ${endpoint}`);

    try {
        const client = new S3Client({
            endpoint,
            region: 'us-east-1',
            credentials: {
                accessKeyId,
                secretAccessKey
            },
            forcePathStyle: true
        });

        // Test connection
        console.log('📡 Testing connection with ListBuckets...');
        const result = await client.send(new ListBucketsCommand({}));
        console.log('✅ Connection successful! Buckets:', result.Buckets?.map(b => b.Name));

        // Generate session ID
        const sessionId = Math.random().toString(36).substring(7);
        clients.set(sessionId, { client, endpoint, accessKeyId });

        res.json({ success: true, sessionId });
    } catch (error) {
        console.error('❌ Connection failed:', error.message);
        console.error('Full error:', error);
        res.status(400).json({ success: false, error: error.message });
    }
});

// List buckets
app.get('/api/buckets', async (req, res) => {
    const sessionId = req.headers['x-session-id'];
    const session = getClient(sessionId);

    if (!session) {
        return res.status(401).json({ error: 'Not connected' });
    }

    try {
        const response = await session.client.send(new ListBucketsCommand({}));
        res.json({ buckets: response.Buckets || [] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create bucket
app.post('/api/buckets', async (req, res) => {
    const sessionId = req.headers['x-session-id'];
    const session = getClient(sessionId);
    const { name } = req.body;

    if (!session) {
        return res.status(401).json({ error: 'Not connected' });
    }

    try {
        await session.client.send(new CreateBucketCommand({ Bucket: name }));
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete bucket
app.delete('/api/buckets/:name', async (req, res) => {
    const sessionId = req.headers['x-session-id'];
    const session = getClient(sessionId);
    const { name } = req.params;

    if (!session) {
        return res.status(401).json({ error: 'Not connected' });
    }

    try {
        await session.client.send(new DeleteBucketCommand({ Bucket: name }));
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// List objects
app.get('/api/buckets/:bucket/objects', async (req, res) => {
    const sessionId = req.headers['x-session-id'];
    const session = getClient(sessionId);
    const { bucket } = req.params;
    const { prefix = '' } = req.query;

    if (!session) {
        return res.status(401).json({ error: 'Not connected' });
    }

    try {
        const response = await session.client.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            Delimiter: '/'
        }));

        res.json({
            folders: response.CommonPrefixes || [],
            files: response.Contents || []
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Upload object
app.post('/api/buckets/:bucket/objects', express.raw({ type: '*/*', limit: '100mb' }), async (req, res) => {
    const sessionId = req.headers['x-session-id'];
    const session = getClient(sessionId);
    const { bucket } = req.params;
    const key = req.headers['x-object-key'];
    const contentType = req.headers['content-type'] || 'application/octet-stream';

    if (!session) {
        return res.status(401).json({ error: 'Not connected' });
    }

    try {
        await session.client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: req.body,
            ContentType: contentType
        }));
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Download object
app.get('/api/buckets/:bucket/objects/*', async (req, res) => {
    const sessionId = req.headers['x-session-id'];
    const session = getClient(sessionId);
    const { bucket } = req.params;
    const key = req.params[0];

    if (!session) {
        return res.status(401).json({ error: 'Not connected' });
    }

    try {
        const response = await session.client.send(new GetObjectCommand({
            Bucket: bucket,
            Key: key
        }));

        const chunks = [];
        for await (const chunk of response.Body) {
            chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);

        res.set('Content-Type', response.ContentType || 'application/octet-stream');
        res.set('Content-Disposition', `attachment; filename="${key.split('/').pop()}"`);
        res.send(buffer);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete object
app.delete('/api/buckets/:bucket/objects/*', async (req, res) => {
    const sessionId = req.headers['x-session-id'];
    const session = getClient(sessionId);
    const { bucket } = req.params;
    const key = req.params[0];

    if (!session) {
        return res.status(401).json({ error: 'Not connected' });
    }

    try {
        await session.client.send(new DeleteObjectCommand({
            Bucket: bucket,
            Key: key
        }));
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete folder (all objects with prefix)
app.delete('/api/buckets/:bucket/folders/*', async (req, res) => {
    const sessionId = req.headers['x-session-id'];
    const session = getClient(sessionId);
    const { bucket } = req.params;
    const prefix = req.params[0];

    if (!session) {
        return res.status(401).json({ error: 'Not connected' });
    }

    try {
        // List all objects with prefix
        const response = await session.client.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix
        }));

        // Delete each object
        for (const obj of response.Contents || []) {
            await session.client.send(new DeleteObjectCommand({
                Bucket: bucket,
                Key: obj.Key
            }));
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Disconnect
app.post('/api/disconnect', (req, res) => {
    const sessionId = req.headers['x-session-id'];
    clients.delete(sessionId);
    res.json({ success: true });
});

app.listen(PORT, () => {
    console.log(`🚀 S3 Proxy Server running on http://localhost:${PORT}`);
});
