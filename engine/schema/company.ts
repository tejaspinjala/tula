// Company (config kind `company`, `$FLEET_HOME/company.json`; SPEC 5). A singleton: its ConfigVersion id is
// "company". The engine boots with only this file present (empty company, SPEC 26.1).
import { z } from 'zod';
import { autonomy } from './common.ts';

export const companySchema = z.strictObject({
  name: z.string().min(1).max(80),
  ownerName: z.string().min(1).max(80),
  legalEntity: z.string().min(1).max(120).optional().describe('entity that pays for real spends (data, not code)'),
  currency: z.literal('USD'),
  timezone: z.string().min(1).describe('IANA time zone'),
  moneyMode: z.enum(['paper', 'card']),
  autonomyMax: autonomy.describe('company-wide ceiling; departments and teams are capped at it'),
  killSwitch: z.boolean().optional().describe('mirror of the STOP state for display; the STOP file stays authoritative'),
});
export type Company = z.infer<typeof companySchema>;
