'use strict';

const https = require('https');
const http = require('http');
const url = require('url');

const PELICAN_URL  = process.env.PELICAN_URL;   // e.g. https://panel.yourdomain.com
const PELICAN_KEY  = process.env.PELICAN_API_KEY; // Application API key
const PELICAN_EGG  = parseInt(process.env.PELICAN_EGG_ID  || '0', 10);  // egg ID in panel
const PELICAN_NEST = parseInt(process.env.PELICAN_NEST_ID || '0', 10);
const PELICAN_NODE = parseInt(process.env.PELICAN_NODE_ID || '0', 10);
const PELICAN_USER = parseInt(process.env.PELICAN_USER_ID || '0', 10);  // default owner user
const CREDENTIAL_SERVER_URL = process.env.CREDENTIAL_SERVER_URL || '';
const GIT_REPO = process.env.GIT_REPO || '';
const DOCKER_IMAGE = process.env.DOCKER_IMAGE || 'ghcr.io/ptero-eggs/yolks:nodejs_22';

function request(method, endpoint, body) {
    return new Promise((resolve, reject) => {
        const parsed = url.parse(PELICAN_URL);
        const isHttps = parsed.protocol === 'https:';
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: `/api/application${endpoint}`,
            method,
            headers: {
                'Authorization': `Bearer ${PELICAN_KEY}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
        };

        const req = (isHttps ? https : http).request(options, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const json = data ? JSON.parse(data) : {};
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(json);
                    } else {
                        reject(new Error(`Pelican ${method} ${endpoint} → ${res.statusCode}: ${data}`));
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

/* List existing allocations on the node to find a free one for a given port */
async function findAllocationId(port) {
    let page = 1;
    while (true) {
        const res = await request('GET', `/nodes/${PELICAN_NODE}/allocations?page=${page}`);
        const items = res.data || [];
        for (const a of items) {
            if (a.attributes.port === port || a.attributes.port === String(port)) {
                return a.attributes.id;
            }
        }
        if (!res.meta?.pagination?.total_pages || page >= res.meta.pagination.total_pages) break;
        page++;
    }
    return null;
}

/* Create a server on Pelican and return the server object */
async function createServer({ orderId, customerEmail, port, discordToken, discordClientId }) {
    const allocationId = await findAllocationId(port);
    if (!allocationId) {
        throw new Error(`No allocation found for port ${port} on node ${PELICAN_NODE}. Add it in the panel first.`);
    }

    const setupUrl = `${CREDENTIAL_SERVER_URL}:${port}`;

    const body = {
        name: `ClanBot-${orderId}`,
        user: PELICAN_USER,
        egg: PELICAN_EGG,
        docker_image: DOCKER_IMAGE,
        startup: 'bash start-all.sh',
        environment: {
            RPP_DISCORD_TOKEN: discordToken,
            RPP_DISCORD_CLIENT_ID: discordClientId,
            CREDENTIAL_SERVER_URL: setupUrl,
            CREDENTIAL_SERVER_PORT: String(port),
            RPP_LANGUAGE: 'en',
            RPP_POLLING_INTERVAL: '3000',
            RPP_RECONNECT_INTERVAL: '15000',
            RPP_NEED_ADMIN_PRIVILEGES: 'true',
            RPP_LOG_CALL_STACK: 'false',
            GIT_REPO: GIT_REPO,
        },
        limits: {
            memory: parseInt(process.env.SERVER_MEMORY_MB || '1024', 10),
            swap: 0,
            disk: parseInt(process.env.SERVER_DISK_MB || '5120', 10),
            io: 500,
            cpu: parseInt(process.env.SERVER_CPU_PCT || '100', 10),
        },
        feature_limits: { databases: 0, backups: 1, allocations: 1 },
        allocation: { default: allocationId },
        start_on_completion: true,
        skip_scripts: false,
        oom_disabled: false,
        nest: PELICAN_NEST,
    };

    const res = await request('POST', '/servers', body);
    return {
        serverId: res.attributes?.id,
        identifier: res.attributes?.identifier,
        setupUrl,
    };
}

async function deleteServer(pelicanServerId) {
    await request('DELETE', `/servers/${pelicanServerId}`);
}

module.exports = { createServer, deleteServer, findAllocationId };
