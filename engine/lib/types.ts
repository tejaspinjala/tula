// Shared shapes for the JSON config files under engine/.
export type Tier = 'cheap' | 'mid' | 'deep';

export interface OrgNode {
  id: string;
  name: string;
  title: string;
  level: number;
  tier: Tier;
  parent: string | null;
  room?: string;
  desc: string;
  tools: string[];
  role: string;
  maxTurns?: number;
}

export interface Org {
  company: string;
  _doc?: string;
  nodes: OrgNode[];
}

export interface RouteDefaults {
  employee: string;
  skills: string[];
  maxTurns: number;
}

export interface RouteRule {
  id: string;
  employee?: string;
  tier?: Tier;
  skills?: string[];
  maxTurns?: number;
  /** this rule means 'convene the decision council' (data, so the router names no rule) */
  council?: boolean;
  match: string[];
}

export interface Routes {
  _doc?: string;
  defaults: RouteDefaults;
  escalate: { files: number };
  rules: RouteRule[];
}

export type TierModels = Partial<Record<Tier, string>> & Record<string, string | undefined>;

export interface Providers {
  _doc?: string;
  active: string;
  providers: Record<string, TierModels>;
}
