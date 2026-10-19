#!/usr/bin/env bun
// fleet doctor.  bun engine/bin/doctor.ts   (exit 1 on any fail)
import { doctorExitCode, formatChecks, runDoctor } from '../home/doctor.ts';

if (import.meta.main) {
  const checks = await runDoctor();
  console.log(formatChecks(checks));
  process.exit(doctorExitCode(checks));
}
