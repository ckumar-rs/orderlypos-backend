import {
  Controller,
  Delete,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StaffApiKeyGuard } from '../common/guards/staff-api-key.guard';
import type { AuthenticatedRequest } from '../common/types/authenticated-request';
import { McpToolsBuilder } from './mcp-tools.builder';

// Reachable at /api/v1/mcp. Point an MCP client (Claude Desktop, etc.) at
// https://<your-orderrestro-domain>/api/v1/mcp with an
// Authorization: Bearer <staff api key> header — see
// docs/integrations-api.md's "MCP server" section, and Settings > API Keys
// & MCP to generate a key.
//
// Stateless mode (sessionIdGenerator: undefined): a fresh McpServer +
// transport per HTTP request, torn down when the response closes. No
// server-held session state, so nothing to leak or clean up between
// requests from different staff hitting the same endpoint with different
// API keys.
@UseGuards(StaffApiKeyGuard)
@Controller('v1/mcp')
export class McpController {
  constructor(private readonly toolsBuilder: McpToolsBuilder) {}

  @Post()
  async handlePost(@Req() req: Request, @Res() res: Response) {
    const user = (req as AuthenticatedRequest).user;
    const server = this.toolsBuilder.build(user);
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  }

  @Get()
  handleGet(@Res() res: Response) {
    res.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed (stateless server).',
      },
      id: null,
    });
  }

  @Delete()
  handleDelete(@Res() res: Response) {
    res.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed (stateless server).',
      },
      id: null,
    });
  }
}
