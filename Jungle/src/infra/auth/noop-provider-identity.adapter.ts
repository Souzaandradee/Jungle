import { Injectable } from '@nestjs/common';
import { ProviderIdentityPort } from './provider-identity.port';

/** Authentication is intentionally not implemented, as permitted by the challenge README. */
@Injectable()
export class NoopProviderIdentityAdapter implements ProviderIdentityPort {
  async assertProviderIdentity(_providerId: string): Promise<void> {
    // Replace this adapter when connecting an external OIDC Identity Provider.
  }
}
