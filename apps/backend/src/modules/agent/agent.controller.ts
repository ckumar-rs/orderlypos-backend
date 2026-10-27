import { Body, Controller, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { SessionUser } from '@nodedr-restaurant/types';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AgentService } from './agent.service';
import type { AgentScope } from './agent-plan';

@ApiTags('agent')
@Controller('v1/agent')
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  @Auth()
  @Post('ask')
  ask(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId: string,
    @Body() body: { question?: string; scope?: string },
  ) {
    const scope: AgentScope = body?.scope === 'restaurant' ? 'restaurant' : 'branch';
    return this.agent.ask(user, branchId, body?.question ?? '', scope);
  }
}
