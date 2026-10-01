import { en } from '../../src/content/locales/en/index.ts';
import { zhCN } from '../../src/content/locales/zh-CN/index.ts';
import { validateLocales } from '../../src/i18n/validation.ts';

const result = validateLocales(zhCN, en);
for (const error of result.errors) {
  console.error(`[${error.locale}] ${error.key}: ${error.code}: ${error.detail}`);
}
if (result.missingEnglishKeys.length > 0) {
  console.info(`Chinese fallback is used for ${result.missingEnglishKeys.length} English key(s): ${result.missingEnglishKeys.join(', ')}`);
}
if (!result.valid) {
  process.exitCode = 1;
} else {
  console.info(`Locale validation passed: ${result.checkedKeys} complete Chinese keys; all translated parameter names and types follow the shared schema.`);
}
