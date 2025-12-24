import { defineConfig } from 'vite'

export default defineConfig({
    server: {
        port: 5173,
        proxy: {
            // Proxy for MinIO on port 9000
            '/s3-9000': {
                target: 'http://localhost:9000',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/s3-9000/, ''),
            },
            // Proxy for S3 on port 3000
            '/s3-3000': {
                target: 'http://localhost:3000',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/s3-3000/, ''),
            }
        }
    }
})
