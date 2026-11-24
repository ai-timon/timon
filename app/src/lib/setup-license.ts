/** Public onboarding errors never display raw server messages or inventories. */
export function setupErrorMessage(error: string | undefined, t: (key: string) => string): string {
  const keys: Record<string, string> = {
    client_upgrade_required: 'clientUpgradeRequired',
    transfer_pending: 'transferPending',
    free_incompatible: 'freeIncompatible',
    license_required: 'licenseRequired',
    license_invalid: 'licenseInvalid',
    not_found: 'licenseInvalid',
    invalid_key: 'licenseInvalid',
    revoked: 'licenseRevoked',
    expired: 'licenseExpired',
    not_active: 'licenseInactive',
    deactivated: 'licenseInactive',
    seat_limit: 'licenseSeatLimit',
    device_mismatch: 'licenseDeviceMismatch',
    license_unavailable: 'licenseUnavailable',
    rate_limited: 'licenseRateLimited',
    'too many attempts, try again later': 'licenseRateLimited',
    setup_in_progress: 'setupInProgress',
    'already set up': 'alreadySetUp',
    user_limit: 'licenseUserLimit',
    build_expired: 'buildExpired',
    setup_token_required: 'setupTokenInvalid',
  };
  return t(`loginPage.${keys[error ?? ''] ?? 'setupFailed'}`);
}
