import { createServer } from 'node:http';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { config } from './config.js';
import { registerWordPressTools } from './tools/wordpress.js';

function buildMcpServer() {
  const server = new McpServer(
    { name: 'wordpress-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  registerWordPressTools(server);
  return server;
}

const mcpHandler = createMcpHandler(buildMcpServer);
const nodeMcpHandler = toNodeHandler(mcpHandler);

const httpServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, service: 'wordpress-mcp', version: '1.0.0' }));
      return;
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    if (config.mcpBearerToken) {
      const expected = `Bearer ${config.mcpBearerToken}`;
      if (req.headers.authorization !== expected) {
        res.writeHead(401, {
          'content-type': 'application/json; charset=utf-8',
          'www-authenticate': 'Bearer'
        });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    await nodeMcpHandler(req, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
});

httpServer.listen(config.port, config.host, () => {
  console.log(`wordpress-mcp listening on http://${config.host}:${config.port}`);
  console.log('MCP endpoint: /mcp');
  console.log('Health endpoint: /health');
});
