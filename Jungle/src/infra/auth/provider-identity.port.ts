/** Extension point for an external Identity Provider integration. */
export interface ProviderIdentityPort {
  assertProviderIdentity(providerId: string): Promise<void>;
}

export const PROVIDER_IDENTITY_PORT = Symbol('PROVIDER_IDENTITY_PORT');
