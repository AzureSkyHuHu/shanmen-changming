import { combatCatalog } from '../../src/content/definitions/index.ts';
import { combatZhCN } from '../../src/content/locales/zh-CN/combat.ts';
import { combatEn } from '../../src/content/locales/en/combat.ts';
import { validateCombatCatalog } from '../../src/content/schemas/validate-combat.ts';

const report = validateCombatCatalog(combatCatalog, { locales: { 'zh-CN': combatZhCN, en: combatEn } });
for (const warning of report.warnings) console.warn(`WARN ${warning.code} ${warning.path}: ${warning.message}`);
for (const error of report.errors) console.error(`ERROR ${error.code} ${error.path}: ${error.message}`);
console.log(JSON.stringify({ valid: report.valid, counts: report.counts }));
if (!report.valid) process.exitCode = 1;
