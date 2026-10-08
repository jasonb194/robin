export async function createAndTrackSecret(input: {
  secretName: string;
  create: () => Promise<number>;
  recordOwnership: () => Promise<void>;
}): Promise<void> {
  const status = await input.create();
  if (status !== 201) throw new Error(`${input.secretName}: GitHub did not create the secret (HTTP ${status}); it was not claimed for cleanup`);
  try {
    await input.recordOwnership();
  } catch {
    throw new Error(`${input.secretName}: database ownership recording failed after HTTP 201; the secret may remain untracked and requires manual cleanup before retrying`);
  }
}

/** Skip an existing reserved secret only when its creation is already recorded by Robin. */
export function skipExistingSecret(secretName: string, repository: string, exists: boolean, isRecorded: boolean): boolean {
  if (!exists) return false;
  if (isRecorded) return true;
  throw new Error(`${repository}: reserved Robin secret ${secretName} already exists without a Robin ownership record; remove or rename it manually before retrying`);
}
