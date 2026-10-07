export const ACCOUNT_SECRET_NAMES = {
  LLM_API_KEY: "ROBIN_ACCOUNT_LLM_API_KEY",
  LLM_BASE_URL: "ROBIN_ACCOUNT_LLM_BASE_URL",
  LLM_MODEL: "ROBIN_ACCOUNT_LLM_MODEL",
  CF_ACCESS_CLIENT_ID: "ROBIN_ACCOUNT_CF_ACCESS_CLIENT_ID",
  CF_ACCESS_CLIENT_SECRET: "ROBIN_ACCOUNT_CF_ACCESS_CLIENT_SECRET",
} as const;

export type AccountSecretKey = keyof typeof ACCOUNT_SECRET_NAMES;

export function accountWorkflowTemplate(template: string): string {
  return template.replace(/\$\{\{\s*secrets\.(LLM_API_KEY|LLM_BASE_URL|LLM_MODEL|CF_ACCESS_CLIENT_ID|CF_ACCESS_CLIENT_SECRET)\s*\}\}/g,
    (_expression, name: AccountSecretKey) => `\${{ secrets.${ACCOUNT_SECRET_NAMES[name]} }}`);
}

export function secretWasCreated(status: number): boolean { return status === 201; }
