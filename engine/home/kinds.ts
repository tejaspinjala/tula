// The built-in config kinds, as a TABLE of data: name -> schema + location (+ optional semantic check).
// Nothing here names a department, team, workflow or provider; those are files in $FLEET_HOME.
import { agentSchema } from '../schema/agent.ts';
import { companySchema } from '../schema/company.ts';
import { connectionSchema } from '../schema/connection.ts';
import { departmentSchema } from '../schema/department.ts';
import { limitsSchema } from '../schema/limits.ts';
import { policySchema } from '../schema/policy.ts';
import { portfolioSchema } from '../schema/portfolio.ts';
import { providersSchema } from '../schema/providers.ts';
import { roleSchema } from '../schema/role.ts';
import { routingSchema } from '../schema/routing.ts';
import { scheduleSchema } from '../schema/schedule.ts';
import { teamSchema } from '../schema/team.ts';
import { workflowSchema } from '../schema/workflow.ts';
import { privateEligibleIssues } from './private-eligible.ts';
import type { KindDef } from './registry.ts';

export const KIND_TABLE: KindDef[] = [
  { kind: 'company', schema: companySchema, file: 'company.json' },
  { kind: 'providers', schema: providersSchema, file: 'org/providers.json', check: (v, { home }) => privateEligibleIssues(home, (v as { providers: never }).providers) },
  { kind: 'routing', schema: routingSchema, file: 'org/routing.json' },
  { kind: 'policy', schema: policySchema, file: 'org/policy.json' },
  { kind: 'limits', schema: limitsSchema, file: 'org/limits.json' },
  { kind: 'portfolio', schema: portfolioSchema, file: 'org/portfolio.json' },
  { kind: 'department', schema: departmentSchema, dir: 'org/departments' },
  { kind: 'team', schema: teamSchema, dir: 'org/teams' },
  { kind: 'role', schema: roleSchema, dir: 'org/roles' },
  { kind: 'agent', schema: agentSchema, dir: 'org/agents' },
  { kind: 'schedule', schema: scheduleSchema, dir: 'org/schedules' },
  { kind: 'workflow', schema: workflowSchema, dir: 'workflows' },
  { kind: 'connection', schema: connectionSchema, dir: 'connections' },
];
